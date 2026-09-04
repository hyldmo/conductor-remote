/**
 * The voice listener: a second HTTP server on its own loopback port, carrying only what
 * OpenAI's and Twilio's servers must be able to reach.
 *
 * Why it is not part of `src/server.ts` (design ▸ D2). Those two callers need a public
 * address, and Tailscale's Funnel flag is per host:port — so anything sharing the relay's
 * port would go public with it. A separate port keeps the relay tailnet-only while exactly
 * three routes face the internet. It also means a bug in this file cannot answer `/api/…`.
 *
 * **Public path vs local path.** Funnel mounts this at `--set-path=/voice` on 443, and
 * Tailscale *strips* the mount prefix before proxying, so the public
 * `https://<node>/voice/webhook` arrives here as `/webhook` (measured 2026-09-02). A direct
 * loopback curl uses the local path, and a future mount at `/` would not strip. Both spellings
 * are accepted, because the alternative is a 404 whose cause is invisible from either side.
 *
 * **Why 443 and not 8443** (probe 0a, same day): OpenAI's cloud connects to port 443 and to
 * nothing else. Funnel's other ports answer an ordinary browser and are never dialled.
 *
 * Nothing here verifies a signature or speaks JSON-RPC. The routes are injected, so the caller
 * gate (`twiml.ts`, `webhook.ts`) and the tool set (`tools.ts`) are written and tested apart
 * from the plumbing, and this file stays the one place the HTTP rules live.
 */
import crypto from 'node:crypto'
import http from 'node:http'

/** A body big enough for any webhook and small enough that a token holder cannot exhaust memory. */
export const MAX_BODY_BYTES = 1_000_000

/** What an injected route answers with. `body` is sent verbatim. */
export interface VoiceReply {
	status: number
	body?: string
	contentType?: string
}

export interface VoiceRoutes {
	/** OpenAI's `realtime.call.incoming`. Verifies the Standard Webhooks signature itself. */
	webhook(body: string, headers: http.IncomingHttpHeaders): Promise<VoiceReply>
	/** Twilio's call webhook; answers TwiML. Verifies `X-Twilio-Signature` itself. */
	twiml(body: string, headers: http.IncomingHttpHeaders): Promise<VoiceReply>
	/** One JSON-RPC message for the voice MCP endpoint. Null for a notification, which takes no reply. */
	rpc(message: unknown, headers: http.IncomingHttpHeaders): Promise<unknown | null>
}

export interface VoiceServerDeps {
	routes: VoiceRoutes
	/** The scoped bearer for `/mcp`. Read fresh per request so a rotation needs no restart. */
	mcpToken: () => string
	log?: (line: string) => void
}

/** Constant-time compare that does not leak the length of the expected token either. */
function tokenEq(given: string | null, expected: string): boolean {
	if (!given) return false
	const a = crypto.createHash('sha256').update(given).digest()
	const b = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(a, b)
}

function bearer(req: http.IncomingMessage): string | null {
	const auth = req.headers.authorization
	return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
}

/**
 * The local route name for a request path. Tailscale strips the `/voice` mount prefix, so both
 * spellings map to the same route; anything else is null and gets a 404.
 */
export function routeName(pathname: string): 'webhook' | 'twiml' | 'mcp' | null {
	const trimmed = pathname.replace(/\/+$/, '') || '/'
	// The OpenAI dashboard is already configured to the mount itself (`…/voice`). Funnel
	// strips that mount and the listener sees `/`; a direct loopback check sees `/voice`.
	if (trimmed === '/' || trimmed === '/voice') return 'webhook'
	const local = trimmed.startsWith('/voice/') ? trimmed.slice('/voice'.length) : trimmed
	if (local === '/webhook') return 'webhook'
	if (local === '/twiml') return 'twiml'
	if (local === '/mcp') return 'mcp'
	return null
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
	const declared = Number(req.headers['content-length'])
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
	const chunks: Buffer[] = []
	let bytes = 0
	for await (const chunk of req) {
		bytes += (chunk as Buffer).length
		if (bytes > MAX_BODY_BYTES) return null
		chunks.push(chunk as Buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function send(res: http.ServerResponse, reply: VoiceReply): void {
	const headers: Record<string, string> = { 'cache-control': 'no-store' }
	if (reply.body !== undefined) headers['content-type'] = reply.contentType ?? 'text/plain; charset=utf-8'
	res.writeHead(reply.status, headers).end(reply.body ?? '')
}

const RPC_PARSE_ERROR = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })

/**
 * Handle one request. Exported so a test can drive it without a socket, and so the rules —
 * which route, which method, which gate — are readable in one place rather than spread over
 * a dispatcher.
 */
export async function handleVoiceRequest(
	deps: VoiceServerDeps,
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const pathname = new URL(req.url ?? '/', 'http://x').pathname
	const route = routeName(pathname)
	// A 404 that names nothing: the routes are each behind a secret, and an attacker who finds
	// them still gets nowhere, but there is no reason to enumerate them either.
	if (!route) return send(res, { status: 404, body: 'not found' })

	if (req.method !== 'POST') {
		return send(res, { status: 405, body: 'POST only', contentType: 'text/plain; charset=utf-8' })
	}

	if (route === 'mcp') {
		// A real MCP client sends no Origin and a browser cannot omit one, so this single check
		// closes the DNS-rebinding hole without the listener needing to know its own hostname.
		if (req.headers.origin) return send(res, { status: 403, body: 'cross-origin requests are not accepted here' })
		if (!tokenEq(bearer(req), deps.mcpToken())) return send(res, { status: 401, body: 'unauthorized' })
	}

	const body = await readBody(req)
	if (body === null) return send(res, { status: 413, body: 'request too large' })

	if (route === 'webhook') return send(res, await deps.routes.webhook(body, req.headers))
	if (route === 'twiml') return send(res, await deps.routes.twiml(body, req.headers))

	let parsed: unknown
	try {
		parsed = JSON.parse(body || 'null')
	} catch {
		return send(res, { status: 400, body: RPC_PARSE_ERROR, contentType: 'application/json' })
	}
	const batch = Array.isArray(parsed) ? parsed : [parsed]
	const settled = await Promise.all(batch.map(m => deps.routes.rpc(m, req.headers)))
	const answers = settled.filter(a => a !== null)
	// A payload of nothing but notifications takes no reply at all.
	if (!answers.length) return send(res, { status: 202 })
	send(res, {
		status: 200,
		body: JSON.stringify(Array.isArray(parsed) ? answers : answers[0]),
		contentType: 'application/json'
	})
}

/** Bound to loopback only: everything public arrives through Tailscale, never off the LAN. */
export function createVoiceServer(deps: VoiceServerDeps): http.Server {
	return http.createServer((req, res) => {
		handleVoiceRequest(deps, req, res).catch(err => {
			deps.log?.(`[voice] request failed: ${err instanceof Error ? err.message : err}`)
			if (!res.headersSent) send(res, { status: 500, body: 'internal error' })
		})
	})
}
