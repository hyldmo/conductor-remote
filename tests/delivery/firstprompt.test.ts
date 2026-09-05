import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspacePhase } from '../../src/delivery/firstprompt.ts'
import { FirstPromptQueue } from '../../src/delivery/firstprompt.ts'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-firstprompt-'))

interface Fake {
	phase: WorkspacePhase
	sessionId: string | null
	alreadySent: boolean
	ok: boolean
	blocked: boolean
	sends: string[]
}

function scenario(name: string, initial: Partial<Fake> = {}): { queue: FirstPromptQueue; state: Fake } {
	const state: Fake = {
		phase: 'setting_up',
		sessionId: 'chat-1',
		alreadySent: false,
		ok: false,
		blocked: false,
		sends: [],
		...initial
	}
	const queue = new FirstPromptQueue(path.join(directory, `${name}.json`), {
		inspect: () => ({ phase: state.phase, sessionId: state.sessionId, alreadySent: state.alreadySent }),
		send: async (_workspaceId, _sessionId, text) => {
			state.sends.push(text)
			return { ok: state.ok, blocked: state.blocked, error: state.ok ? undefined : 'no composer yet' }
		}
	})
	return { queue, state }
}

async function flush(ms = 0): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-08-31T00:00:00Z'))
})

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
})

afterAll(() => {
	fs.rmSync(directory, { recursive: true, force: true })
})

describe('first prompt queue', () => {
	test('sends into a setting-up workspace and settles delivery', async () => {
		const { queue, state } = scenario('early-send', { ok: true })
		const settled = await queue.enqueue('ws-1', 'hello')
		expect(state.sends).toEqual(['hello'])
		expect(queue.get('ws-1')).toBeNull()
		expect(settled).toBeNull()
	})

	test('applies selected agent settings before the first prompt', async () => {
		const steps: string[] = []
		const queue = new FirstPromptQueue(path.join(directory, 'agent.json'), {
			inspect: () => ({ phase: 'setting_up', sessionId: 'chat-model', alreadySent: false }),
			setAgent: async (_workspaceId, _sessionId, agent) => {
				steps.push(`agent:${agent.model}:${agent.effort}:${agent.fast}:${agent.plan}`)
				return { ok: true }
			},
			send: async (_workspaceId, _sessionId, text) => {
				steps.push(`prompt:${text}`)
				return { ok: true }
			}
		})

		await queue.enqueue('ws-model', 'hello', true, [], {
			model: 'Opus 5',
			effort: 'high',
			fast: true,
			plan: true
		})
		expect(steps).toEqual(['agent:Opus 5:high:true:true', 'prompt:hello'])
		expect(queue.get('ws-model')).toBeNull()
		await flush()

		steps.length = 0
		await queue.enqueue('ws-model-only', '', true, [], { model: 'Sonnet 4.6' })
		expect(steps).toEqual(['agent:Sonnet 4.6:undefined:undefined:undefined'])
	})

	test('persists a workflow root role before configuring and sending its first prompt', async () => {
		const steps: string[] = []
		const queue = new FirstPromptQueue(path.join(directory, 'workflow-root.json'), {
			inspect: () => ({
				phase: 'setting_up',
				sessionId: 'chat-workflow',
				alreadySent: false,
				worktree: '/tmp/workflow-root'
			}),
			assignRole: async (_workspaceId, sessionId, role, assignedAt) => {
				steps.push(`role:${sessionId}:${role}:${assignedAt}`)
				return { ok: true }
			},
			setAgent: async () => {
				steps.push('agent')
				return { ok: true }
			},
			send: async () => {
				steps.push('prompt')
				return { ok: true }
			}
		})

		void queue.enqueue('ws-workflow', 'Run the workflow.', true, [], { model: 'Fable 5.1' }, 'planning')
		await flush()

		expect(steps).toHaveLength(3)
		expect(steps[0]).toMatch(/^role:chat-workflow:planning:\d+$/)
		expect(steps.slice(1)).toEqual(['agent', 'prompt'])
		expect(queue.get('ws-workflow')).toBeNull()
	})

	test('does not repeat a workflow root assignment after a relay restart', async () => {
		const file = path.join(directory, 'workflow-root-restart.json')
		let assignments = 0
		const first = new FirstPromptQueue(file, {
			inspect: () => ({
				phase: 'ready',
				sessionId: 'chat-workflow-restart',
				alreadySent: false,
				worktree: '/tmp/workflow-root-restart'
			}),
			assignRole: async () => {
				assignments += 1
				return { ok: true }
			},
			setAgent: async () => ({ ok: false, blocked: true }),
			send: async () => ({ ok: true })
		})

		void first.enqueue('ws-workflow-restart', 'Run it.', true, [], { model: 'Fable 5.1' }, 'planning')
		await flush()
		expect(assignments).toBe(1)
		expect(first.get('ws-workflow-restart')).toMatchObject({
			sessionRole: 'planning',
			sessionRoleAssigned: true
		})
		vi.clearAllTimers()

		const steps: string[] = []
		const resumed = new FirstPromptQueue(file, {
			inspect: () => ({
				phase: 'ready',
				sessionId: 'chat-workflow-restart',
				alreadySent: false,
				worktree: '/tmp/workflow-root-restart'
			}),
			assignRole: async () => {
				steps.push('role')
				return { ok: true }
			},
			setAgent: async () => {
				steps.push('agent')
				return { ok: true }
			},
			send: async () => {
				steps.push('prompt')
				return { ok: true }
			}
		})

		resumed.start()
		await flush()
		expect(steps).toEqual(['agent', 'prompt'])
		expect(resumed.get('ws-workflow-restart')).toBeNull()
	})

	test('upgrades a persisted model-only entry into an agent patch', async () => {
		const models: string[] = []
		const file = path.join(directory, 'legacy-model.json')
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					workspaceId: 'ws-legacy-model',
					text: '',
					model: 'Opus 5',
					status: 'waiting',
					attempts: 0,
					createdAt: Date.now(),
					sendImmediately: true
				}
			])
		)
		const queue = new FirstPromptQueue(file, {
			inspect: () => ({ phase: 'ready', sessionId: 'chat-legacy-model', alreadySent: false }),
			setAgent: async (_workspaceId, _sessionId, agent) => {
				models.push(agent.model ?? '')
				return { ok: true }
			},
			send: async () => ({ ok: true })
		})

		queue.start()
		await flush()
		expect(models).toEqual(['Opus 5'])
		expect(queue.get('ws-legacy-model')).toBeNull()
	})

	test('uses a separate budget for early and ready failures', async () => {
		const { queue, state } = scenario('early-fail')
		void queue.enqueue('ws-2', 'hello')
		await flush()
		expect(state.sends).toEqual(['hello'])
		expect(queue.get('ws-2')).toMatchObject({ attempts: 0, earlyAttempts: 1, status: 'waiting' })

		await flush(1_500)
		expect(state.sends).toHaveLength(1)
		state.phase = 'ready'
		await flush(3_500)
		expect(state.sends).toHaveLength(2)
		expect(queue.get('ws-2')?.attempts).toBe(1)
		queue.forget('ws-2')
	})

	test('does not resend a prompt already sent from the Mac', async () => {
		const { queue, state } = scenario('already-sent', { alreadySent: true })
		expect(await queue.enqueue('ws-3', 'hello')).toBeNull()
		expect(state.sends).toEqual([])
		expect(queue.get('ws-3')).toBeNull()
	})

	test('hands a blocked early attempt back', async () => {
		const { queue, state } = scenario('blocked-early', { blocked: true })
		void queue.enqueue('ws-4', 'hello')
		await flush()
		expect(state.sends).toEqual(['hello'])
		expect(queue.get('ws-4')).toMatchObject({ attempts: 0, earlyAttempts: 0 })
		queue.forget('ws-4')
	})

	test('honors the option to wait until setup finishes', async () => {
		const { queue, state } = scenario('opt-out')
		void queue.enqueue('ws-6', 'hello', false)
		await flush(1_500)
		expect(state.sends).toEqual([])
		expect(queue.get('ws-6')?.earlyAttempts ?? 0).toBe(0)

		state.phase = 'ready'
		await flush(500)
		expect(state.sends).toEqual(['hello'])
		queue.forget('ws-6')
	})

	test('materializes staged files before sending their token', async () => {
		let worktree: string | null = null
		const materialized: string[][] = []
		const sends: string[] = []
		const queue = new FirstPromptQueue(path.join(directory, 'attachments.json'), {
			inspect: () => ({ phase: 'setting_up', sessionId: 'chat-attachments', alreadySent: false, worktree }),
			materialize: async (_workspaceId, _worktree, attachmentIds) => {
				materialized.push(attachmentIds)
				return { ok: true }
			},
			send: async (_workspaceId, _sessionId, text) => {
				sends.push(text)
				return { ok: true }
			}
		})

		void queue.enqueue('ws-attachments', 'hello', true, ['stage-1'])
		await flush(100)
		expect(materialized).toEqual([])
		expect(sends).toEqual([])

		worktree = '/tmp/new-worktree'
		await flush(900)
		expect(materialized).toEqual([['stage-1']])
		expect(sends).toEqual(['hello'])
	})

	test('charges a ready failure to the counted budget', async () => {
		const { queue, state } = scenario('ready-fail', { phase: 'ready' })
		void queue.enqueue('ws-5', 'hello')
		await flush()
		expect(state.sends).toEqual(['hello'])
		expect(queue.get('ws-5')).toMatchObject({ attempts: 1 })
		expect(queue.get('ws-5')?.earlyAttempts ?? 0).toBe(0)
		queue.forget('ws-5')
	})
})
