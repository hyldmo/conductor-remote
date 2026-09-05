import { describe, expect, test } from 'vitest'
import { createTools } from '../../src/mcp/registry.ts'
import type { RelayCall } from '../../src/mcp/types.ts'
import { foldHits, type SearchHit } from '../../src/search/coordinator.ts'
import { chatCursor, parseChatCursor } from '../../src/transcript/cursor.ts'
import type { TranscriptEntry } from '../../src/transcript/parser.ts'

function tool(name: string, call: RelayCall) {
	const found = createTools(call).find(candidate => candidate.name === name)
	if (!found) throw new Error(`${name} does not exist`)
	return found
}

function entry(rowid: number, role: TranscriptEntry['role'], text: string): TranscriptEntry {
	return { id: `entry-${rowid}-${role}`, rowid, role, text, ts: '2026-08-31T00:00:00Z', queued: false }
}

describe('MCP chat cursors', () => {
	test('round-trips opaque cursors and rejects raw row IDs', () => {
		expect(parseChatCursor(chatCursor(987_654))).toBe(987_654)
		expect(parseChatCursor('987654')).toBeNull()
	})

	test('keeps each search hit cursor through grouping and formatting', async () => {
		const hits: SearchHit[] = [
			{
				sessionId: 'chat-a',
				srcRowid: 20,
				role: 'assistant',
				at: '2026-08-31T00:00:00Z',
				score: 10,
				snippet: 'first hit'
			},
			{
				sessionId: 'chat-b',
				srcRowid: 40,
				role: 'user',
				at: '2026-08-30T00:00:00Z',
				score: 9,
				snippet: 'second hit'
			}
		]
		const folded = foldHits(hits, () => ({ id: 'workspace-1' }))
		expect(folded[0]?.snippets.map(snippet => [snippet.sessionId, snippet.cursor])).toEqual([
			['chat-a', chatCursor(20)],
			['chat-b', chatCursor(40)]
		])

		const response = {
			query: 'hit',
			index: { chunks: 2, ready: true, progress: 1 },
			results: [
				{
					...folded[0],
					workspace: {
						id: 'workspace-1',
						workspace_name: 'Cursor workspace',
						pr_title: null,
						branch: 'feat/cursors',
						directory_name: 'cursor-v1',
						repo_name: 'conductor-remote',
						state: 'ready',
						archived: false
					},
					sessionTitle: 'Cursor chat'
				}
			]
		}
		const search = tool('search_chats', async <T>() => response as T)
		const output = await search.run({ query: 'hit' })
		expect(output).toContain(`session_id: chat-a  cursor: ${chatCursor(20)}`)
		expect(output).toContain(`session_id: chat-b  cursor: ${chatCursor(40)}`)
	})

	test('reads independently bounded windows around a cursor', async () => {
		const transcript = [
			entry(10, 'user', 'ten'),
			entry(20, 'assistant', 'twenty'),
			entry(30, 'assistant', 'thirty'),
			entry(40, 'user', 'forty'),
			entry(50, 'assistant', 'fifty')
		]
		const read = tool('read_chat', async <T>() => ({ entries: transcript, cursor: 50 }) as T)

		const nearby = await read.run({ session_id: 'chat-a', near: chatCursor(30), before: 1, after: 1 })
		expect(nearby).not.toMatch(/ten|fifty/)
		expect(nearby).toMatch(/twenty[\s\S]*thirty[\s\S]*forty/)
		expect(nearby).toContain(`older_cursor: ${chatCursor(20)}`)
		expect(nearby).toContain(`newer_cursor: ${chatCursor(40)}`)

		const older = await read.run({ session_id: 'chat-a', near: chatCursor(30), before: 2, after: 0 })
		expect(older).toMatch(/ten[\s\S]*twenty[\s\S]*thirty/)
		expect(older).not.toMatch(/forty|fifty/)

		const newer = await read.run({ session_id: 'chat-a', near: chatCursor(30), before: 0, after: 2 })
		expect(newer).not.toMatch(/ten|twenty/)
		expect(newer).toMatch(/thirty[\s\S]*forty[\s\S]*fifty/)
		await expect(read.run({ session_id: 'chat-a', near: chatCursor(999) })).rejects.toThrow(
			'near cursor is not in that session'
		)
	})

	test('honors the formatted output character budget', async () => {
		const transcript = [
			entry(10, 'user', 'a'.repeat(10_000)),
			entry(20, 'assistant', 'b'.repeat(10_000)),
			entry(30, 'user', 'c'.repeat(10_000))
		]
		const read = tool('read_chat', async <T>() => ({ entries: transcript, cursor: 30 }) as T)
		const output = await read.run({
			session_id: 'chat-a',
			near: chatCursor(20),
			before: 1,
			after: 1,
			max_chars: 1_000
		})
		expect(output.length).toBeLessThanOrEqual(1_000)
		expect(output).toMatch(/\[user\] a+/)
		expect(output).toMatch(/\[assistant\] b+/)
		expect(output).toMatch(/\[user\] c+/)
	})
})
