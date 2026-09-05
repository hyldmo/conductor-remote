import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { stateDir } from './config.ts'
import { handleRpc } from './mcp/dispatcher.ts'
import { READ_TIMEOUT_MS } from './mcp/protocol.ts'
import { createTools } from './mcp/registry.ts'
import type { CallOptions, RpcRequest } from './mcp/types.ts'

/**
 * MCP over stdio: `conductor-remote mcp`.
 *
 * The transport a local agent gets — the client spawns this as a child process and
 * talks newline-delimited JSON-RPC 2.0 over its stdin and stdout. The tools
 * themselves live in `src/mcp/tools/`, shared with the relay's own `POST /mcp` so the
 * two transports cannot drift.
 *
 * Nothing here authenticates the *stdio* channel, and nothing needs to: whatever can
 * spawn this process already runs as you on this Mac and could read the token file
 * directly. The hop that does carry a credential is the one to the relay.
 *
 * Hand-rolled rather than built on `@modelcontextprotocol/sdk`, which measures 91
 * packages / 24 MB (express, hono, cors, jose) for a server that speaks neither HTTP
 * nor OAuth. The relay's tarball keeps its zero runtime dependencies, which matters
 * more than usual here: it auto-updates itself while holding a token that drives your
 * Mac.
 */

/**
 * stdout is the wire. A stray `console.log` from anywhere in this process would be
 * parsed as a protocol message and kill the session, so the one shared mistake is
 * made impossible up front rather than guarded against per call site.
 */
console.log = (...args: unknown[]) => console.error(...args)
console.info = (...args: unknown[]) => console.error(...args)

function relayBase(): string {
	const port = process.env.RELAY_PORT ?? '8787'
	// The relay binds loopback (see config.ts); RELAY_HOST only widens who else can
	// reach it, so 127.0.0.1 is always right for a client on the same Mac.
	return `http://127.0.0.1:${port}`
}

function relayToken(): string {
	if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN
	try {
		return readFileSync(path.join(stateDir(), 'token'), 'utf8').trim()
	} catch {
		throw new Error(
			`no relay token at ${path.join(stateDir(), 'token')} — start the relay once (conductor-remote service install), or set RELAY_TOKEN`
		)
	}
}

async function call<T>(route: string, opts: CallOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
	let res: Response
	try {
		res = await fetch(`${relayBase()}${route}`, {
			method: opts.method ?? 'GET',
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${relayToken()}`,
				'content-type': 'application/json',
				// Marks this caller as an agent: the relay drops it to background priority on
				// the UI lock, behind anyone using the phone (src/http/router.ts ▸ withUiPriority).
				'x-relay-client': 'mcp',
				// The relay retries a failed send inside this budget and never past it, so
				// stating it here is what stops it outliving us — see src/http/services/delivery.ts ▸ sendBudget.
				'x-client-timeout-ms': String(timeoutMs)
			},
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		})
	} catch (err) {
		if (err instanceof DOMException && err.name === 'TimeoutError')
			throw new Error(`the relay did not answer within ${Math.round(timeoutMs / 1000)}s`)
		throw new Error(
			`cannot reach the relay at ${relayBase()} (${err instanceof Error ? err.message : err}). Is it running? \`conductor-remote service status\``
		)
	}
	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string }
	if (!res.ok) {
		// 503 is the UI lock refusing a deep queue, and it is worth naming as such: it
		// means "retry shortly", not "this failed".
		const busy = res.status === 503 ? ' (Conductor’s UI is busy — retry shortly)' : ''
		throw new Error(`${payload.error || `HTTP ${res.status}`}${busy}`)
	}
	return payload as T
}

const tools = createTools(call)

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * In-flight calls, so end-of-stdin doesn't kill work that hasn't answered.
 *
 * A tool call is an await on the relay, and a UI write can take tens of seconds.
 * Exiting straight from the `close` event drops every one of those on the floor —
 * which is silent, because the reply that never came looks exactly like a client
 * that stopped listening.
 */
const inFlight = new Set<Promise<unknown>>()
let stdinClosed = false

function exitWhenDrained(): void {
	if (stdinClosed && inFlight.size === 0) process.exit(0)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
	const trimmed = line.trim()
	if (!trimmed) return
	let req: RpcRequest
	try {
		req = JSON.parse(trimmed) as RpcRequest
	} catch {
		// JSON-RPC 2.0: a parse error is answered with a null id, because there is no id
		// to echo.
		return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
	}
	// Concurrent by design: sequencing is the client's job, and the writes that truly
	// cannot overlap are serialized by the relay's own UI lock, not by this loop.
	const done = handleRpc(tools, req)
		.then(res => {
			if (res) write(res)
		})
		.catch(err =>
			write({
				jsonrpc: '2.0',
				id: req.id ?? null,
				error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
			})
		)
		.finally(() => {
			inFlight.delete(done)
			exitWhenDrained()
		})
	inFlight.add(done)
})
lines.on('close', () => {
	stdinClosed = true
	exitWhenDrained()
})

console.error(`conductor-remote mcp — ${tools.length} tools, relay at ${relayBase()}`)
