import { createInterface } from 'node:readline'
import { call, relayBase } from './mcp/client.ts'
import { handleRpc } from './mcp/dispatcher.ts'
import { createTools } from './mcp/registry.ts'
import type { RpcRequest } from './mcp/types.ts'

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
 * nor OAuth. The tool wrapper uses the relay's existing Zod dependency for shared
 * input validation and JSON Schema export, without adding the SDK's HTTP/OAuth stack.
 */

/**
 * stdout is the wire. A stray `console.log` from anywhere in this process would be
 * parsed as a protocol message and kill the session, so the one shared mistake is
 * made impossible up front rather than guarded against per call site.
 */
console.log = (...args: unknown[]) => console.error(...args)
console.info = (...args: unknown[]) => console.error(...args)

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
