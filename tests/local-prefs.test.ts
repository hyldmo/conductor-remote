import { describe, expect, test } from 'vitest'
import { LocalPrefs } from '../web/src/lib/prefs.ts'
import type { Prefs } from '../web/src/lib/types.ts'

class MemoryStorage {
	private readonly values = new Map<string, string>()

	get length(): number {
		return this.values.size
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}

	setItem(key: string, value: string): void {
		this.values.set(key, String(value))
	}

	removeItem(key: string): void {
		this.values.delete(key)
	}
}

const remote = (patch: Partial<Prefs> = {}): Prefs => ({ readMarks: {}, drafts: {}, ...patch })
const attachment = {
	name: 'diagram.png',
	path: '.context/attachments/abc123/diagram.png',
	bytes: 42,
	token: '@⟦diagram.png⟧(.context%2Fattachments%2Fabc123%2Fdiagram.png)'
}

describe('local-first preference sync', () => {
	test('migrates the legacy text and agent keys without inventing a recent revision', () => {
		const storage = new MemoryStorage()
		storage.setItem('conductor-remote-draft:chat', 'finish this')
		storage.setItem('conductor-remote-agent:chat', JSON.stringify({ model: 'Codex', plan: true }))
		const prefs = new LocalPrefs(storage)
		expect(prefs.project()).toMatchObject({
			drafts: { chat: 'finish this' },
			agentDrafts: { chat: { model: 'Codex', plan: true } }
		})
		expect(prefs.snapshot().drafts.chat.updatedAt).toBe(0)
	})

	test('promotes a change made later by a cached legacy build', () => {
		const storage = new MemoryStorage()
		const first = new LocalPrefs(storage)
		first.setDraft('chat', 'new build value', {})
		const previousRevision = first.snapshot().drafts.chat.updatedAt
		storage.setItem('conductor-remote-draft:chat', 'cached build edit')
		const reloaded = new LocalPrefs(storage)
		expect(reloaded.project().drafts.chat).toBe('cached build edit')
		expect(reloaded.snapshot().drafts.chat.updatedAt).toBeGreaterThan(previousRevision)
	})

	test('restores a host draft and read mark onto an empty origin', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		const merged = prefs.merge(
			remote({
				readMarks: { chat: '2026-08-10' },
				drafts: {
					chat: {
						text: 'from the phone',
						agent: { effort: 'high' },
						attachments: [attachment],
						updatedAt: 10,
						deleted: false
					}
				}
			}),
			null
		)
		expect(merged.needsUpload).toBe(false)
		expect(merged.state).toEqual({
			drafts: { chat: 'from the phone' },
			agentDrafts: { chat: { effort: 'high' } },
			draftAttachments: { chat: [attachment] },
			readMarks: { chat: '2026-08-10' }
		})
	})

	test('does not let an offline stale copy resurrect a tombstoned draft', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.merge(
			remote({ drafts: { chat: { text: '', agent: {}, attachments: [], updatedAt: 30, deleted: true } } }),
			null
		)
		const merged = prefs.merge(
			remote({
				drafts: { chat: { text: 'already sent', agent: {}, attachments: [attachment], updatedAt: 20, deleted: false } }
			}),
			null
		)
		expect(merged.state.drafts.chat).toBeUndefined()
		expect(prefs.snapshot().drafts.chat.deleted).toBe(true)
		expect(merged.needsUpload).toBe(true)
	})

	test('protects a focused local edit and advances beyond a remote clock', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setDraft('chat', 'typing here', {})
		const merged = prefs.merge(
			remote({
				drafts: {
					chat: {
						text: 'other device',
						agent: {},
						attachments: [attachment],
						updatedAt: Date.now() + 100_000,
						deleted: false
					}
				}
			}),
			'chat'
		)
		expect(merged.state.drafts.chat).toBe('typing here')
		expect(merged.needsUpload).toBe(true)
		expect(prefs.snapshot().drafts.chat.updatedAt).toBeGreaterThan(Date.now() + 90_000)
	})

	test('lets an untouched empty focused composer restore from the host', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		const merged = prefs.merge(
			remote({ drafts: { chat: { text: 'restore me', agent: {}, attachments: [], updatedAt: 5, deleted: false } } }),
			'chat'
		)
		expect(merged.state.drafts.chat).toBe('restore me')
	})

	test('orders a later local edit after the highest remote clock it has observed', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		const remoteClock = Date.now() + 100_000
		prefs.merge(
			remote({
				drafts: { chat: { text: 'remote first', agent: {}, attachments: [], updatedAt: remoteClock, deleted: false } }
			}),
			null
		)
		prefs.setDraft('chat', 'local second', {})
		expect(prefs.snapshot().drafts.chat.updatedAt).toBeGreaterThan(remoteClock)
	})

	test('keeps text and staged settings live until both are cleared, then tombstones them', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setDraft('chat', 'send me', {})
		prefs.setAgent('chat', { model: 'Codex' }, 'send me')
		prefs.setDraft('chat', '', { model: 'Codex' })
		expect(prefs.snapshot().drafts.chat).toMatchObject({ text: '', agent: { model: 'Codex' }, deleted: false })
		prefs.setAgent('chat', {}, '')
		expect(prefs.snapshot().drafts.chat).toMatchObject({ text: '', agent: {}, deleted: true })
	})

	test('keeps ready attachments in the same revision as text and settings', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setAttachments('chat', [attachment], '', {})
		expect(prefs.project()).toMatchObject({
			drafts: { chat: '' },
			draftAttachments: { chat: [attachment] }
		})

		prefs.setDraft('chat', 'describe this', {})
		expect(prefs.snapshot().drafts.chat.attachments).toEqual([attachment])

		prefs.setAttachments('chat', [], 'describe this', {})
		expect(prefs.snapshot().drafts.chat).toMatchObject({ text: 'describe this', attachments: [], deleted: false })
		prefs.setDraft('chat', '', {})
		expect(prefs.snapshot().drafts.chat).toMatchObject({ attachments: [], deleted: true })
	})

	test('clears sent text and attachments together without dropping staged settings', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setContent('chat', 'send me', { model: 'Codex' }, [attachment])

		const projected = prefs.setContent('chat', '', { model: 'Codex' }, [])
		expect(projected).toEqual({
			drafts: { chat: '' },
			agentDrafts: { chat: { model: 'Codex' } },
			draftAttachments: {},
			readMarks: {}
		})
		expect(prefs.snapshot().drafts.chat).toMatchObject({
			text: '',
			agent: { model: 'Codex' },
			attachments: [],
			deleted: false
		})
	})

	test('restores an attachment-only draft after this device reloads', () => {
		const storage = new MemoryStorage()
		const first = new LocalPrefs(storage)
		first.setAttachments('chat', [attachment], '', {})
		const reloaded = new LocalPrefs(storage)
		expect(reloaded.project().draftAttachments.chat).toEqual([attachment])
	})

	test('does not let an older relay strip attachment fields it cannot echo', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setAttachments('chat', [attachment], 'caption', {})
		const updatedAt = prefs.snapshot().drafts.chat.updatedAt
		const merged = prefs.merge(
			remote({ drafts: { chat: { text: 'caption', agent: {}, updatedAt, deleted: false } as never } }),
			null
		)
		expect(merged.state.draftAttachments.chat).toEqual([attachment])
	})

	test('moves an attachment-only legacy workspace draft to its first chat', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.setAttachments('workspace', [attachment], '', {})
		const moved = prefs.moveDraft('workspace', 'chat')
		expect(moved.draftAttachments).toEqual({ chat: [attachment] })
		expect(prefs.snapshot().drafts.workspace.deleted).toBe(true)
	})

	test('takes the maximum read mark in both directions', () => {
		const prefs = new LocalPrefs(new MemoryStorage())
		prefs.markRead('local-newer', '2026-08-20')
		prefs.markRead('remote-newer', '2026-08-01')
		const merged = prefs.merge(
			remote({ readMarks: { 'local-newer': '2026-08-10', 'remote-newer': '2026-08-30' } }),
			null
		)
		expect(merged.state.readMarks).toEqual({ 'local-newer': '2026-08-20', 'remote-newer': '2026-08-30' })
		expect(merged.needsUpload).toBe(true)
	})
})
