import { describe, expect, test, vi } from 'vitest'
import { handleRpc } from '../../src/mcp/dispatcher.ts'
import { WRITE_TIMEOUT_MS } from '../../src/mcp/protocol.ts'
import { createTools } from '../../src/mcp/registry.ts'
import type { CallOptions } from '../../src/mcp/types.ts'

function fixture() {
	const call = vi.fn(async (_route: string, _options?: CallOptions) => ({ ok: true, workspaceId: 'new-workspace' }))
	const tools = createTools(async <T>(route: string, options?: CallOptions) => (await call(route, options)) as T)
	const tool = (name: string) => {
		const found = tools.find(candidate => candidate.name === name)
		if (!found) throw new Error(`missing tool ${name}`)
		return found
	}
	return { call, tools, tool }
}

describe('shared agent input schemas over MCP', () => {
	test('advertises optional defaults, constraints and descriptions without exposing HTTP-only options', () => {
		const { tool } = fixture()
		const create = tool('create_workspace').inputSchema
		expect(create).toMatchObject({
			type: 'object',
			required: ['repo'],
			additionalProperties: false,
			properties: {
				repo: { type: 'string', minLength: 1, description: expect.stringContaining('list_repos') },
				model: { type: 'string', description: expect.stringContaining('list_models') },
				effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
				wait_for_send: { type: 'boolean', default: false },
				send_immediately: { type: 'boolean', default: true }
			}
		})
		expect(create.properties).not.toHaveProperty('attachmentIds')
		expect(create.properties).not.toHaveProperty('sendImmediately')
		const send = tool('send_prompt').inputSchema
		expect(send.required).toEqual(['session_id', 'text'])
		expect(send.properties).not.toHaveProperty('agent')
		expect(send.properties).not.toHaveProperty('queue')
		expect(tool('set_agent_options').inputSchema.required).toEqual(['session_id'])
	})

	test('normalizes prompt input and maps chat ids to the URL and HTTP body', async () => {
		const { call, tool } = fixture()
		expect(
			await tool('send_prompt').run({ session_id: ' chat/one ', workspace_id: ' workspace ', text: ' hello ' })
		).toBe('sent')
		expect(call).toHaveBeenCalledExactlyOnceWith('/api/sessions/chat%2Fone/prompt', {
			method: 'POST',
			body: { workspaceId: 'workspace', text: 'hello' },
			timeoutMs: WRITE_TIMEOUT_MS
		})
	})

	test('uses creation defaults without inventing agent settings, and preserves explicit false settings', async () => {
		const { call, tool } = fixture()
		const create = tool('create_workspace')
		await create.run({ repo: 'example' })
		expect(call.mock.calls[0]).toEqual([
			'/api/workspaces',
			{
				method: 'POST',
				body: { repo: 'example', send: false, sendImmediately: true },
				timeoutMs: 30_000
			}
		])
		await create.run({
			repo: 'example',
			model: ' Fable 5 ',
			plan: false,
			fast: false,
			wait_for_send: true,
			send_immediately: false
		})
		expect(call.mock.calls[1]).toEqual([
			'/api/workspaces',
			{
				method: 'POST',
				body: { repo: 'example', model: 'Fable 5', plan: false, fast: false, send: true, sendImmediately: false },
				timeoutMs: WRITE_TIMEOUT_MS
			}
		])
	})

	test('requires a meaningful settings change but treats false as an explicit change', async () => {
		const { call, tool } = fixture()
		const agent = tool('set_agent_options')
		await expect(agent.run({ session_id: 'chat', model: '   ' })).rejects.toThrow('nothing to change')
		expect(call).not.toHaveBeenCalled()
		await agent.run({ session_id: 'chat', workspace_id: 'workspace', plan: false, fast: false })
		expect(call).toHaveBeenCalledExactlyOnceWith('/api/sessions/chat/agent', {
			method: 'POST',
			body: { workspaceId: 'workspace', plan: false, fast: false },
			timeoutMs: WRITE_TIMEOUT_MS
		})
	})

	test.each([
		['send_prompt', { session_id: 'chat', text: '   ' }, 'empty prompt'],
		['send_prompt', { session_id: 'chat', text: 123 }, 'prompt must be a string'],
		['send_prompt', { session_id: 'chat', text: 'hello', queue: true }, 'unknown field: queue'],
		['send_prompt', { session_id: 'chat', text: 'hello', workspace_id: 123 }, 'workspace_id'],
		['create_workspace', {}, 'repo'],
		['create_workspace', { repo: 'example', fast: 'false' }, 'fast'],
		['create_workspace', { repo: 'example', send_immediately: 'false' }, 'send_immediately'],
		['create_workspace', { repo: 'example', wait_for_send: 1 }, 'wait_for_send'],
		['create_workspace', { repo: 'example', workflow: true }, 'unknown field: workflow'],
		['set_agent_options', { session_id: 'chat', effort: 'extreme' }, 'effort'],
		['set_agent_options', { session_id: 'chat', plan: 'false' }, 'plan'],
		['set_agent_options', { session_id: 'chat', fast: null }, 'fast'],
		['set_agent_options', { session_id: 'chat', fast: false, typo: true }, 'unknown field: typo'],
		['set_agent_options', ['chat'], 'expected object']
	])('returns a tool error for invalid %s input without an HTTP call (%#)', async (name, args, message) => {
		const { call, tools } = fixture()
		const result = await handleRpc(tools, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args }
		})
		expect(result).toMatchObject({
			result: {
				isError: true,
				content: [{ type: 'text', text: expect.stringContaining(message) }]
			}
		})
		expect(call).not.toHaveBeenCalled()
	})
})
