import { describe, expect, test } from 'vitest'
import { SETTABLE_STATUSES, STATUS_COLORS, statusDot } from '../web/src/lib/format.ts'
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

describe('Conductor lifecycle status palette', () => {
	test("keeps Conductor's settable status list", () => {
		expect(SETTABLE_STATUSES).toEqual(['backlog', 'in-progress', 'in-review', 'done', 'canceled'])
	})

	test('reuses the corresponding workspace-dot colors', () => {
		expect(STATUS_COLORS).toMatchObject({
			'in-progress': 'var(--color-done)',
			'in-review': 'var(--color-pr-mergeable)',
			done: 'var(--color-pr-merged)'
		})
	})

	test('leaves backlog and canceled unmapped so their existing glyph stays hollow', () => {
		expect(STATUS_COLORS.backlog).toBeUndefined()
		expect(STATUS_COLORS.canceled).toBeUndefined()
	})
})
