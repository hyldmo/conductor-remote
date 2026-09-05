import { discardStagedAttachment, stageAttachment } from '../../files/staged-attachments.ts'
import {
	isManaged,
	LOG_FILE_NAMES,
	logFiles,
	processStartedAt,
	recentLogs,
	redactSecrets,
	tailLogFile
} from '../../host/logbuf.ts'
import { armNoSleep, disarmNoSleep, MAX_SECONDS as NOSLEEP_MAX_SECONDS, nosleepState } from '../../host/nosleep.ts'
import { autoJoinHotspotMode, currentSsid, looksLikeHotspot, preferredNetworks } from '../../host/wifi.ts'
import { notifyDevice, pushConfig, subscribeDevice, unsubscribeDevice } from '../../notifications/notify.ts'
import { readPrefs, writePrefs } from '../../prefs.ts'
import { isRoute, routeParam, routes } from '../../routes.ts'
import { readSettings, writeSettings } from '../../settings.ts'
import { screenLocked } from '../../writes/guards.ts'
import { restartConductorApp } from '../../writes/system.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createSystemRoutes(
	services: Pick<
		RelayServices,
		'json' | 'readBody' | 'cfg' | 'reads' | 'attachmentHeaderName' | 'readAttachmentBody' | 'STAGED_ATTACHMENTS_DIR'
	>
): RouteHandler {
	const { json, readBody, cfg, reads, attachmentHeaderName, readAttachmentBody, STAGED_ATTACHMENTS_DIR } = services
	return async (req, res, url) => {
		const { pathname } = url

		// GET /api/settings — relay preferences plus what the phone needs to edit them:
		// the SSIDs this Mac already holds credentials for, so the picker offers a choice
		// instead of asking someone to type a network name from memory on a phone keyboard.
		// `ssid` is best-effort and often null (macOS gates it behind Location Services).
		if (isRoute(routes.settings, req.method, pathname)) {
			// Five subprocesses, all concurrent: this is the one route that shells out more
			// than once, and serialising them would put the phone's polls behind the sum.
			const [known, current, autoJoinHotspot, nosleep, locked] = await Promise.all([
				preferredNetworks(),
				currentSsid(),
				// macOS's own Auto-join Hotspot setting. On "Never" the Mac won't reach for
				// your phone unprompted, which no amount of relay code can substitute for.
				autoJoinHotspotMode(),
				nosleepState(),
				// Read here rather than polled: this sheet is where someone goes when the Mac
				// stopped answering, and a keep-awake window that says "automatic screen lock
				// is off" beside a Mac that is locked right now reads as the relay lying. The
				// assertion blocks the *idle* lock; it cannot lift one already up, and a lid
				// close or a manual lock puts one up whatever it holds.
				screenLocked()
			])
			return json(req, res, 200, {
				settings: readSettings(),
				wifi: {
					current,
					known,
					// A guess from the name, never a fact — see src/host/wifi.ts. It only sorts the picker.
					likelyHotspots: known.filter(looksLikeHotspot),
					autoJoinHotspot
				},
				nosleep: { ...nosleep, maxSeconds: NOSLEEP_MAX_SECONDS },
				screenLocked: locked
			})
		}

		// PATCH /api/settings { fallbackSsids?, autoRejoin? } — merge and persist.
		if (isRoute(routes.updateSettings, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { fallbackSsids?: unknown; autoRejoin?: unknown }
			const patch: Parameters<typeof writeSettings>[0] = {}
			if (Array.isArray(body.fallbackSsids)) patch.fallbackSsids = body.fallbackSsids as string[]
			if (typeof body.autoRejoin === 'boolean') patch.autoRejoin = body.autoRejoin
			if (Object.keys(patch).length === 0) return json(req, res, 400, { error: 'nothing to change' })
			return json(req, res, 200, { settings: writeSettings(patch) })
		}

		// PWA state remains local-first; this host copy survives origin changes and
		// reconciles phones. PATCH accepts a full client snapshot and merges per key.
		if (isRoute(routes.prefs, req.method, pathname)) {
			return json(req, res, 200, { prefs: readPrefs() })
		}

		if (isRoute(routes.updatePrefs, req.method, pathname)) {
			const raw = JSON.parse((await readBody(req)) || '{}') as unknown
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				return json(req, res, 400, { error: 'preferences must be an object' })
			}
			const body = raw as Record<string, unknown>
			if (!Object.hasOwn(body, 'readMarks') && !Object.hasOwn(body, 'drafts')) {
				return json(req, res, 400, { error: 'nothing to sync' })
			}
			return json(req, res, 200, { prefs: writePrefs(body) })
		}

		// GET /api/nosleep — is the Mac being held awake, and can this relay do it at all
		if (isRoute(routes.nosleep, req.method, pathname)) {
			return json(req, res, 200, { ...(await nosleepState()), maxSeconds: NOSLEEP_MAX_SECONDS })
		}

		// POST /api/nosleep { seconds } — hold this Mac awake, lid closed, for a bounded window.
		// Only works once `conductor-remote nosleep setup` has installed the scoped sudoers
		// rule; without it there is no way for a TTY-less daemon to reach root, and the
		// response says so rather than failing vaguely.
		if (isRoute(routes.armNoSleep, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { seconds?: number }
			const seconds = Number(body.seconds)
			// Whole seconds, not just "> 0": the helper reads 0 as "until killed", and 0.4
			// truncates to 0 — an unbounded window from a request that looked bounded.
			if (!Number.isInteger(seconds) || seconds < 1)
				return json(req, res, 400, { error: 'need a whole number of seconds >= 1' })
			const result = await armNoSleep(seconds, cfg.preventScreenLock)
			return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
		}

		// DELETE /api/nosleep — let it sleep again now, rather than at the window's end
		if (isRoute(routes.disarmNoSleep, req.method, pathname)) {
			const result = await disarmNoSleep()
			return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
		}

		// POST /api/conductor/restart { stopAgents? } — quit Conductor and start it again.
		//
		// The lever exists in the actuator already, but only as activateConductor's last
		// resort, which fires exclusively for a *windowless* Conductor. This is for the
		// other shape: window up, prompts landing as rows, and no agent output behind any
		// of it (measured 2026-09-02 — 2h35m of user rows after the last agent frame).
		// The running agents are counted from the DB before the UI is touched and refused
		// unless the caller meant it, the same way archiving is: quitting ends every turn
		// in flight. The lock screen is the actuator's own gate, since only it can ask.
		if (isRoute(routes.restartConductor, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { stopAgents?: boolean }
			const working = reads.listSessionStates().filter(state => state.status === 'working').length
			if (working > 0 && body.stopAgents !== true) {
				return json(req, res, 409, {
					ok: false,
					agentsRunning: true,
					working,
					error: `${working} chat${working === 1 ? ' is' : 's are'} mid-turn. Restarting Conductor ends ${working === 1 ? 'it' : 'them'}.`
				})
			}
			const startedAt = Date.now()
			const result = await restartConductorApp()
			const ms = Date.now() - startedAt
			if (!result.ok) {
				console.warn(`[restart] Conductor restart failed after ${(ms / 1000).toFixed(1)}s: ${result.error}`)
				return json(req, res, 502, { ok: false, ms, error: result.error })
			}
			console.log(`[restart] quit Conductor and relaunched it in ${(ms / 1000).toFixed(1)}s`)
			return json(req, res, 200, { ok: true, ms })
		}

		// GET /api/logs?file=&limit= — the relay's own log, so a phone can diagnose a failed send
		// without reaching the Mac. Default is this process's captured console (ordered, timestamped);
		// `file` tails the daemon's stdout/stderr on disk, which is the only place the *previous*
		// process's crash survives. Everything is redacted: the startup banner prints the token.
		if (isRoute(routes.logs, req.method, pathname)) {
			const file = url.searchParams.get('file')
			if (file && !(LOG_FILE_NAMES as readonly string[]).includes(file)) {
				return json(req, res, 404, { error: `unknown log file ${file}`, files: LOG_FILE_NAMES })
			}
			const asked = Number(url.searchParams.get('limit') ?? 300)
			const limit = Number.isFinite(asked) ? Math.min(2000, Math.max(1, Math.trunc(asked))) : 300
			let entries: ReturnType<typeof recentLogs>
			try {
				entries = file ? tailLogFile(file, limit) : recentLogs(limit)
			} catch (err) {
				// The file only exists once the LaunchAgent has run; say so instead of a bare 500.
				return json(req, res, 404, { error: `can’t read ${file}: ${err instanceof Error ? err.message : err}` })
			}
			return json(req, res, 200, {
				source: file ?? 'live',
				// False → the files below are some *other* (daemon) process's output, not this relay's.
				managed: isManaged(),
				startedAt: processStartedAt(),
				now: Date.now(),
				files: logFiles(),
				entries: entries.map(e => ({ ...e, text: redactSecrets(e.text, cfg.token) }))
			})
		}

		// GET /api/push — the VAPID public key the phone subscribes with, plus who's already subscribed
		if (isRoute(routes.push, req.method, pathname)) {
			return json(req, res, 200, pushConfig())
		}

		// POST /api/push/subscribe { subscription, label? } — register (or refresh) this device.
		// Idempotent by endpoint: the app re-sends on every load, which is what heals a relay that
		// lost its store, or a subscription the browser silently renewed.
		if (isRoute(routes.pushSubscribe, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as {
				subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
				label?: string
			}
			const sub = body.subscription
			if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) {
				return json(req, res, 400, { error: 'need a subscription with endpoint and keys' })
			}
			// An endpoint is a URL we will POST to — never accept a non-HTTPS one.
			if (!/^https:\/\//i.test(sub.endpoint)) return json(req, res, 400, { error: 'endpoint must be https' })
			const registered = subscribeDevice(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
				(body.label ?? '').slice(0, 64)
			)
			return json(req, res, 200, { ok: true, ...registered })
		}

		// POST /api/push/unsubscribe { endpoint } — the phone turned notifications off
		if (isRoute(routes.pushUnsubscribe, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { endpoint?: string }
			if (!body.endpoint) return json(req, res, 400, { error: 'need the endpoint' })
			return json(req, res, 200, { ok: unsubscribeDevice(body.endpoint), devices: pushConfig().devices })
		}

		// POST /api/push/test { id } — push to one device, so "is this actually wired up?" has an answer
		if (isRoute(routes.pushTest, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { id?: string }
			if (!body.id) return json(req, res, 400, { error: 'need the device id' })
			const result = await notifyDevice(body.id, {
				title: 'Conductor Remote',
				body: 'Notifications are working. You’ll get one when an agent finishes.',
				tag: 'test',
				url: '/',
				kind: 'test',
				ts: Date.now()
			})
			return json(req, res, result.ok ? 200 : 502, result)
		}

		// POST /api/attachments — hold one phone file until its new workspace has a worktree.
		if (isRoute(routes.stageAttachment, req.method, pathname)) {
			const name = attachmentHeaderName(req)
			if (!name) return json(req, res, 400, { error: 'missing attachment name' })
			const bytes = await readAttachmentBody(req)
			if (!bytes.length) return json(req, res, 400, { error: 'empty attachment' })
			const attachment = stageAttachment(STAGED_ATTACHMENTS_DIR, name, bytes)
			return json(req, res, 201, { ok: true, attachment })
		}

		// DELETE /api/attachments/:id — an upload cancelled before it became a synced draft attachment.
		const stagedAttachment = routeParam(routes.discardStagedAttachment, req.method, pathname)

		if (stagedAttachment)
			return json(req, res, discardStagedAttachment(STAGED_ATTACHMENTS_DIR, stagedAttachment) ? 200 : 404, {
				ok: true
			})
		return NOT_HANDLED
	}
}
