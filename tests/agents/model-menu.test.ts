import { describe, expect, test } from 'vitest'
import { createTools } from '../../src/mcp/registry.ts'
import type { CallOptions, RelayCall } from '../../src/mcp/types.ts'
import { parseModelMenuOutput } from '../../src/writes/agent-options.ts'

describe('live model menu output', () => {
	test('separates and normalizes the starred model from picker choices', () => {
		expect(
			parseModelMenuOutput(
				['__CONDUCTOR_DEFAULT_MODEL__\tOpus 5 NEW', 'Opus 5 NEW', 'Sonnet 4.6', 'Sonnet 4.6'].join('\n')
			)
		).toEqual({ defaultModel: 'Opus 5', models: ['Opus 5', 'Sonnet 4.6'] })
	})

	test('exposes a dedicated MCP write because starring is global and also selects', async () => {
		const calls: Array<{ route: string; body: unknown }> = []
		const call: RelayCall = async <T>(route: string, options?: CallOptions): Promise<T> => {
			calls.push({ route, body: options?.body })
			return { ok: true, defaultModel: '5.6 Terra' } as T
		}
		const tool = createTools(call).find(candidate => candidate.name === 'set_default_model')
		if (!tool) throw new Error('set_default_model does not exist')

		await expect(tool.run({ session_id: 'chat-1', workspace_id: 'workspace-1', model: '5.6 Terra' })).resolves.toBe(
			'5.6 Terra is now the default and selected for this chat'
		)
		expect(calls).toEqual([
			{
				route: '/api/sessions/chat-1/default-model',
				body: { workspaceId: 'workspace-1', model: '5.6 Terra' }
			}
		])
	})
})
