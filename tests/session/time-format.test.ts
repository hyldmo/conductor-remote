import { describe, expect, test } from 'vitest'
import { relativeAge, timeAgo, timestampMs } from '../../web/src/lib/format.ts'

/**
 * The label under a finished turn. Its one rule is the cut-off: under a week it is the
 * sidebar's own wording, from a week on it is a date. Both halves read as ordinary
 * English, so a wrong boundary looks exactly like a right one — and past it the shared
 * helper would start answering in months and years, which is not a time of day.
 */
describe('timeAgo', () => {
	const now = Date.parse('2026-09-01T12:00:00.000Z')
	const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now)
	const MINUTE = 60_000
	const HOUR = 60 * MINUTE
	const DAY = 24 * HOUR

	test('counts in words, in the units the sidebar uses', () => {
		expect(ago(0)).toBe('now')
		expect(ago(MINUTE)).toBe('1 minute ago')
		expect(ago(5 * MINUTE)).toBe('5 minutes ago')
		expect(ago(HOUR)).toBe('1 hour ago')
		expect(ago(23 * HOUR)).toBe('23 hours ago')
		expect(ago(DAY)).toBe('yesterday')
		expect(ago(6 * DAY)).toBe('6 days ago')
	})

	test('turns into a date at a week, not a day later', () => {
		expect(ago(7 * DAY - 1)).toBe('7 days ago')
		expect(ago(7 * DAY)).not.toMatch(/ago/)
		expect(ago(7 * DAY)).toMatch(/\d/)
	})

	test('carries the year only once it is a different one', () => {
		expect(ago(30 * DAY)).not.toMatch(/2026/)
		expect(ago(400 * DAY)).toMatch(/2025/)
	})

	// The relay's Mac and the phone need not agree, so a response can be stamped ahead
	// of this clock. Counting backwards from it would print "in 5 minutes".
	test('reads a stamp from the future as now', () => {
		expect(ago(-5 * MINUTE)).toBe('now')
	})

	test('says nothing for an unparseable stamp', () => {
		expect(timeAgo('not a date', now)).toBe('')
	})
})

describe('Conductor timestamps', () => {
	test('treats SQLite datetime values as UTC', () => {
		const sqlite = '2026-09-02 19:43:53'
		const utc = '2026-09-02T19:43:53.000Z'
		expect(timestampMs(sqlite)).toBe(Date.parse(utc))
		expect(relativeAge(sqlite, Date.parse(utc))).toBe('now')
	})

	test('preserves explicitly zoned timestamps', () => {
		expect(timestampMs('2026-09-02T21:43:53+02:00')).toBe(Date.parse('2026-09-02T19:43:53Z'))
	})
})
