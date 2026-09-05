import { describe, expect, test } from 'vitest'
import { parseMessage } from '../../src/transcript/parser.ts'

describe('transcript tool details', () => {
	test('preserves a full multiline command while stripping the worktree prefix', () => {
		const worktree = '/Users/example/conductor/workspaces/project/krakow'
		const tail = `printf '%s\\n' '${'detail-'.repeat(32)}'`
		const command = `cd ${worktree} && rg -n "first" src\n${tail}`
		const content = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] }
		})

		const [entry] = parseMessage(
			{
				rowid: 1,
				id: 'message-1',
				role: 'assistant',
				content,
				full_message: null,
				created_at: '2026-08-31T00:00:00.000Z',
				sent_at: '2026-08-31T00:00:00.000Z',
				queue_order: null
			},
			worktree
		)

		expect(entry).toBeDefined()
		expect(entry?.role).toBe('tool')
		expect(entry?.text).toBe('Bash')
		expect(entry?.detail).toBe(`rg -n "first" src\n${tail}`)
		expect(entry?.detail?.length).toBeGreaterThan(160)
	})
})
