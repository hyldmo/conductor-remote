import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { startAutoUpdate, updateStatus } from './autoupdate.ts'
import { loadConfig, stateDir } from './config.ts'
import { ConductorDb } from './db.ts'
import { FirstPromptQueue } from './firstprompt.ts'
import { startFunnelWatchdog } from './funnel-watchdog.ts'
import { workspaceDiff } from './git.ts'
import {
	installLogCapture,
	isManaged,
	LOG_FILE_NAMES,
	logFiles,
	processStartedAt,
	recentLogs,
	redactSecrets,
	tailLogFile
} from './logbuf.ts'
import { mergePr } from './merge.ts'
import {
	armNoSleep,
	disarmNoSleep,
	MAX_SECONDS as NOSLEEP_MAX_SECONDS,
	nosleepState,
	watchNoSleepExpiry
} from './nosleep.ts'
import { notifyAll, notifyDevice, pushConfig, startNotifier, subscribeDevice, unsubscribeDevice } from './notify.ts'
import { type ParkedAgentPatch, type ParkedPrompt, ParkedPromptQueue } from './parked.ts'
import { attachPrStatus } from './pr.ts'
import { Reads, type SessionRow, type Workspace } from './reads.ts'
import { readSettings, writeSettings } from './settings.ts'
import { driftWarningLines, tailscaleBin } from './tailscale.ts'
import { autoJoinHotspotMode, currentSsid, looksLikeHotspot, preferredNetworks } from './wifi.ts'
import {
	type AgentOptions,
	type ChatTab,
	createWorkspace,
	describeActuator,
	EFFORT_LABELS,
	listAgentModels,
	lockBlocked,
	newChat,
	pickActuator,
	retryWontHelp,
	type SendResult,
	screenLocked,
	setAgentOptions,
	setRestartGuard,
	setWorkspaceStatus,
	WORKSPACE_STATUS_LABELS
} from './writes.ts'

// Before anything that logs: from here on every console line is also kept in memory for
// `GET /api/logs`, so the phone can read why a send failed without ssh-ing into the Mac.
installLogCapture()

const cfg = loadConfig()
const db = new ConductorDb(cfg.dbPath)
const reads = new Reads(db, cfg.workspacesRoot)
const actuator = pickActuator(cfg.writeStrategy)

// A windowless Conductor that ignores reopen *and* a Dock click can only be fixed
// by restarting it — and quitting takes any agent mid-turn down with it. So the
// write path may only do that while nothing is working, which is a DB fact, not
// something AppleScript can see. Read fresh each time: a session can start between
// the phone opening the app and the send landing.
setRestartGuard(() => !reads.listWorkspaces().some(w => w.session_status === 'working'))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Has the prompt shown up as a user row yet? The receipt everything below is built
 * on. The AppleScript actuator reports `ok` on `osascript` exit 0 — which only
 * means the script *ran*, not that Conductor accepted the keystrokes — so without
 * this a dropped send (asleep/unfocused Mac) looks delivered. A queued prompt still
 * writes a user row, so it counts as delivered.
 */
function deliveredSince(sessionId: string, text: string, sinceRowid: number): boolean {
	const target = text.trim()
	const { entries } = reads.getMessages(sessionId, sinceRowid)
	return entries.some(e => e.role === 'user' && e.text.trim() === target)
}

/**
 * Watch for that row, ending on a check rather than a sleep, and never past
 * `budgetDeadline`. Conductor writes the row right after the send presses Enter, so
 * a real send is confirmed in a tick and only the failure path waits the window out.
 *
 * The window is *also* what makes a retry safe — it is deliberately longer than the
 * row takes to appear, because everything past it is allowed to type into the
 * composer again — so note which end of the budget gets clipped when the two
 * compete: a retry only happens with `MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS` left, so
 * a confirm *followed by another attempt* always gets its full window. Only the
 * last confirm of all can be cut short, and nothing follows it to duplicate a row.
 */
async function confirmDelivery(
	sessionId: string,
	text: string,
	sinceRowid: number,
	budgetDeadline: number
): Promise<boolean> {
	const stopAt = Math.min(Date.now() + CONFIRM_WINDOW_MS, budgetDeadline)
	for (;;) {
		if (deliveredSince(sessionId, text, sinceRowid)) return true
		if (Date.now() >= stopAt) return false
		await sleep(300)
	}
}

/** How long we watch the transcript after a run before deciding it didn't land. */
const CONFIRM_WINDOW_MS = 6_000
/** Ceiling on a whole send, retries included — no phone should hold a request open longer. */
const SEND_BUDGET_MS = 55_000
/** Below this there isn't room for a run that could plausibly succeed, so don't start one. */
const MIN_ATTEMPT_MS = 12_000
/**
 * The least a confirm is worth doing at all. Held back from every run so a send that
 * lands can be *seen* to have landed — an unconfirmed send is indistinguishable from
 * a lost one, which is the failure this whole path exists to avoid.
 */
const MIN_CONFIRM_MS = 2_000
/** Leaves the response itself time to get home before the caller's own timer fires. */
const RESPONSE_MARGIN_MS = 5_000
/**
 * Budget for a caller that didn't say how long it would wait — a PWA build from
 * before `x-client-timeout-ms`, which aborted a send at a flat 25s. Sized so that
 * such a phone is no worse off than it was: one run with a ceiling like the old one,
 * and no retry (there was never room for a retry inside 25s).
 */
const LEGACY_SEND_BUDGET_MS = 20_000

/**
 * Never outlast the caller. The relay giving up *after* the phone has is the worst
 * available outcome: the phone shows a failure while the send goes on to land, and
 * the user can't tell that from a send that really didn't. Pairing our budget to
 * the PWA's by hand wouldn't hold — the relay updates itself (autoupdate.ts) while
 * the app sits in a service-worker cache — so the caller states its own deadline
 * and we retry inside it.
 */
function sendBudget(req: http.IncomingMessage): number {
	const asked = Number(req.headers['x-client-timeout-ms'])
	if (!Number.isFinite(asked) || asked <= 0) return LEGACY_SEND_BUDGET_MS
	// Floor at one confirmable attempt: a caller in a hurry still gets a real try.
	return Math.max(MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS, Math.min(SEND_BUDGET_MS, asked - RESPONSE_MARGIN_MS))
}

/**
 * Where a chat sits in Conductor's tab strip. Both write paths need it: the
 * actuator selects that tab before touching anything, otherwise it acts on
 * whichever tab happens to be active.
 */
function locateChat(
	ws: Workspace,
	sessionId: string
): { tab: ChatTab | undefined; session: SessionRow | undefined } | { error: string } {
	const sessions = reads.listSessions(ws.id)
	const index = sessions.findIndex(s => s.id === sessionId)
	if (index < 0 && sessions.length > 1) return { error: 'chat is no longer one of the workspace’s tabs' }
	if (index < 0) return { tab: undefined, session: undefined }
	return {
		tab: { index: index + 1, count: sessions.length, title: sessions[index].title ?? '' },
		session: sessions[index]
	}
}

/** Poll the DB until Conductor records the setting we just drove through the UI. */
async function confirmAgentOptions(ws: Workspace, sessionId: string, opts: AgentOptions): Promise<boolean> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const s = reads.listSessions(ws.id).find(row => row.id === sessionId)
		const effortOk = !opts.effort || s?.claude_effort_level === opts.effort
		const planOk = opts.plan === undefined || s?.permission_mode === (opts.plan ? 'plan' : 'default')
		if (effortOk && planOk) return true
		await sleep(300)
	}
	return false
}

/**
 * Deliver a prompt to one chat and confirm it landed, retrying until the caller's
 * budget runs out. The single write path: the phone's own sends go through it, and so
 * does the first-prompt queue, so both get the same targeting, the same read-back,
 * the same retries and the same errors.
 *
 * Retrying here rather than handing the phone a Retry button is the point: the
 * failures this path hits are overwhelmingly warm-up costs — a cold or busy Conductor
 * makes the first AppleScript run slow enough to be killed, and the second finds an
 * activated app and lands — which is exactly why tapping Retry always worked. Two
 * things make doing it automatically safe rather than a way to send a prompt twice:
 *  - **The transcript is the receipt.** Every run is followed by a full
 *    `CONFIRM_WINDOW_MS` of watching for the matching user row, *including* runs that
 *    reported an error, and the last of those checks is the moment before we type
 *    again. A run that actually landed — even one killed just after pressing Enter,
 *    or one whose row appeared after we'd stopped looking — is reported as delivered.
 *  - **The composer is written, not appended to** (`fillComposer` sets AXValue), so a
 *    retry replaces a half-finished attempt's text instead of doubling it.
 *
 * Bounded by a wall clock rather than an attempt count, because someone is holding
 * this request open: runs are bounded by the caller's deadline, and we stop rather
 * than start one the budget could not also confirm. The queue's own 3-sends-over-15-
 * minutes schedule sits *outside* this and is unaffected — it retries a delivery that
 * never got off the ground (worktree still setting up), not one Conductor fumbled.
 */
async function deliverPrompt(
	ws: Workspace,
	sessionId: string,
	text: string,
	budgetMs = SEND_BUDGET_MS
): Promise<SendResult & { attempts: number }> {
	const located = locateChat(ws, sessionId)
	if ('error' in located) return { ok: false, strategy: actuator.name, attempts: 0, error: located.error }
	// Snapshot the cursor once: every check below asks "did *this* prompt arrive since
	// we started", so a retry can't be fooled by an older identical prompt.
	const beforeRowid = reads.getMessages(sessionId).cursor
	const label = ws.branch ?? ws.id
	const deadline = Date.now() + budgetMs
	let attempts = 0
	let last: SendResult = { ok: false, strategy: actuator.name }
	for (;;) {
		attempts++
		// The run gets the deadline, not a duration: `uiTurn` may hold it behind another
		// write, and only the run knows what was left of the budget when it started. Minus
		// the confirm, so a caller on a tight budget spends it on the run rather than on
		// watching — a 25s-era phone gets one full-length attempt, not two too short to finish.
		last = await actuator.send({ workspace: ws, sessionId, tab: located.tab }, text, deadline - MIN_CONFIRM_MS)
		if (await confirmDelivery(sessionId, text, beforeRowid, deadline)) {
			if (attempts > 1) console.info(`[relay] send to ${label} landed on attempt ${attempts}`)
			return { ok: true, strategy: last.strategy, attempts }
		}
		if (retryWontHelp(last.error)) break
		// A locked screen isn't worth the rest of the budget either — but for the
		// opposite reason: the parked-prompt queue (src/parked.ts) waits it out far
		// past any deadline a phone could hold open, so hand it over at once.
		if (lockBlocked(last.error)) break
		if (deadline - Date.now() < MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS) break
		// The phone only ever sees the outcome; why a send goes missing lives on this
		// side, so leave the trail in relay.log rather than nothing at all.
		console.warn(
			`[relay] send to ${label} attempt ${attempts} didn’t land (${last.error ?? 'no user row appeared'}) — retrying`
		)
	}
	const tried = attempts > 1 ? ` (tried ${attempts}×)` : ''
	const error = last.ok
		? `Send didn’t land in the chat — Conductor may have been asleep or unfocused${tried}. Try again.`
		: `${last.error}${tried}`
	console.warn(`[relay] send to ${label} failed after ${attempts} attempt(s): ${error}`)
	return { ok: false, strategy: last.strategy, attempts, error }
}

/**
 * Undelivered first prompts, owned by this process rather than by the phone (see
 * firstprompt.ts for why). Everything Conductor-side it needs is a plain DB read.
 */
const firstPrompts = new FirstPromptQueue(path.join(stateDir(), 'first-prompts.json'), {
	inspect: workspaceId => {
		const ws = reads.getWorkspace(workspaceId)
		if (!ws) return null
		// A new workspace is 'setting_up' while its worktree (and setup script) runs;
		// its composer isn't the visible pane yet, so wait for 'ready' before typing.
		const sessions = reads.listSessions(workspaceId)
		const session = sessions.find(s => s.id === ws.active_session_id) ?? sessions[0]
		return {
			ready: ws.state === 'ready',
			sessionId: session?.id ?? null,
			alreadySent: !!session?.last_user_message_at
		}
	},
	send: async (workspaceId, sessionId, text) => {
		const ws = reads.getWorkspace(workspaceId)
		if (!ws) return { ok: false, error: 'the workspace is gone' }
		const result = await deliverPrompt(ws, sessionId, text)
		return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
	},
	// A locked Mac holds first prompts whole — no attempts spent, no aging — instead
	// of burning all three sends into a lock screen nobody is there to see.
	gate: async () => (await screenLocked()) !== true
})

/**
 * Apply staged agent settings to a chat — the shared half of `POST …/agent` and
 * of a send that carries a patch. The `fast` translation lives here because the
 * UI button only *toggles*: the DB says whether the press is needed at all.
 */
async function applyAgentPatch(
	ws: Workspace,
	sessionId: string,
	patch: ParkedAgentPatch
): Promise<{ ok: boolean; error?: string }> {
	const located = locateChat(ws, sessionId)
	if ('error' in located) return { ok: false, error: located.error }
	const opts: AgentOptions = {
		effort: patch.effort,
		plan: patch.plan,
		model: patch.model,
		toggleFast: patch.fast === undefined ? false : patch.fast !== Boolean(located.session?.fast_mode)
	}
	const result = await setAgentOptions({ workspace: ws, sessionId, tab: located.tab }, opts)
	if (!result.ok) return { ok: false, error: result.error }
	if (!(await confirmAgentOptions(ws, sessionId, opts))) {
		return { ok: false, error: 'Conductor didn’t record the change — it may have been asleep. Try again.' }
	}
	return { ok: true }
}

/** What the phone is told when its prompt is parked instead of failed. */
const PARKED_ERROR = 'The Mac is locked — the relay parked the prompt and will send it when the Mac is unlocked.'

/**
 * Prompts that hit the lock screen, owned by this process until the Mac unlocks
 * (see parked.ts for why the phone can't wait this out itself).
 */
const parkedPrompts = new ParkedPromptQueue(path.join(stateDir(), 'parked-prompts.json'), {
	locked: screenLocked,
	deliver: async entry => {
		const ws = reads.getWorkspace(entry.workspaceId)
		if (!ws) return { ok: false, error: 'the workspace is gone' }
		// Settings first, prompt only if they stuck — the same order and the same
		// fail-closed rule as the phone's own send (running the prompt on the model
		// the user moved away from is the mistake this exists to prevent). A re-run
		// after a failed prompt re-applies harmlessly: every control is read before
		// it is pressed, so an already-correct value presses nothing.
		if (entry.agent) {
			const applied = await applyAgentPatch(ws, entry.sessionId, entry.agent)
			if (!applied.ok) return { ok: false, error: applied.error, blocked: lockBlocked(applied.error) }
		}
		const result = await deliverPrompt(ws, entry.sessionId, entry.text)
		return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
	},
	notify: (entry: ParkedPrompt, error?: string) => {
		const ws = reads.getWorkspace(entry.workspaceId)
		const title = ws?.workspace_name ?? ws?.pr_title ?? ws?.branch ?? 'Conductor'
		const preview = entry.text.length > 140 ? `${entry.text.slice(0, 140).trimEnd()}…` : entry.text
		void notifyAll({
			title,
			body: error ? `Parked prompt failed: ${error}` : `Sent after unlock: ${preview}`,
			// Per chat, so a second parked prompt replaces the first's notification.
			tag: `parked-${entry.sessionId}`,
			url: `/w/${entry.workspaceId}`,
			kind: error ? 'error' : 'done',
			ts: Date.now()
		})
	}
})

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png'
}

/**
 * Successful GETs are conditional + compressed to keep the phone's polling cheap.
 * `no-cache` (not `no-store`) means the browser must revalidate on every tick —
 * the relay still runs the handler and auth each time, so data is never stale;
 * a matching ETag just elides the redundant body (304), and changed bodies over
 * ~1 KB go out gzipped. Errors and non-GETs stay unconditional `no-store`.
 */
function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
	const payload = Buffer.from(JSON.stringify(body))
	if (status !== 200 || req.method !== 'GET') {
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
		return void res.end(payload)
	}
	// Weak: the same entity may be delivered gzipped or plain.
	const etag = `W/"${crypto.createHash('sha1').update(payload).digest('base64url')}"`
	const headers: http.OutgoingHttpHeaders = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-cache',
		etag,
		vary: 'accept-encoding'
	}
	if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end()
	if (payload.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
		headers['content-encoding'] = 'gzip'
		return void res.writeHead(200, headers).end(zlib.gzipSync(payload))
	}
	res.writeHead(200, headers).end(payload)
}

/** Constant-time string compare — the token is the sole internet-facing gate when exposed via Funnel. */
function tokenEq(candidate: string | null): boolean {
	if (candidate == null) return false
	const a = Buffer.from(candidate)
	const b = Buffer.from(cfg.token)
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function authed(req: http.IncomingMessage): boolean {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return tokenEq(auth.slice('Bearer '.length))
	const url = new URL(req.url ?? '/', 'http://x')
	return tokenEq(url.searchParams.get('token'))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const c of req) chunks.push(c as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

/** Hashed Vite assets are immutable and cache-forever; the shell/SW must never go stale. */
function cacheControl(rel: string): string {
	if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'
	return 'no-cache'
}

function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
	const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
	const filePath = path.resolve(cfg.publicDir, rel)
	// Contain to publicDir. The URL parser already collapses `..`/`%2e%2e` dot-segments, but don't lean on
	// that: reject anything that resolves outside the dir (a bare `startsWith` would also admit a sibling
	// like `dist-node/`). An empty relative (filePath === publicDir) falls through to the SPA shell below.
	const within = path.relative(cfg.publicDir, filePath)
	if (within.startsWith('..') || path.isAbsolute(within)) {
		res.writeHead(403).end()
		return
	}
	fs.readFile(filePath, (err, data) => {
		if (err) {
			// SPA fallback to shell.
			fs.readFile(path.join(cfg.publicDir, 'index.html'), (e2, shell) => {
				if (e2) return void res.writeHead(404).end('not found')
				res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
				res.end(shell)
			})
			return
		}
		const ext = path.extname(filePath)
		res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cacheControl(rel) })
		res.end(data)
	})
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x')
	const { pathname } = url

	if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname)

	// Everything under /api requires the shared secret.
	if (!authed(req)) return json(req, res, 401, { error: 'unauthorized' })

	try {
		// GET /api/state — workspace list with active-session status
		if (req.method === 'GET' && pathname === '/api/state') {
			const update = updateStatus()
			const workspaces = reads.listWorkspaces()
			attachPrStatus(workspaces) // colours pr_status from cache; refreshes stale entries in the background
			// An undelivered first prompt rides along with its workspace: the phone renders it
			// in that chat rather than tracking delivery itself (see src/firstprompt.ts).
			// Prompts parked for the lock screen ride the same way, one list per workspace,
			// each entry naming its chat (src/parked.ts).
			const parked = parkedPrompts.list()
			for (const ws of workspaces) {
				ws.pending_prompt = firstPrompts.get(ws.id)
				const mine = parked.filter(p => p.workspaceId === ws.id)
				if (mine.length) ws.parked_prompts = mine
			}
			return json(req, res, 200, {
				workspaces,
				actuator: await describeActuator(actuator),
				version: update.current,
				update
			})
		}

		// GET /api/repos — repos a new workspace can be created in
		if (req.method === 'GET' && pathname === '/api/repos') {
			return json(req, res, 200, { repos: reads.listRepos() })
		}

		// GET /api/settings — relay preferences plus what the phone needs to edit them:
		// the SSIDs this Mac already holds credentials for, so the picker offers a choice
		// instead of asking someone to type a network name from memory on a phone keyboard.
		// `ssid` is best-effort and often null (macOS gates it behind Location Services).
		if (req.method === 'GET' && pathname === '/api/settings') {
			// Four subprocesses, all concurrent: this is the one route that shells out more
			// than once, and serialising them would put the phone's polls behind the sum.
			const [known, current, autoJoinHotspot, nosleep] = await Promise.all([
				preferredNetworks(),
				currentSsid(),
				// macOS's own Auto-join Hotspot setting. On "Never" the Mac won't reach for
				// your phone unprompted, which no amount of relay code can substitute for.
				autoJoinHotspotMode(),
				nosleepState()
			])
			return json(req, res, 200, {
				settings: readSettings(),
				wifi: {
					current,
					known,
					// A guess from the name, never a fact — see wifi.ts. It only sorts the picker.
					likelyHotspots: known.filter(looksLikeHotspot),
					autoJoinHotspot
				},
				nosleep: { ...nosleep, maxSeconds: NOSLEEP_MAX_SECONDS }
			})
		}

		// PATCH /api/settings { fallbackSsids?, autoRejoin? } — merge and persist.
		if (req.method === 'PATCH' && pathname === '/api/settings') {
			const body = JSON.parse((await readBody(req)) || '{}') as { fallbackSsids?: unknown; autoRejoin?: unknown }
			const patch: Parameters<typeof writeSettings>[0] = {}
			if (Array.isArray(body.fallbackSsids)) patch.fallbackSsids = body.fallbackSsids as string[]
			if (typeof body.autoRejoin === 'boolean') patch.autoRejoin = body.autoRejoin
			if (Object.keys(patch).length === 0) return json(req, res, 400, { error: 'nothing to change' })
			return json(req, res, 200, { settings: writeSettings(patch) })
		}

		// GET /api/nosleep — is the Mac being held awake, and can this relay do it at all
		if (req.method === 'GET' && pathname === '/api/nosleep') {
			return json(req, res, 200, { ...(await nosleepState()), maxSeconds: NOSLEEP_MAX_SECONDS })
		}

		// POST /api/nosleep { seconds } — hold this Mac awake, lid closed, for a bounded window.
		// Only works once `conductor-remote nosleep setup` has installed the scoped sudoers
		// rule; without it there is no way for a TTY-less daemon to reach root, and the
		// response says so rather than failing vaguely.
		if (req.method === 'POST' && pathname === '/api/nosleep') {
			const body = JSON.parse((await readBody(req)) || '{}') as { seconds?: number }
			const seconds = Number(body.seconds)
			// Whole seconds, not just "> 0": the helper reads 0 as "until killed", and 0.4
			// truncates to 0 — an unbounded window from a request that looked bounded.
			if (!Number.isInteger(seconds) || seconds < 1)
				return json(req, res, 400, { error: 'need a whole number of seconds >= 1' })
			const result = await armNoSleep(seconds)
			return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
		}

		// DELETE /api/nosleep — let it sleep again now, rather than at the window's end
		if (req.method === 'DELETE' && pathname === '/api/nosleep') {
			const result = await disarmNoSleep()
			return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
		}

		// GET /api/logs?file=&limit= — the relay's own log, so a phone can diagnose a failed send
		// without reaching the Mac. Default is this process's captured console (ordered, timestamped);
		// `file` tails the daemon's stdout/stderr on disk, which is the only place the *previous*
		// process's crash survives. Everything is redacted: the startup banner prints the token.
		if (req.method === 'GET' && pathname === '/api/logs') {
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
		if (req.method === 'GET' && pathname === '/api/push') {
			return json(req, res, 200, pushConfig())
		}

		// POST /api/push/subscribe { subscription, label? } — register (or refresh) this device.
		// Idempotent by endpoint: the app re-sends on every load, which is what heals a relay that
		// lost its store, or a subscription the browser silently renewed.
		if (req.method === 'POST' && pathname === '/api/push/subscribe') {
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
		if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
			const body = JSON.parse((await readBody(req)) || '{}') as { endpoint?: string }
			if (!body.endpoint) return json(req, res, 400, { error: 'need the endpoint' })
			return json(req, res, 200, { ok: unsubscribeDevice(body.endpoint), devices: pushConfig().devices })
		}

		// POST /api/push/test { id } — push to one device, so "is this actually wired up?" has an answer
		if (req.method === 'POST' && pathname === '/api/push/test') {
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

		// POST /api/workspaces { repo, prompt, send? } — create a workspace via Conductor's deep link
		if (req.method === 'POST' && pathname === '/api/workspaces') {
			const body = JSON.parse((await readBody(req)) || '{}') as { repo?: string; prompt?: string; send?: boolean }
			// The prompt is optional — a bare `path=` opens an empty workspace, like
			// Conductor's own New workspace — but *something* has to say where it goes.
			const prompt = (body.prompt ?? '').trim()
			if (!prompt && !body.repo) return json(req, res, 400, { error: 'need a repo or a prompt' })
			// Resolve the repo to a real path: an unmatched `path` would silently land
			// the workspace in whichever repo Conductor happens to list first.
			const repo = body.repo ? reads.listRepos().find(r => r.name === body.repo) : undefined
			if (body.repo && !repo) return json(req, res, 404, { error: `unknown repo ${body.repo}` })
			if (repo && !repo.root_path) return json(req, res, 409, { error: `${repo.name} has no checkout path` })
			const before = new Set(reads.listWorkspaces().map(w => w.id))
			const result = await createWorkspace(prompt, repo?.root_path ?? null)
			if (!result.ok) return json(req, res, 502, result)
			// The deep link is fire-and-forget, so the new row is the only proof it worked.
			// Creating a worktree takes a beat longer than opening a chat does.
			let created: Workspace | undefined
			for (let attempt = 0; attempt < 40 && !created; attempt++) {
				await sleep(500)
				created = reads.listWorkspaces().find(w => !before.has(w.id))
			}
			if (!created) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor didn’t create a workspace — check it’s running and not showing a dialog.'
				})
			}
			// Return as soon as the row exists (~2s) — waiting for delivery would block the
			// request through Conductor's whole setup, measured at 30s+ on a real repo and
			// past any budget a phone should hold a request open for. The queue delivers on
			// its own schedule and the phone watches it in /api/state; `send:true` opts API
			// callers into waiting.
			// Whatever happens, the prompt is already pre-filled in Conductor's composer.
			const settled = prompt ? firstPrompts.enqueue(created.id, prompt) : null
			const failed = settled && body.send === true ? await settled : null
			settled?.catch(() => undefined) // fire-and-forget: it reports failure, it never rejects
			return json(req, res, 200, {
				ok: true,
				workspaceId: created.id,
				workspace: reads.getWorkspace(created.id) ?? created,
				pendingPrompt: prompt || undefined,
				sent: body.send === true ? !failed : false,
				warning: failed?.error && `Workspace created; the prompt is pre-filled but wasn’t sent (${failed.error}).`
			})
		}

		// GET /api/repos/:name/icon — the repo's resolved sidebar icon (see src/icons.ts)
		let m = pathname.match(/^\/api\/repos\/([^/]+)\/icon$/)
		if (req.method === 'GET' && m) {
			const icon = reads.resolveRepoIcon(decodeURIComponent(m[1]))
			if (!icon) return json(req, res, 404, { error: 'no icon' })
			return void fs.readFile(icon.path, (err, data) => {
				if (err) return void json(req, res, 404, { error: 'no icon' })
				// Cache briefly on the phone; the resolver itself refreshes within ~30s of an icon change.
				res.writeHead(200, { 'content-type': icon.contentType, 'cache-control': 'public, max-age=300' })
				res.end(data)
			})
		}

		// GET /api/workspaces/:id/sessions
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/sessions$/)
		if (req.method === 'GET' && m) {
			return json(req, res, 200, { sessions: reads.listSessions(decodeURIComponent(m[1])) })
		}

		// POST /api/workspaces/:id/sessions — open a new chat (Cmd+T) in the workspace
		if (req.method === 'POST' && m) {
			const workspaceId = decodeURIComponent(m[1])
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const before = new Set(reads.listSessions(workspaceId).map(s => s.id))
			const result = await newChat(ws)
			if (!result.ok) return json(req, res, 502, result)
			// The new session lands in the DB a beat after Cmd+T — poll for the fresh id.
			let sessionId: string | null = null
			for (let i = 0; i < 12 && !sessionId; i++) {
				await new Promise(r => setTimeout(r, 500))
				sessionId = reads.listSessions(workspaceId).find(s => !before.has(s.id))?.id ?? null
			}
			return json(req, res, 200, { ok: true, sessionId })
		}

		// GET /api/workspaces/:id/diff
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/diff$/)
		if (req.method === 'GET' && m) {
			const ws = reads.getWorkspace(decodeURIComponent(m[1]))
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
			const diff = await workspaceDiff(ws.worktree, ws.baseBranch)
			return json(req, res, 200, diff)
		}

		// POST /api/workspaces/:id/merge — merge the workspace's open PR (mirrors Conductor's merge button)
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/merge$/)
		if (req.method === 'POST' && m) {
			const ws = reads.getWorkspace(decodeURIComponent(m[1]))
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const result = await mergePr(ws)
			return json(req, res, result.ok ? 200 : 409, result)
		}

		// POST /api/workspaces/:id/status { status } — move it between the sidebar's status groups.
		// Conductor derives that status from a PR it sometimes never links (a PR merged inside its
		// poll window is invisible to it afterwards), which strands finished work in "In progress"
		// with no way to correct it from a phone. This is that way.
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/status$/)
		if (req.method === 'POST' && m) {
			const workspaceId = decodeURIComponent(m[1])
			const body = JSON.parse((await readBody(req)) || '{}') as { status?: string }
			const status = body.status ?? ''
			if (!WORKSPACE_STATUS_LABELS[status]) {
				const allowed = Object.keys(WORKSPACE_STATUS_LABELS).join(', ')
				return json(req, res, 400, { error: `status must be one of ${allowed}` })
			}
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const result = await setWorkspaceStatus(ws, status)
			if (!result.ok) return json(req, res, 502, result)
			// The menu press lands in the DB a beat later. Confirm rather than assume —
			// and if Conductor wrote something else, say what, instead of "didn't work".
			let observed = ws.manual_status ?? ''
			for (let i = 0; i < 10 && observed !== status; i++) {
				await new Promise(r => setTimeout(r, 300))
				observed = reads.getWorkspace(workspaceId)?.manual_status ?? ''
			}
			if (observed !== status) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: observed
						? `Conductor recorded the status as “${observed}”, not “${status}”.`
						: 'Conductor didn’t record the change — it may have been asleep. Try again.'
				})
			}
			return json(req, res, 200, { ok: true, workspace: reads.getWorkspace(workspaceId) })
		}

		// GET /api/sessions/:id/messages?after=<rowid>
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
		if (req.method === 'GET' && m) {
			const after = Number(url.searchParams.get('after') ?? 0)
			return json(req, res, 200, reads.getMessages(decodeURIComponent(m[1]), Number.isFinite(after) ? after : 0))
		}

		// GET /api/sessions/:id/models?workspaceId= — labels from Conductor's live picker
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/models$/)
		if (req.method === 'GET' && m) {
			const sessionId = decodeURIComponent(m[1])
			const ws = reads.getWorkspace(url.searchParams.get('workspaceId') ?? '')
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			const result = await listAgentModels({ workspace: ws, sessionId, tab: located.tab })
			return json(req, res, result.ok ? 200 : 502, result)
		}

		// POST /api/sessions/:id/agent  { effort?, plan?, fast?, model? }
		// Drives the composer's own model/effort/plan/fast controls for one chat.
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/agent$/)
		if (req.method === 'POST' && m) {
			const sessionId = decodeURIComponent(m[1])
			const body = JSON.parse((await readBody(req)) || '{}') as {
				effort?: string
				plan?: boolean
				fast?: boolean
				model?: string
				workspaceId?: string
			}
			if (body.effort && !EFFORT_LABELS[body.effort]) {
				return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
			}
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const applied = await applyAgentPatch(ws, sessionId, body)
			if (!applied.ok) return json(req, res, 502, { ok: false, strategy: actuator.name, error: applied.error })
			return json(req, res, 200, { ok: true, session: reads.listSessions(ws.id).find(s => s.id === sessionId) })
		}

		// POST /api/sessions/:id/prompt  { text, agent? } — agent is the phone's staged
		// settings patch, applied before the prompt so the two can't come apart (and so
		// both park together when the Mac turns out to be locked).
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
		if (req.method === 'POST' && m) {
			const sessionId = decodeURIComponent(m[1])
			const body = JSON.parse((await readBody(req)) || '{}') as {
				text?: string
				workspaceId?: string
				agent?: ParkedAgentPatch
			}
			const text = (body.text ?? '').trim()
			if (!text) return json(req, res, 400, { error: 'empty prompt' })
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			// One deadline for the whole request: settings eat into the send's budget
			// rather than extending it past what the phone said it would wait.
			const deadline = Date.now() + sendBudget(req)
			const agent = body.agent && Object.keys(body.agent).length ? body.agent : undefined
			if (agent?.effort && !EFFORT_LABELS[agent.effort]) {
				return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
			}
			if (agent) {
				const applied = await applyAgentPatch(ws, sessionId, agent)
				if (!applied.ok) {
					if (lockBlocked(applied.error)) {
						const queued = parkedPrompts.park(ws.id, sessionId, text, agent)
						return json(req, res, 202, {
							ok: false,
							parked: true,
							queued,
							strategy: actuator.name,
							error: PARKED_ERROR
						})
					}
					return json(req, res, 502, { ok: false, strategy: actuator.name, error: applied.error })
				}
			}
			// Retries live inside deliverPrompt, confirmed against the transcript each time,
			// and inside the deadline this phone told us it would wait.
			const result = await deliverPrompt(ws, sessionId, text, deadline - Date.now())
			if (result.ok) {
				// Whatever a queue was still holding has now been said by hand — the first
				// prompt (including a failed entry retried from the chat), and any parked
				// copy of this exact text, which delivering again would double.
				firstPrompts.forget(ws.id)
				parkedPrompts.forgetDelivered(sessionId, text)
				return json(req, res, 200, result)
			}
			if (lockBlocked(result.error)) {
				// Settings (if any) already stuck, so the entry parks without them.
				const queued = parkedPrompts.park(ws.id, sessionId, text)
				return json(req, res, 202, { ok: false, parked: true, queued, strategy: result.strategy, error: PARKED_ERROR })
			}
			return json(req, res, 502, result)
		}

		// DELETE /api/workspaces/:id/prompt — dismiss an undelivered first prompt
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/prompt$/)
		if (req.method === 'DELETE' && m) {
			const workspaceId = decodeURIComponent(m[1])
			if (!firstPrompts.forget(workspaceId)) return json(req, res, 404, { error: 'no pending prompt' })
			return json(req, res, 200, { ok: true })
		}

		// DELETE /api/sessions/:id/prompt — dismiss whatever is parked for this chat
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
		if (req.method === 'DELETE' && m) {
			const sessionId = decodeURIComponent(m[1])
			if (!parkedPrompts.forgetSession(sessionId)) return json(req, res, 404, { error: 'no parked prompt' })
			return json(req, res, 200, { ok: true })
		}

		return json(req, res, 404, { error: 'no route', pathname })
	} catch (err) {
		// Log the detail locally; don't reflect internals (paths, stack strings) back over the wire.
		console.error(`[relay] ${req.method} ${pathname} failed:`, err)
		return json(req, res, 500, { error: 'internal error' })
	}
})

server.listen(cfg.port, cfg.host, () => {
	console.info(
		[
			'conductor-remote relay up',
			`  db:         ${cfg.dbPath}`,
			`  worktrees:  ${cfg.workspacesRoot}`,
			`  actuator:   ${actuator.name}`,
			`  bound:      ${cfg.host}:${cfg.port}`,
			'',
			`  Local:  http://${cfg.host}:${cfg.port}/#token=${cfg.token}`,
			'  Phone:  fronted by `tailscale funnel`/`serve` — run `yarn service status` for the HTTPS URL'
		].join('\n')
	)
	// Loud, actionable warning in relay.log if the node's MagicDNS name drifted from the saved phone URL's host
	// (a renamed node silently bricks the installed PWA). No-ops until a drift-aware deploy recorded a baseline.
	const tsBin = tailscaleBin()
	if (tsBin) {
		const drift = driftWarningLines(tsBin)
		if (drift.length) console.info(`\n${drift.join('\n')}`)
	}
	// Pick up any first prompt the previous process was still holding — an auto-update
	// restart lands mid-setup often enough that this is the normal path, not a rare one.
	firstPrompts.start()
	// Same for prompts parked behind the lock screen — a lock outlives relay restarts.
	parkedPrompts.start()
	// Keep the managed global daemon current — no-ops for dev checkouts / unmanaged runs (see autoupdate.ts).
	startAutoUpdate()
	// Keep the phone's public URL reachable — re-registers Funnel when its ingress goes stale after a
	// network change. No-ops unless managed + public (Funnel) posture (see funnel-watchdog.ts).
	startFunnelWatchdog()
	// Watch for turns ending and push them to subscribed phones. Idle (one small local
	// query per tick) until a device subscribes; see notify.ts.
	startNotifier(reads)
	// Watch armed keep-awake windows for their recorded expiry: the helper's restore only
	// re-allows sleep, so a lid still shut at expiry needs the relay's `pmset sleepnow`
	// (see nosleep.ts). Also picks a window back up after the relay's own restarts.
	watchNoSleepExpiry()
})
