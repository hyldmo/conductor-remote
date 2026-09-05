import type http from 'node:http'
import { handleRpc } from '../../mcp/dispatcher.ts'
import { READ_TIMEOUT_MS } from '../../mcp/protocol.ts'
import { createTools } from '../../mcp/registry.ts'
import type { CallOptions, RpcRequest } from '../../mcp/types.ts'

import { responseErrorMessage } from '../../shared.ts'

import { withUiPriority } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'
import type { ResponsesServices } from './responses.ts'

export function createMcpServices(
	services: Pick<BaseServices, 'cfg'> & Pick<ResponsesServices, 'json' | 'authed' | 'readBody' | 'forTheClient'>
) {
	const { cfg, json, authed, readBody, forTheClient } = services

	/**
	 * The MCP tools, bound to this relay over loopback.
	 *
	 * A self-request looks odd and is deliberate: the alternative is carving every route
	 * handler out of the router below so the tools could call them directly, which buys
	 * a sub-millisecond hop and costs the guarantee that matters — that a tool behaves
	 * identically over `POST /mcp` and over `conductor-remote mcp`'s stdio. One code
	 * path, one set of budgets, one place a route's semantics live.
	 */
	const mcpTools = createTools(async <T>(route: string, opts: CallOptions = {}): Promise<T> => {
		// 0.0.0.0 binds every interface, so loopback still reaches us; a pinned RELAY_HOST
		// is the address we actually answer on.
		const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host
		const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
		const res = await fetch(`http://${host}:${cfg.port}${route}`, {
			method: opts.method ?? 'GET',
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${cfg.token}`,
				'content-type': 'application/json',
				'x-relay-client': 'mcp',
				'x-client-timeout-ms': String(timeoutMs)
			},
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		})
		const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: unknown }
		if (!res.ok) {
			const busy = res.status === 503 ? ' (Conductor’s UI is busy — retry shortly)' : ''
			throw new Error(`${responseErrorMessage(payload.error, `HTTP ${res.status}`)}${busy}`)
		}
		return payload as T
	})

	/**
	 * MCP over HTTP.
	 *
	 * Two guards beyond the token. **Origin is rejected when present and foreign**: a real
	 * MCP client sends none, and a browser cannot omit it — so this closes the DNS-rebinding
	 * hole the spec warns about without needing to know our own hostname behind Tailscale's
	 * TLS. And **the body is capped**, because this endpoint is reachable from the internet
	 * whenever EXPOSE=public and an unbounded JSON parse is the cheapest thing to abuse.
	 */
	async function handleMcpHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.method === 'GET' || req.method === 'DELETE') {
			// No server-initiated messages and no session to end. 405 is the spec's own answer
			// for a server that doesn't offer the stream.
			res.writeHead(405, { allow: 'POST' }).end()
			return
		}
		if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end()

		const origin = req.headers.origin
		if (origin) return void json(req, res, 403, { error: 'cross-origin requests are not accepted here' })
		if (!authed(req)) return void json(req, res, 401, { error: 'unauthorized' })

		let body: string
		try {
			body = await readBody(req)
		} catch {
			return void json(req, res, 400, { error: 'could not read request body' })
		}
		if (body.length > 1_000_000) return void json(req, res, 413, { error: 'request too large' })

		let parsed: unknown
		try {
			parsed = JSON.parse(body || 'null')
		} catch {
			res.writeHead(400, { 'content-type': 'application/json' })
			return void res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
		}

		// Agents yield the UI lock to whoever is holding the phone, exactly as the stdio
		// transport does via its `x-relay-client` header.
		const answers = await withUiPriority('background', async () => {
			const batch = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest]
			const settled = await Promise.all(batch.map(m => handleRpc(mcpTools, m)))
			return settled.filter(m => m !== null)
		})

		// A payload of nothing but notifications takes no reply at all.
		if (!answers.length) return void res.writeHead(202).end()
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
		res.end(JSON.stringify(forTheClient(Array.isArray(parsed) ? answers : answers[0])))
	}
	return { handleMcpHttp }
}
export type McpServices = ReturnType<typeof createMcpServices>
