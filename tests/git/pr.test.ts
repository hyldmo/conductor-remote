import { describe, expect, test } from 'vitest'
import { hasFailedChecks, hasPendingChecks } from '../../src/git/pr.ts'

describe('pull request check failures', () => {
	test('does not flag missing, successful, neutral, skipped, or pending checks', () => {
		expect(hasFailedChecks(null)).toBe(false)
		expect(hasFailedChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'NEUTRAL' }, { conclusion: 'SKIPPED' }])).toBe(
			false
		)
		expect(hasFailedChecks([{ state: 'PENDING' }])).toBe(false)
	})

	test.each([
		{ conclusion: 'FAILURE' },
		{ conclusion: 'TIMED_OUT' },
		{ state: 'FAILURE' },
		{ state: 'ERROR' }
	])('flags a failed check result: %j', result => {
		expect(hasFailedChecks([result])).toBe(true)
	})
})

describe('pull request checks still running', () => {
	test('does not flag a rollup with nothing left to run', () => {
		expect(hasPendingChecks(null)).toBe(false)
		expect(hasPendingChecks([])).toBe(false)
		expect(hasPendingChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe(false)
		expect(hasPendingChecks([{ state: 'SUCCESS' }, { state: 'FAILURE' }])).toBe(false)
	})

	// A check run reports progress in `status`, a legacy status context in `state`.
	// Read the wrong field and every PR reads mergeable the moment CI starts, which
	// is the state this marker exists for.
	test.each([
		{ status: 'QUEUED', conclusion: null },
		{ status: 'IN_PROGRESS', conclusion: null },
		{ status: 'WAITING', conclusion: null },
		{ state: 'PENDING' },
		{ state: 'EXPECTED' }
	])('flags a check that has not finished: %j', check => {
		expect(hasPendingChecks([check])).toBe(true)
	})

	test('one finished check does not hide the one still running', () => {
		expect(hasPendingChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe(true)
	})
})
