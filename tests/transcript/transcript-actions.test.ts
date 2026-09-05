import { describe, expect, test } from 'vitest'
import { assistantTurnEnds, latestAssistantForActions, turnOrigin } from '../../web/src/lib/transcript/actions.ts'
import type { TranscriptEntry } from '../../web/src/lib/types.ts'

function entry(
	role: TranscriptEntry['role'],
	id: string,
	rowid: number,
	ts = '2026-08-31T00:00:00.000Z'
): TranscriptEntry {
	return { id, rowid, role, text: id, ts, queued: false }
}

describe('latest assistant action target', () => {
	const previous = entry('assistant', 'previous', 1)
	const user = entry('user', 'question', 2)
	const answer = entry('assistant', 'answer', 3)

	test('keeps actions after trailing tools and a capacity notice', () => {
		expect(
			latestAssistantForActions([
				previous,
				user,
				answer,
				entry('thinking', 'reasoning', 4),
				entry('tool', 'bash', 5),
				entry('system', 'Selected model is at capacity', 6)
			])
		).toBe(answer)
	})

	test('does not reuse the previous turn after a new user prompt', () => {
		expect(
			latestAssistantForActions([
				previous,
				user,
				entry('tool', 'work without a response', 3),
				entry('system', 'aborted', 4)
			])
		).toBeNull()
	})

	test('finds a direct latest response', () => {
		expect(latestAssistantForActions([user, answer])).toBe(answer)
	})

	test('returns no target without an assistant response', () => {
		expect(latestAssistantForActions([entry('system', 'notice', 1)])).toBeNull()
	})
})

describe('per-turn action targets', () => {
	test('offers one cut per turn, at the answer that closed it', () => {
		const first = entry('assistant', 'first answer', 3)
		const second = entry('assistant', 'second answer', 8)
		expect(
			assistantTurnEnds([
				entry('user', 'ask', 1),
				entry('thinking', 'reasoning', 2),
				first,
				entry('user', 'ask again', 4),
				entry('tool', 'bash', 5),
				entry('assistant', 'an update mid-turn', 6),
				entry('tool', 'more work', 7),
				second
			])
		).toEqual([first, second])
	})

	// The turn is unanswered, so its own cut does not exist yet — the previous answer
	// keeps the one it already offered rather than the control vanishing under it.
	test('keeps the last closed turn when a new prompt is waiting', () => {
		const answer = entry('assistant', 'answer', 2)
		expect(assistantTurnEnds([entry('user', 'ask', 1), answer, entry('user', 'ask again', 3)])).toEqual([answer])
	})

	test('has no target in a chat the agent has not answered', () => {
		expect(assistantTurnEnds([entry('user', 'ask', 1), entry('tool', 'bash', 2)])).toEqual([])
	})
})

/**
 * What the finished turn's duration is measured from. Current rows use `turn_id` and
 * older rows use `queue_order` behind `turn_started_at`; the transcript remains the
 * fallback for rows carrying neither. A duration measured from the wrong end is a
 * plausible-looking number rather than a visible failure.
 */
describe('turn origin', () => {
	const asked = entry('user', 'question', 1, '2026-09-01T12:00:00.000Z')
	const answer = entry('assistant', 'answer', 2, '2026-09-01T12:02:00.000Z')

	test('prefers the dispatch that precedes the response', () => {
		expect(turnOrigin([asked, answer], answer, '2026-09-01T12:00:30.000Z')).toBe('2026-09-01T12:00:30.000Z')
	})

	test('falls back to the user row when no turn was dispatched', () => {
		expect(turnOrigin([asked, answer], answer, null)).toBe(asked.ts)
	})

	test('ignores a dispatch belonging to a newer turn', () => {
		expect(turnOrigin([asked, answer], answer, '2026-09-01T12:05:00.000Z')).toBe(asked.ts)
	})

	test('skips the rows after the response to find its own question', () => {
		const older = entry('user', 'older', 0, '2026-09-01T11:00:00.000Z')
		const trailing = entry('user', 'next', 3, '2026-09-01T12:09:00.000Z')
		expect(turnOrigin([older, asked, answer, trailing], answer, null)).toBe(asked.ts)
	})

	test('has nothing to measure from in a chat that opens with a response', () => {
		expect(turnOrigin([answer], answer, null)).toBeNull()
	})
})
