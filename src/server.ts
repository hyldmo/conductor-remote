import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { startAutoUpdate, updateStatus } from './autoupdate.ts'
import { loadConfig } from './config.ts'
import { ConductorDb } from './db.ts'
import { workspaceDiff } from './git.ts'
import { mergePr } from './merge.ts'
import { attachPrStatus } from './pr.ts'
import { Reads } from './reads.ts'
import { describeActuator, newChat, pickActuator } from './writes.ts'

const cfg = loadConfig()
const db = new ConductorDb(cfg.dbPath)
const reads = new Reads(db, cfg.workspacesRoot)
const actuator = pickActuator(cfg.writeStrategy)

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
			return json(req, res, 200, {
				workspaces,
				actuator: await describeActuator(actuator),
				version: update.current,
				update
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
			// Snapshot the transcript cursor so we can confirm the prompt actually lands.
			const beforeRowid = reads.getMessages(sessionId).cursor
			const result = await actuator.send({ workspace: ws, sessionId }, text)
			if (result.ok && !(await confirmDelivery(sessionId, text, beforeRowid))) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Send didn’t land in the chat — Conductor may have been asleep or unfocused. Try again.'
				})
			}
			return json(req, res, result.ok ? 200 : 502, result)
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
	// Keep the managed global daemon current — no-ops for dev checkouts / unmanaged runs (see autoupdate.ts).
	startAutoUpdate()
})
