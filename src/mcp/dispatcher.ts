import { str } from './arguments.ts'
import { INSTRUCTIONS, PROTOCOL_VERSIONS, SERVER_INFO } from './protocol.ts'
import type { RpcRequest, RpcResponse, Tool } from './types.ts'

const ok = (id: RpcRequest['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result })

const err = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({
	jsonrpc: '2.0',
	id: id ?? null,
	error: { code, message }
})

/**
 * Handle one JSON-RPC message. Returns null for a notification, which by spec takes
 * no reply at all — stdio writes nothing and HTTP answers 202.
 */
export async function handleRpc(tools: Tool[], req: RpcRequest): Promise<RpcResponse | null> {
	const notification = req.id === undefined || req.id === null
	switch (req.method) {
		case 'initialize': {
			const asked = str(req.params?.protocolVersion)
			return ok(req.id, {
				// Echo the client's version when we know it, else name our newest. A client
				// that can't live with the answer disconnects, which is the spec's own path.
				protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
				instructions: INSTRUCTIONS
			})
		}
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return null
		case 'ping':
			return notification ? null : ok(req.id, {})
		case 'tools/list':
			return ok(req.id, {
				tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
			})
		case 'tools/call': {
			const name = str(req.params?.name)
			const tool = tools.find(t => t.name === name)
			if (!tool) return err(req.id, -32602, `unknown tool: ${name}`)
			const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {}
			try {
				const text = await tool.run(args)
				return ok(req.id, { content: [{ type: 'text', text: text || '(no output)' }] })
			} catch (e) {
				// A tool failure is a result the model should see and can act on, not a
				// protocol error that would hide the reason behind a transport code.
				const message = e instanceof Error ? e.message : String(e)
				return ok(req.id, { content: [{ type: 'text', text: message }], isError: true })
			}
		}
		default:
			return notification ? null : err(req.id, -32601, `method not found: ${req.method}`)
	}
}
