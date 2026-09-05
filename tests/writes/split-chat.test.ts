import { describe, expect, test } from 'vitest'
import { createTools } from '../../src/mcp/registry.ts'
import type { RelayCall } from '../../src/mcp/types.ts'
import { routes } from '../../src/routes.ts'
import { chatCursor } from '../../src/transcript/cursor.ts'
import {
	renderTranscript,
	type TranscriptEntry,
	transcriptMessage,
	transcriptThrough
} from '../../src/transcript/parser.ts'

function entry(rowid: number, role: TranscriptEntry['role'], text: string): TranscriptEntry {
	return { id: `entry-${rowid}-${role}`, rowid, role, text, ts: '2026-09-01T00:00:00Z', queued: false }
}

const chat = [
	entry(10, 'user', 'the original question'),
	entry(20, 'thinking', 'why it might go this way'),
	entry(20, 'assistant', 'the answer'),
	entry(30, 'user', 'the tangent'),
	entry(40, 'assistant', 'the tangent answered')
]

function splitTool(seen: { body?: Record<string, unknown> }) {
	const call: RelayCall = async <T>(route: string, opts?: { body?: unknown }) => {
		if (route === routes.splitChat.path('chat-1')) {
			seen.body = opts?.body as Record<string, unknown>
			const destination = seen.body?.destination === 'workspace' ? 'workspace' : 'chat'
			return {
				ok: true,
				destination,
				sessionId: 'chat-2',
				workspaceId: destination === 'workspace' ? 'ws-2' : 'ws-1',
				text: 'Forked from @⟦x⟧(y)',
				attachment: {
					name: 'Transcript of chat.md',
					path: '.context/attachments/abc123/Transcript of chat.md',
					bytes: 2048,
					kept: 3,
					elided: { thinking: 0, tools: 4, earlier: 0, later: 2 }
				}
			} as T
		}
		return { ok: true } as T
	}
	const tool = createTools(call).find(candidate => candidate.name === 'split_chat')
	if (!tool) throw new Error('split_chat does not exist')
	return tool
}

describe('splitting a chat at an earlier message', () => {
	test('carries every entry of the cut row and counts what it left', () => {
		const cut = transcriptThrough(chat, 20)
		expect(cut?.entries.map(e => e.text)).toEqual(['the original question', 'why it might go this way', 'the answer'])
		expect(cut?.later).toBe(2)
	})

	test('copies the whole chat when the cut is its last message', () => {
		expect(transcriptThrough(chat, 40)).toEqual({ entries: chat, later: 0 })
	})

	// A cursor from another chat would otherwise cut at whatever rowid happened to be
	// smaller, and a transcript that stops early reads exactly like a complete one.
	test('refuses a rowid this chat does not have', () => {
		expect(transcriptThrough(chat, 25)).toBeNull()
		expect(transcriptThrough(chat, 999)).toBeNull()
	})

	test('sends the cursor to the relay as a row id', async () => {
		const seen: { body?: Record<string, unknown> } = {}
		await splitTool(seen).run({ session_id: 'chat-1', prompt: 'take it from here', through: chatCursor(20) })
		expect(seen.body?.throughRowid).toBe(20)
	})

	test('leaves the cut out of the request when nobody asked for one', async () => {
		const seen: { body?: Record<string, unknown> } = {}
		await splitTool(seen).run({ session_id: 'chat-1', prompt: 'take it from here' })
		expect(seen.body?.throughRowid).toBeUndefined()
		expect(seen.body?.destination).toBe('chat')
	})

	test('can carry the same transcript into a workspace with the current code', async () => {
		const seen: { body?: Record<string, unknown> } = {}
		const output = await splitTool(seen).run({
			session_id: 'chat-1',
			prompt: 'take it from here',
			new_workspace: true
		})
		expect(seen.body?.destination).toBe('workspace')
		expect(output).toContain('workspace_id: ws-2')
		expect(output).toContain('current code carried across')
	})

	test('rejects a raw row id in place of a cursor', async () => {
		const seen: { body?: Record<string, unknown> } = {}
		await expect(
			splitTool(seen).run({ session_id: 'chat-1', prompt: 'take it from here', through: '20' })
		).rejects.toThrow(/cursor/)
		expect(seen.body).toBeUndefined()
	})

	test('names the entries the cut left behind', async () => {
		const output = await splitTool({}).run({ session_id: 'chat-1', prompt: 'take it from here' })
		expect(output).toContain('4 tool calls')
		expect(output).toContain('2 entries after the cut')
	})
})

describe('splitting out one source message', () => {
	test('keeps every entry produced by that message and counts both omitted sides', () => {
		expect(transcriptMessage(chat, 20)).toEqual({
			entries: [chat[1], chat[2]],
			earlier: 1,
			later: 2
		})
	})

	test('renders the selected response without its reasoning', () => {
		const cut = transcriptMessage(chat, 20)
		if (!cut) throw new Error('expected message')
		const rendered = renderTranscript(cut.entries, { thinking: false, tools: false })
		expect(rendered.text).toBe('## Assistant\n\n[1 thinking block elided]\n\nthe answer\n')
		expect(rendered.elided.thinking).toBe(1)
	})

	test('refuses a message this chat does not hold', () => {
		expect(transcriptMessage(chat, 25)).toBeNull()
	})
})
