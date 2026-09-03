import { describe, expect, test } from 'vitest'
import { type CallOptions, createTools, type RelayCall } from '../src/mcp-tools.ts'
import { routes } from '../src/routes.ts'

function closeTool(seen: { route?: string; method?: string; body?: Record<string, unknown> }) {
	const call: RelayCall = async <T>(route: string, opts?: CallOptions): Promise<T> => {
		seen.route = route
		seen.method = opts?.method
		seen.body = opts?.body as Record<string, unknown>
		return { ok: true, activeSessionId: 'chat-2' } as T
	}
	const tool = createTools(call).find(candidate => candidate.name === 'close_chat')
	if (!tool) throw new Error('close_chat does not exist')
	return tool
}

describe('MCP close_chat', () => {
	test('uses the shared DELETE route and keeps the running-chat confirmation explicit', async () => {
		const seen: { route?: string; method?: string; body?: Record<string, unknown> } = {}
		const output = await closeTool(seen).run({
			session_id: 'chat-1',
			workspace_id: 'workspace-1',
			close_running: true
		})

		expect(seen).toEqual({
			route: routes.closeChat.path('chat-1'),
			method: 'DELETE',
			body: { workspaceId: 'workspace-1', closeRunning: true }
		})
		expect(output).toBe('closed; active session_id: chat-2')
	})

	test('does not confirm closing a running chat by default', async () => {
		const seen: { body?: Record<string, unknown> } = {}
		await closeTool(seen).run({ session_id: 'chat-1' })
		expect(seen.body).toEqual({ workspaceId: undefined, closeRunning: false })
	})
})
