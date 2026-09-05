/** How a tool reaches the relay. Injected so both transports share one tool definition. */
export interface CallOptions {
	method?: string
	body?: unknown
	timeoutMs?: number
}

export type RelayCall = <T>(route: string, opts?: CallOptions) => Promise<T>

// ── tools ───────────────────────────────────────────────────────────────────────

export interface Tool {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	run: (args: Record<string, unknown>) => Promise<string>
}

// ── JSON-RPC 2.0, transport-agnostic ───────────────────────────────────

export interface RpcRequest {
	jsonrpc: '2.0'
	id?: string | number | null
	method: string
	params?: Record<string, unknown>
}

export interface RpcResponse {
	jsonrpc: '2.0'
	id: string | number | null
	result?: unknown
	error?: { code: number; message: string }
}
