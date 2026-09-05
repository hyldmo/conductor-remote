import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SessionPoller } from '../../src/reads/session-poller.ts'
import type { SessionState } from '../../src/reads/types.ts'

const state = (status: string): SessionState => ({
	sessionId: 'chat-1',
	workspaceId: 'workspace-1',
	status,
	updatedAt: '2026-09-04 00:00:00',
	turnStartedAt: null,
	lastUserMessageAt: null,
	workspaceTitle: 'Workspace',
	repoName: 'repo',
	sessionTitle: null
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
})

describe('shared session poller', () => {
	test('performs one base read and fans the same snapshot to every listener', () => {
		const read = vi.fn(() => [state('working')])
		const first = vi.fn()
		const second = vi.fn()
		const poller = new SessionPoller(read)
		poller.subscribe(first)
		poller.subscribe(second)

		poller.tick()

		expect(read).toHaveBeenCalledTimes(1)
		expect(first).toHaveBeenCalledWith(second.mock.calls[0][0])
	})

	test('keeps polling with zero listeners and after a listener throws', async () => {
		const read = vi.fn(() => [state('idle')])
		const poller = new SessionPoller(read, { intervalMs: 20 })
		poller.subscribe(() => {
			throw new Error('broken listener')
		})
		poller.start()

		await vi.advanceTimersByTimeAsync(45)
		expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)

		poller.stop()
		const stoppedAt = read.mock.calls.length
		await vi.advanceTimersByTimeAsync(40)
		expect(read).toHaveBeenCalledTimes(stoppedAt)
	})

	test('does not await slow listener work before a later tick', async () => {
		const read = vi.fn(() => [state('working')])
		let release: (() => void) | undefined
		const poller = new SessionPoller(read, { intervalMs: 20 })
		poller.subscribe(
			() =>
				new Promise<void>(resolve => {
					release = resolve
				})
		)
		poller.start()

		await vi.advanceTimersByTimeAsync(45)
		expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)
		release?.()
		poller.stop()
	})

	test('can remove one listener without affecting the shared clock', () => {
		const read = vi.fn(() => [state('idle')])
		const listener = vi.fn()
		const poller = new SessionPoller(read)
		const unsubscribe = poller.subscribe(listener)
		unsubscribe()

		poller.tick()
		expect(read).toHaveBeenCalledOnce()
		expect(listener).not.toHaveBeenCalled()
	})
})
