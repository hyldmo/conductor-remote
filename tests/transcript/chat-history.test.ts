import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ChatHistoryStore } from '../../src/transcript/chat-history.ts'
import type { Session } from '../../src/wire.ts'
import { conversationTabs, latestChat, previousChats } from '../../web/src/lib/transcript/history.ts'

let directory: string
let file: string
beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), 'chat-history-'))
	file = path.join(directory, 'chat-history.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const source = { title: 'Original conversation', created_at: '2026-09-01 12:00:00' }
const session = (id: string, created_at: string) => ({ id, created_at, title: id, status: 'idle' }) as Session

describe('stitched chat history', () => {
	test('survives relay restarts and repeated compactions without copying any messages', () => {
		const store = new ChatHistoryStore(file)
		store.join('workspace', 'a', 'b', source)
		store.join('workspace', 'b', 'c', { title: 'Fresh context', created_at: '2026-09-02 12:00:00' })
		const reloaded = new ChatHistoryStore(file)
		const links = reloaded.forWorkspace('workspace')
		expect(previousChats('c', links)).toEqual(['a', 'b'])
		expect(latestChat('a', links)).toBe('c')
		expect(latestChat('b', links)).toBe('c')
		expect(links.c).toEqual({ previousSessionId: 'b', title: source.title, createdAt: source.created_at })
		expect(reloaded.forWorkspace('another-workspace')).toEqual({})
	})

	test('a retry is idempotent; cycles and branching replacements are rejected', () => {
		const store = new ChatHistoryStore(file)
		expect(() => store.join('workspace', 'a', 'a', source)).toThrow('cycle')
		expect(existsSync(file)).toBe(false)
		store.join('workspace', 'a', 'b', source)
		store.join('workspace', 'a', 'b', source)
		expect(() => store.join('workspace', 'b', 'a', source)).toThrow('cycle')
		expect(() => store.join('workspace', 'a', 'c', source)).toThrow('already continues')
		expect(() => store.join('other-workspace', 'b', 'c', source)).toThrow('share a workspace')
		expect(Object.keys(store.forWorkspace('workspace'))).toEqual(['b'])
	})

	test('keeps one tab at the original position, with the newest context status and normal forks alongside', () => {
		const store = new ChatHistoryStore(file)
		store.join('workspace', 'a', 'b', source)
		store.join('workspace', 'b', 'c', source)
		const chats = [
			session('a', source.created_at),
			session('unrelated-fork', '2026-09-01 13:00:00'),
			session('b', '2026-09-02 12:00:00'),
			{ ...session('c', '2026-09-03 12:00:00'), status: 'working' }
		]
		const tabs = conversationTabs(chats, store.forWorkspace('workspace'))
		expect(tabs.map(chat => chat.id)).toEqual(['c', 'unrelated-fork'])
		expect(tabs[0]).toMatchObject({ title: source.title, status: 'working', created_at: source.created_at })
		expect(chats[3].title).toBe('c')
		// Closing the latest real tab closes the UI conversation, rather than reviving its old contexts.
		expect(conversationTabs(chats.slice(0, -1), store.forWorkspace('workspace')).map(chat => chat.id)).toEqual([
			'unrelated-fork'
		])
	})
})
