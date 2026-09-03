import { describe, expect, test, vi } from 'vitest'
import { type AgentConfigState, type AgentConfigWrite, applyAgentConfig } from '../src/agent-config.ts'

const state = (overrides: Partial<AgentConfigState> = {}): AgentConfigState => ({
	agentType: 'claude',
	model: 'fable-5',
	effort: 'max',
	plan: false,
	fast: false,
	...overrides
})

describe('cross-provider agent configuration', () => {
	test('switches the model alone, reacquires state, then applies only differing controls', async () => {
		let current = state()
		const writes: AgentConfigWrite[] = []
		const write = vi.fn(async (options: AgentConfigWrite) => {
			writes.push(options)
			if (options.model) {
				current = state({ agentType: 'codex', model: 'gpt-5.6-terra', effort: 'none' })
			} else if (options.effort) {
				current = { ...current, effort: options.effort }
			}
			return { ok: true as const }
		})

		await expect(
			applyAgentConfig(
				{ model: '5.6 Terra', effort: 'high', plan: false, fast: false },
				{ read: () => current, write, wait: async () => undefined }
			)
		).resolves.toEqual({ ok: true })

		expect(writes).toEqual([{ model: '5.6 Terra' }, { effort: 'high', agentType: 'codex' }])
	})

	test('does not touch controls whose requested value is already stored', async () => {
		const write = vi.fn(async () => ({ ok: true as const }))

		await expect(
			applyAgentConfig(
				{ model: 'Fable 5', effort: 'max', plan: false, fast: false },
				{ read: () => state(), write, wait: async () => undefined }
			)
		).resolves.toEqual({ ok: true })
		expect(write).not.toHaveBeenCalled()
	})

	test('requires the model and provider to reach SQLite before touching rerendered controls', async () => {
		const write = vi.fn(async () => ({ ok: true as const }))

		const result = await applyAgentConfig(
			{ model: '5.6 Terra', effort: 'high' },
			{ read: () => state(), write, wait: async () => undefined, confirmAttempts: 2 }
		)

		expect(result).toEqual({
			ok: false,
			error: 'Conductor did not record model 5.6 Terra on the expected Codex provider.'
		})
		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith({ model: '5.6 Terra' })
	})

	test('confirms provider-qualified picker labels and unambiguous prefixes', async () => {
		const write = vi.fn(async () => ({ ok: true as const }))

		await expect(
			applyAgentConfig(
				{ model: 'opencode-go/muse-spark-1.3-contributor' },
				{
					read: () =>
						state({
							agentType: 'acp',
							model: 'opencode:opencode-go/muse-spark-1.3-contributor'
						}),
					write,
					wait: async () => undefined
				}
			)
		).resolves.toEqual({ ok: true })

		let codex = state({ agentType: 'claude', model: 'fable-5' })
		const prefixWrite = vi.fn(async (options: AgentConfigWrite) => {
			if (options.model) codex = state({ agentType: 'codex', model: 'gpt-5.6-terra' })
			return { ok: true as const }
		})
		await expect(
			applyAgentConfig(
				{ model: '5.6 T' },
				{
					read: () => codex,
					write: prefixWrite,
					wait: async () => undefined
				}
			)
		).resolves.toEqual({ ok: true })
		expect(write).not.toHaveBeenCalled()
		expect(prefixWrite).toHaveBeenCalledWith({ model: '5.6 T' })
	})

	test('confirms plan and fast values after applying their deltas', async () => {
		let current = state({ effort: 'high' })
		const write = vi.fn(async (options: AgentConfigWrite) => {
			current = {
				...current,
				plan: options.plan ?? current.plan,
				fast: options.toggleFast ? !current.fast : current.fast
			}
			return { ok: true as const }
		})

		await expect(
			applyAgentConfig(
				{ effort: 'high', plan: true, fast: true },
				{ read: () => current, write, wait: async () => undefined }
			)
		).resolves.toEqual({ ok: true })
		expect(write).toHaveBeenCalledWith({ plan: true, toggleFast: true, agentType: 'claude' })
	})
})
