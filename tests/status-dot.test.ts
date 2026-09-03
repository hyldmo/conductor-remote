import { describe, expect, test } from 'vitest'
import { statusDot } from '../web/src/lib/format.ts'
import type { Workspace } from '../web/src/lib/types.ts'

function workspace(pr_status: Workspace['pr_status'], session_status: Workspace['session_status'] = 'idle'): Workspace {
	return { pr_status, session_status } as Workspace
}

describe('workspace status dot', () => {
	test('draws running checks as an amber spinner', () => {
		expect(statusDot(workspace('checks_pending'))).toEqual({
			color: 'var(--color-working)',
			spinning: true
		})
	})

	test.each(['checks_failed', 'conflicts'] as const)('draws %s as a solid attention dot', prStatus => {
		expect(statusDot(workspace(prStatus))).toEqual({
			color: 'var(--color-pr-attention)',
			spinning: false
		})
	})

	test('keeps spinning for an active agent regardless of PR state', () => {
		expect(statusDot(workspace('mergeable', 'working'))).toEqual({
			color: 'var(--color-pr-mergeable)',
			spinning: true
		})
	})
})
