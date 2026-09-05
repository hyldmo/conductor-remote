import { describe, expect, test } from 'vitest'
import { MAX_SECONDS } from '../../src/host/nosleep.ts'
import { parseDurationSeconds } from '../../src/shared.ts'

describe('keep-awake duration parser', () => {
	test.each([
		['80h', 288_000],
		['90m', 5_400],
		['30s', 30],
		['3600', 3_600],
		[' 2h ', 7_200]
	])('parses %s with the CLI grammar', (value, expected) => {
		expect(parseDurationSeconds(value)).toBe(expected)
	})

	test.each(['', '1d', '2.5h', '-2h', 'later'])('rejects an invalid duration: %s', value => {
		expect(parseDurationSeconds(value)).toBeNull()
	})

	test('lets the relay hold an 80-hour weekend while retaining a finite ceiling', () => {
		expect(MAX_SECONDS).toBe(7 * 24 * 3600)
		expect(parseDurationSeconds('80h')).toBeLessThanOrEqual(MAX_SECONDS)
	})
})
