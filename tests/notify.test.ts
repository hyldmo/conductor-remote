import { describe, expect, test } from 'vitest'
import { isReading, noteViewing, TurnWatcher } from '../src/notify.ts'
import type { SessionState } from '../src/reads.ts'

function chat(
	status: string | null,
	turnStartedAt: string | null,
	sessionId = 'chat-1',
	lastUserMessageAt: string | null = turnStartedAt
): SessionState {
	return {
		sessionId,
		workspaceId: 'ws-1',
		status,
		turnStartedAt,
		lastUserMessageAt,
		workspaceTitle: 'Build photo window',
		repoName: 'auk',
		sessionTitle: 'Manage Chat Context'
	}
}

function fired(watcher: TurnWatcher, states: SessionState[]): string[] {
	return watcher.step(states).map(delivery => `${delivery.state.sessionId}:${delivery.kind}`)
}

const T1 = '2026-08-27T10:17:11.000Z'
const T2 = '2026-08-27T10:41:30.000Z'

describe('turn watcher', () => {
	test('uses its first poll as a baseline and never announces unchanged idle chats', () => {
		const watcher = new TurnWatcher()
		expect(fired(watcher, [chat('idle', T1)])).toEqual([])
		expect(fired(watcher, [chat('idle', T1)])).toEqual([])
	})

	test('announces a completed turn once its idle state is confirmed', () => {
		const watcher = new TurnWatcher()
		expect(fired(watcher, [chat('working', T1)])).toEqual([])
		expect(fired(watcher, [chat('working', T1)])).toEqual([])
		expect(fired(watcher, [chat('idle', T1)])).toEqual([])
		expect(fired(watcher, [chat('idle', T1)])).toEqual(['chat-1:done'])
	})

	test.each(['needs_plan_response', 'needs_user_input'])('announces confirmed %s turns', status => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		expect(fired(watcher, [chat(status, T1)])).toEqual([])
		expect(fired(watcher, [chat(status, T1)])).toEqual(['chat-1:done'])
	})

	test('does not announce an idle state that flickers back to working', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		expect(fired(watcher, [chat('working', T1)])).toEqual([])
	})

	test('announces the requested turn but keeps self-started loop laps quiet', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		expect(fired(watcher, [chat('idle', T1)])).toEqual(['chat-1:done'])

		for (let lap = 0; lap < 5; lap++) {
			fired(watcher, [chat('working', T1)])
			fired(watcher, [chat('idle', T1)])
			expect(fired(watcher, [chat('idle', T1)])).toEqual([])
		}

		fired(watcher, [chat('working', T2)])
		fired(watcher, [chat('idle', T2)])
		expect(fired(watcher, [chat('idle', T2)])).toEqual(['chat-1:done'])
	})

	test('announces a human steering message inside a running loop', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		fired(watcher, [chat('idle', T1)])
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1, 'chat-1', T2)])
		expect(fired(watcher, [chat('idle', T1, 'chat-1', T2)])).toEqual(['chat-1:done'])

		fired(watcher, [chat('working', T1, 'chat-1', T2)])
		fired(watcher, [chat('idle', T1, 'chat-1', T2)])
		expect(fired(watcher, [chat('idle', T1, 'chat-1', T2)])).toEqual([])
	})

	test('always announces an error, including in a self-started lap', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		fired(watcher, [chat('idle', T1)])
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('error', T1)])
		expect(fired(watcher, [chat('error', T1)])).toEqual(['chat-1:error'])
	})

	test('announces every completion when legacy chats have no turn timestamp', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('idle', null)])
		for (let turn = 0; turn < 3; turn++) {
			fired(watcher, [chat('working', null)])
			fired(watcher, [chat('idle', null)])
			expect(fired(watcher, [chat('idle', null)])).toEqual(['chat-1:done'])
		}
	})

	test('starts from a new baseline after reset', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		fired(watcher, [chat('idle', T1)])
		watcher.reset()
		expect(fired(watcher, [chat('idle', T1)])).toEqual([])
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		expect(fired(watcher, [chat('idle', T1)])).toEqual(['chat-1:done'])
	})

	test('drops a pending notification when its chat is archived', () => {
		const watcher = new TurnWatcher()
		fired(watcher, [chat('working', T1)])
		fired(watcher, [chat('idle', T1)])
		expect(fired(watcher, [])).toEqual([])
		expect(fired(watcher, [chat('idle', T1)])).toEqual([])
	})

	test('tracks loop suppression independently for each chat', () => {
		const watcher = new TurnWatcher()
		const both = (status: string, yoursTurn: string) => [chat(status, T1, 'looper'), chat(status, yoursTurn, 'yours')]
		fired(watcher, both('working', T1))
		fired(watcher, both('idle', T1))
		fired(watcher, both('idle', T1))
		fired(watcher, both('working', T1))
		fired(watcher, both('idle', T1))
		const notifications = fired(watcher, [chat('idle', T1, 'looper'), chat('idle', T2, 'yours')])
		expect(notifications).not.toContain('looper:done')
		expect(notifications).toContain('yours:done')
	})
})

/**
 * The other rule about not buzzing a phone: the chat you are reading right now. Both
 * ways of getting the window wrong are silent. Too long and a phone put down mid-turn
 * never hears the turn end, which looks exactly like a notifier that has stopped; too
 * short and the suppression simply never fires, which nobody reports either.
 */
describe('reading claims', () => {
	const AT = 1_772_000_000_000

	test('covers only the chat that device has on screen', () => {
		noteViewing('device-a', 'chat-1')
		expect(isReading('device-a', 'chat-1')).toBe(true)
		expect(isReading('device-a', 'chat-2')).toBe(false)
	})

	test('leaves every other device alone', () => {
		noteViewing('device-a', 'chat-1')
		expect(isReading('device-b', 'chat-1')).toBe(false)
	})

	test('expires once the poll that refreshes it has stopped', () => {
		noteViewing('device-c', 'chat-1')
		expect(isReading('device-c', 'chat-1', Date.now() + 9_000)).toBe(true)
		expect(isReading('device-c', 'chat-1', Date.now() + 30_000)).toBe(false)
	})

	test('moves with the reader rather than accumulating chats', () => {
		noteViewing('device-d', 'chat-1')
		noteViewing('device-d', 'chat-2')
		expect(isReading('device-d', 'chat-1')).toBe(false)
		expect(isReading('device-d', 'chat-2')).toBe(true)
	})

	test('never claims a chat for a device that has not polled', () => {
		expect(isReading('device-never', 'chat-1', AT)).toBe(false)
	})
})
