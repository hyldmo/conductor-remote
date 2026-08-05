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
import { notifyDevice, pushConfig, startNotifier, subscribeDevice, unsubscribeDevice } from './notify.ts'
import { attachPrStatus } from './pr.ts'
import { Reads, type SessionRow, type Workspace } from './reads.ts'
import { driftWarningLines, tailscaleBin } from './tailscale.ts'
import {
	type AgentOptions,
	type ChatTab,
	createWorkspace,
	describeActuator,
	EFFORT_LABELS,
	listAgentModels,
	newChat,
	pickActuator,
	type SendResult,
	setAgentOptions,
	setRestartGuard
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
 * Confirm a prompt actually reached the session by watching the transcript for a
 * new user row matching it. The AppleScript actuator reports `ok` on `osascript`
 * exit 0 — which only means the script *ran*, not that Conductor was focused and
 * accepted the keystrokes — so without this a dropped send (asleep/unfocused Mac)
 * looks delivered. Conductor writes the row right after the send presses Enter, so
 * a short poll catches a real send fast and only the failure path waits the full
 * window. A queued prompt still writes a user row, so it counts as delivered.
 */
async function confirmDelivery(sessionId: string, text: string, sinceRowid: number): Promise<boolean> {
	const target = text.trim()
	for (let attempt = 0; attempt < 12; attempt++) {
		const { entries } = reads.getMessages(sessionId, sinceRowid)
		if (entries.some(e => e.role === 'user' && e.text.trim() === target)) return true
		await sleep(350)
	}
	return false
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
 * Deliver a prompt to one chat and confirm it landed. The single write path: the
 * phone's own sends go through it, and so does the first-prompt queue, so both
 * get the same targeting, the same read-back and the same errors.
 */
async function deliverPrompt(ws: Workspace, sessionId: string, text: string): Promise<SendResult> {
	const located = locateChat(ws, sessionId)
	if ('error' in located) return { ok: false, strategy: actuator.name, error: located.error }
	// Snapshot the transcript cursor so we can confirm the prompt actually lands.
	const beforeRowid = reads.getMessages(sessionId).cursor
	const result = await actuator.send({ workspace: ws, sessionId, tab: located.tab }, text)
	if (!result.ok) {
		console.warn(`[relay] send to ${ws.branch ?? ws.id} failed: ${result.error}`)
		return result
	}
	if (!(await confirmDelivery(sessionId, text, beforeRowid))) {
		// The phone only ever sees "try again"; the reason a send goes missing lives
		// on this side, so leave a trail in relay.log rather than nothing at all.
		console.warn(`[relay] send to ${ws.branch ?? ws.id} drove the UI but never landed in the chat`)
		return {
			ok: false,
			strategy: result.strategy,
			error: 'Send didn’t land in the chat — Conductor may have been asleep or unfocused. Try again.'
		}
	}
	return result
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
		return { ok: result.ok, error: result.error }
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
			for (const ws of workspaces) ws.pending_prompt = firstPrompts.get(ws.id)
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
			// past the phone's own 25s budget. The queue delivers on its own schedule and
			// the phone watches it in /api/state; `send:true` opts API callers into waiting.
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
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			// Fast mode exposes no readable state in the UI, so the DB decides whether
			// the button actually needs pressing — pressing blindly would toggle it off.
			const opts: AgentOptions = {
				effort: body.effort,
				plan: body.plan,
				model: body.model,
				toggleFast: body.fast === undefined ? false : body.fast !== Boolean(located.session?.fast_mode)
			}
			const result = await setAgentOptions({ workspace: ws, sessionId, tab: located.tab }, opts)
			if (!result.ok) return json(req, res, 502, result)
			if (!(await confirmAgentOptions(ws, sessionId, opts))) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor didn’t record the change — it may have been asleep. Try again.'
				})
			}
			return json(req, res, 200, { ok: true, session: reads.listSessions(ws.id).find(s => s.id === sessionId) })
		}

		// POST /api/sessions/:id/prompt  { text }
		m = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
		if (req.method === 'POST' && m) {
			const sessionId = decodeURIComponent(m[1])
			const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; workspaceId?: string }
			const text = (body.text ?? '').trim()
			if (!text) return json(req, res, 400, { error: 'empty prompt' })
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const result = await deliverPrompt(ws, sessionId, text)
			// Whatever the queue was still holding for this workspace has now been said by
			// hand — including a failed entry the user retried from the chat.
			if (result.ok) firstPrompts.forget(ws.id)
			return json(req, res, result.ok ? 200 : 502, result)
		}

		// DELETE /api/workspaces/:id/prompt — dismiss an undelivered first prompt
		m = pathname.match(/^\/api\/workspaces\/([^/]+)\/prompt$/)
		if (req.method === 'DELETE' && m) {
			const workspaceId = decodeURIComponent(m[1])
			if (!firstPrompts.forget(workspaceId)) return json(req, res, 404, { error: 'no pending prompt' })
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
	// Keep the managed global daemon current — no-ops for dev checkouts / unmanaged runs (see autoupdate.ts).
	startAutoUpdate()
	// Keep the phone's public URL reachable — re-registers Funnel when its ingress goes stale after a
	// network change. No-ops unless managed + public (Funnel) posture (see funnel-watchdog.ts).
	startFunnelWatchdog()
	// Watch for turns ending and push them to subscribed phones. Idle (one small local
	// query per tick) until a device subscribes; see notify.ts.
	startNotifier(reads)
})
