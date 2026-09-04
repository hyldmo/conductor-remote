import { beforeEach, describe, expect, test } from 'vitest'
import {
	isUnconfirmed,
	loadPending,
	loadWorkflowClientAttempts,
	type PendingMessage,
	pendingMatchesTranscript,
	promptIndicator,
	workflowStartFingerprint,
	writePending,
	writeWorkflowClientAttempts
} from '../web/src/lib/pending.ts'

/**
 * The optimistic-prompt store (web/src/lib/pending.ts), which since the composer
 * clears its draft at send time holds the only copy of what someone typed until the
 * relay confirms it. Both failure modes are silent and cost the text:
 *
 * - restore too little and a reload (or iOS discarding the backgrounded PWA, which
 *   is the one that happens) throws away the prompt that failed — the bug this was
 *   written for;
 * - restore a `sending` entry as-is and the bubble spins against a request that died
 *   with the page, so the one bubble carrying a Retry button never offers it.
 *
 * localStorage is stubbed rather than mocked away: the parsing and the pruning are
 * the parts that see other builds' data.
 */
const KEY = 'conductor-remote-pending'
const DAY = 24 * 60 * 60 * 1000

function stubStorage(): Map<string, string> {
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, String(value)),
			removeItem: (key: string) => void store.delete(key)
		}
	})
	return store
}

const message = (over: Partial<PendingMessage> = {}): PendingMessage => ({
	id: 'a1',
	sessionId: 's1',
	workspaceId: 'w1',
	text: 'ship the thing',
	status: 'error',
	error: 'Send failed',
	createdAt: Date.now(),
	...over
})

let store: Map<string, string>
beforeEach(() => {
	store = stubStorage()
})

describe('pending prompts across a reload', () => {
	test('a failed prompt comes back whole, Retry and all', () => {
		const failed = message()
		writePending([failed])
		expect(loadPending()).toEqual([failed])
	})

	test('preserves Workflow intent and reconciles its wrapped transcript row after a reload', () => {
		const workflow = message({ workflow: true, status: 'sending', error: undefined })
		writePending([workflow])
		const [restored] = loadPending()

		expect(restored.workflow).toBe(true)
		expect(
			pendingMatchesTranscript(restored, 'Workflow mode is enabled.\n\n## Workflow objective\n\nship the thing')
		).toBe(true)
		expect(pendingMatchesTranscript(message(), '## Workflow objective\n\nship the thing')).toBe(false)
	})

	test('a send caught in flight comes back failed, never still spinning', () => {
		writePending([message({ status: 'sending', error: undefined })])
		const [restored] = loadPending()
		expect(restored.status).toBe('error')
		expect(restored.interrupted).toBe(true)
		expect(restored.error).toBeTruthy()
		// Same id, so Retry is answered by the relay's memo if the prompt did land.
		expect(restored.id).toBe('a1')
		expect(restored.text).toBe('ship the thing')
	})

	test('only an unwatched send defers to the transcript', () => {
		expect(isUnconfirmed(message({ status: 'sending' }))).toBe(true)
		expect(isUnconfirmed(message({ interrupted: true }))).toBe(true)
		// A failure the app saw happen stands on its own: an identical prompt earlier in
		// the chat must never retire it.
		expect(isUnconfirmed(message())).toBe(false)
	})

	test('a prompt older than a day is not resurrected', () => {
		writePending([message({ createdAt: Date.now() - DAY - 1000 }), message({ id: 'a2' })])
		expect(loadPending().map(p => p.id)).toEqual(['a2'])
	})

	test('dismissing the last bubble clears the key rather than leaving []', () => {
		writePending([message()])
		writePending([])
		expect(store.has(KEY)).toBe(false)
		expect(loadPending()).toEqual([])
	})

	test('another build’s data is dropped, not thrown', () => {
		store.set(KEY, '{"not":"an array"}')
		expect(loadPending()).toEqual([])
		store.set(KEY, 'not json at all')
		expect(loadPending()).toEqual([])
		store.set(KEY, JSON.stringify([{ id: 'half-a-row' }, message()]))
		expect(loadPending().map(p => p.id)).toEqual(['a1'])
		expect(loadPending()[0].text).toBe('ship the thing')
	})
})

describe('pending prompt indicator', () => {
	test('starts spinning as soon as either send queue owns the prompt', () => {
		expect(promptIndicator([message({ status: 'sending' })])).toBe('sending')
		expect(promptIndicator([], [{ text: 'ship the thing', status: 'waiting' }])).toBe('sending')
		expect(promptIndicator([], [], true)).toBe('sending')
	})

	test('keeps a failed prompt visible over other send activity', () => {
		expect(promptIndicator([message({ status: 'sending' }), message({ id: 'a2' })])).toBe('failed')
		expect(
			promptIndicator(
				[],
				[
					{ text: 'one', status: 'waiting' },
					{ text: 'two', status: 'failed' }
				]
			)
		).toBe('failed')
	})

	test('a Retry owns its stale relay failure and starts spinning immediately', () => {
		expect(promptIndicator([message({ status: 'sending' })], [{ text: 'ship the thing', status: 'failed' }])).toBe(
			'sending'
		)
		// A different failed prompt remains actionable.
		expect(promptIndicator([message({ status: 'sending' })], [{ text: 'another prompt', status: 'failed' }])).toBe(
			'failed'
		)
	})

	test('has no override when there is no pending prompt', () => {
		expect(promptIndicator([])).toBeNull()
	})
})

describe('Workflow start identities', () => {
	test('fingerprints the tagged target and persists an uncertain client id', () => {
		const target = {
			kind: 'existing_session' as const,
			workspaceId: 'w1',
			sessionId: 's1'
		}
		const fingerprint = workflowStartFingerprint('Ship it.', target)
		const attempt = { key: 'workflow:existing:w1:s1', fingerprint, clientId: 'client-1', createdAt: Date.now() }

		writeWorkflowClientAttempts({ [attempt.key]: attempt })
		expect(loadWorkflowClientAttempts()).toEqual({ [attempt.key]: attempt })
		expect(workflowStartFingerprint('Ship it.', target)).toBe(fingerprint)
		expect(workflowStartFingerprint('Ship something else.', target)).not.toBe(fingerprint)
	})
})
