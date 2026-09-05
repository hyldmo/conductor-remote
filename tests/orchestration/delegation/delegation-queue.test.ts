import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DelegationQueue, transitionDelegation } from '../../../src/orchestration/delegation/queue.ts'
import { delegationReturnText } from '../../../src/orchestration/delegation/return.ts'
import { DelegationStore } from '../../../src/orchestration/delegation/store.ts'
import type {
	DelegationActionError,
	DelegationQueueDeps,
	PersistedDelegation
} from '../../../src/orchestration/delegation/types.ts'

const temporaryDirs: string[] = []

function store(): DelegationStore {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-delegation-queue-'))
	temporaryDirs.push(worktree)
	return new DelegationStore(worktree)
}

function job(overrides: Partial<PersistedDelegation> = {}): PersistedDelegation {
	return {
		version: 1,
		id: 'job-1',
		workspaceId: 'workspace-1',
		parentSessionId: 'parent-1',
		role: 'exploration',
		resolvedRole: { model: '5.6 Terra', agentType: 'codex', effort: 'high', fast: false },
		prompt: 'Inspect the queue contract.',
		returnMode: 'queue',
		includeThinking: true,
		status: 'queued',
		attempts: 0,
		createdAt: 100,
		updatedAt: 100,
		...overrides
	}
}

const handoff = {
	name: 'Transcript.md',
	path: '.context/attachments/ABC123/Transcript.md',
	bytes: 120,
	token: '@⟦Transcript.md⟧(.context%2Fattachments%2FABC123%2FTranscript.md)'
}

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('delegation transitions', () => {
	test('accepts the complete legal path and rejects skipped or terminal edges', () => {
		const opening = transitionDelegation(job(), 'opening', {}, 101)
		const configuring = transitionDelegation(opening, 'configuring', { childSessionId: 'child-1', handoff }, 102)
		const sending = transitionDelegation(configuring, 'sending', {}, 103)
		const running = transitionDelegation(sending, 'running', { sentRowid: 20 }, 104)
		const returning = transitionDelegation(
			running,
			'returning',
			{ outcome: { kind: 'success', assistantRowid: 30, text: '## Baton\nDone' }, completionRowid: 30 },
			105
		)
		const returned = transitionDelegation(returning, 'returned', { returnRowid: 40 }, 106)

		expect(returned).toMatchObject({ status: 'returned', childSessionId: 'child-1', sentRowid: 20, returnRowid: 40 })
		expect(() => transitionDelegation(job(), 'running', { childSessionId: 'child-1', sentRowid: 20 }, 101)).toThrow(
			/queued.*running/
		)
		expect(() => transitionDelegation(returned, 'failed', {}, 107)).toThrow(/returned.*failed/)
	})

	test('requires a typed failure on every edge to failed', () => {
		expect(() => transitionDelegation(job(), 'failed', {}, 101)).toThrow(/failure/)
		expect(
			transitionDelegation(
				job(),
				'failed',
				{ failure: { code: 'opening_failed', message: 'no tab', retryable: false } },
				101
			)
		).toMatchObject({ status: 'failed', failure: { code: 'opening_failed' } })
	})
})

describe('delegation queue', () => {
	test('runs intake through a stable completion and queued return, retaining role identity', async () => {
		const persisted = store()
		const calls: string[] = []
		let completion: {
			outcome: { kind: 'success'; assistantRowid: number; text: string }
			completionRowid: number
		} | null = null
		const queue = new DelegationQueue({
			open: async () => {
				calls.push('open')
				return { ok: true, childSessionId: 'child-1', handoff }
			},
			configure: async current => {
				calls.push(`configure:${current.resolvedRole.model}:${String(Object.hasOwn(current.resolvedRole, 'plan'))}`)
				return { ok: true }
			},
			send: async () => {
				calls.push('send')
				return { ok: true, sentRowid: 20 }
			},
			completion: () => completion,
			returnResult: async current => {
				calls.push(`return:${current.returnMode}:${current.outcome?.kind}`)
				return { ok: true, returnRowid: 40 }
			}
		})

		queue.enqueue(persisted, job())
		await queue.wake()
		expect(persisted.list().jobs[0]).toMatchObject({ status: 'running', childSessionId: 'child-1', sentRowid: 20 })
		expect(calls).toEqual(['open', 'configure:5.6 Terra:false', 'send'])

		completion = { outcome: { kind: 'success', assistantRowid: 30, text: '## Baton\nDone' }, completionRowid: 30 }
		await queue.wake()
		expect(persisted.list().jobs[0]?.status).toBe('running')
		await queue.wake()

		expect(calls).toEqual(['open', 'configure:5.6 Terra:false', 'send', 'return:queue:success'])
		expect(persisted.list().jobs).toEqual([])
		expect(persisted.sessionRoles().sessions).toMatchObject({
			'child-1': { role: 'exploration', delegationId: 'job-1', parentSessionId: 'parent-1' }
		})
		expect(persisted.sessionRoles().sessions).not.toHaveProperty('parent-1')
	})

	test('does not charge a blocked action and fails visibly after three real attempts', async () => {
		const persisted = store()
		let now = 100
		let blocked = true
		const failure: DelegationActionError = { ok: false, code: 'opening_failed', error: 'no tab', blocked }
		const open = vi.fn(async () => ({ ...failure, blocked }))
		const queue = new DelegationQueue(
			{
				open,
				configure: async () => ({ ok: true }),
				send: async () => ({ ok: true, sentRowid: 20 }),
				completion: () => null,
				returnResult: async () => ({ ok: true, returnRowid: 40 })
			},
			{ now: () => now, retryDelayMs: 5 }
		)

		queue.enqueue(persisted, job({ createdAt: now, updatedAt: now }))
		await queue.wake()
		expect(persisted.list().jobs[0]).toMatchObject({ status: 'opening', attempts: 0 })

		blocked = false
		for (let attempt = 1; attempt <= 3; attempt++) {
			now += 5
			await queue.wake()
			const current = persisted.list().jobs[0]
			if (attempt < 3) expect(current).toMatchObject({ status: 'opening', attempts: attempt })
			else expect(current).toMatchObject({ status: 'failed', attempts: 3, failure: { code: 'opening_failed' } })
		}
	})

	test('fails a non-retryable opening error without opening another chat', async () => {
		const persisted = store()
		const open = vi.fn(async () => ({
			ok: false as const,
			code: 'opening_failed' as const,
			error: 'more than one new chat appeared',
			retryable: false
		}))
		const queue = new DelegationQueue({
			open,
			configure: async () => ({ ok: true }),
			send: async () => ({ ok: true, sentRowid: 20 }),
			completion: () => null,
			returnResult: async () => ({ ok: true, returnRowid: 40 })
		})

		queue.enqueue(persisted, job())
		await queue.wake()

		expect(open).toHaveBeenCalledTimes(1)
		expect(persisted.list().jobs[0]).toMatchObject({
			status: 'failed',
			attempts: 1,
			failure: { code: 'opening_failed', retryable: false }
		})
	})

	test('turns thrown stage errors into bounded visible failures', async () => {
		const persisted = store()
		const open = vi.fn(async () => {
			throw new Error('actuator exploded')
		})
		const queue = new DelegationQueue(
			{
				open,
				configure: async () => ({ ok: true }),
				send: async () => ({ ok: true, sentRowid: 20 }),
				completion: () => null,
				returnResult: async () => ({ ok: true, returnRowid: 40 })
			},
			{ retryDelayMs: 0, maxAttempts: 1 }
		)

		queue.enqueue(persisted, job())
		await expect(queue.wake()).resolves.toBeUndefined()
		expect(open).toHaveBeenCalledTimes(1)
		expect(persisted.list().jobs[0]).toMatchObject({
			status: 'failed',
			attempts: 1,
			failure: { code: 'opening_failed', message: 'actuator exploded', retryable: true }
		})
	})

	test('does not charge a thrown error classified as temporarily blocked', async () => {
		const persisted = store()
		const busy = new Error('UI queue full')
		const open = vi.fn(async () => {
			throw busy
		})
		const queue = new DelegationQueue(
			{
				open,
				configure: async () => ({ ok: true }),
				send: async () => ({ ok: true, sentRowid: 20 }),
				completion: () => null,
				returnResult: async () => ({ ok: true, returnRowid: 40 })
			},
			{ blockedError: error => error === busy }
		)

		queue.enqueue(persisted, job())
		await queue.wake()
		expect(persisted.list().jobs[0]).toMatchObject({ status: 'opening', attempts: 0 })
	})

	test.each(['legacy', 'report'])('keeps a queued %s return through restart without resending it', async format => {
		const persisted = store()
		let receipt = false
		let dispatches = 0
		const returnText =
			format === 'legacy'
				? '## Baton\nDone'
				: delegationReturnText(
						job({ childSessionId: 'child-1', outcome: { kind: 'success', assistantRowid: 30, text: 'Done' } }),
						handoff
					)
		const deps: DelegationQueueDeps = {
			open: async () => ({ ok: true, childSessionId: 'child-1', handoff }),
			configure: async () => ({ ok: true }),
			send: async () => ({ ok: true, sentRowid: 20 }),
			completion: () => ({
				outcome: { kind: 'success', assistantRowid: 30, text: '## Baton\nDone' },
				completionRowid: 30
			}),
			returnResult: async current => {
				if (current.returnCursor === undefined) {
					dispatches++
					return { ok: true, pending: true, returnCursor: 12, returnAttachment: handoff, returnText }
				}
				return receipt
					? { ok: true, returnRowid: 40 }
					: {
							ok: true,
							pending: true,
							returnCursor: current.returnCursor,
							returnAttachment: current.returnAttachment ?? handoff,
							returnText: current.returnText ?? returnText
						}
			}
		}
		let queue = new DelegationQueue(deps)

		queue.enqueue(persisted, job())
		await queue.wake()
		await queue.wake()
		await queue.wake()
		expect(dispatches).toBe(1)
		expect(persisted.list().jobs[0]).toMatchObject({ status: 'returning', returnCursor: 12 })

		queue = new DelegationQueue(deps)
		queue.resume([persisted])
		await queue.wake()
		expect(dispatches).toBe(1)
		expect(persisted.list().jobs[0]).toMatchObject({ returnText, returnAttachment: handoff, returnCursor: 12 })

		receipt = true
		await queue.wake()
		expect(dispatches).toBe(1)
		expect(persisted.list().jobs).toEqual([])
	})
})
