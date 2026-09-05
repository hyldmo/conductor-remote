import { describe, expect, test } from 'vitest'
import { OFFLINE_GRACE_MS, offlineDelay } from '../../web/src/lib/online.ts'

describe('offline delay', () => {
	const now = 1_000_000

	test('keeps the banner hidden for ten seconds after a failure', () => {
		expect(OFFLINE_GRACE_MS).toBe(10_000)
		expect(offlineDelay(null, now)).toBe(10_000)
	})

	test('uses the last successful request to calculate the remaining grace period', () => {
		expect(offlineDelay(now - 3_000, now)).toBe(7_000)
		expect(offlineDelay(now - 12_000, now)).toBe(0)
	})
})
