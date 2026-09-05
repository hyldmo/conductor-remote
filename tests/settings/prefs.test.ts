import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PrefsStore } from '../../src/prefs.ts'

const attachment = {
	name: 'diagram.png',
	path: '.context/attachments/abc123/diagram.png',
	bytes: 42,
	token: '@⟦diagram.png⟧(.context%2Fattachments%2Fabc123%2Fdiagram.png)'
}

const temporaryDirs: string[] = []

function testStore(): { store: PrefsStore; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-prefs-'))
	temporaryDirs.push(dir)
	const file = path.join(dir, 'prefs.json')
	return { store: new PrefsStore(file), file }
}

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('host preference store', () => {
	test('keeps known effort values and drops unsupported values from stored drafts', () => {
		const { store } = testStore()
		const prefs = store.patch({
			drafts: {
				valid: { text: 'hello', agent: { effort: 'none', fast: false }, updatedAt: 1 },
				invalid: { text: 'hello', agent: { effort: 'extreme', fast: false }, updatedAt: 1 }
			}
		})
		expect(prefs.drafts.valid.agent).toEqual({ effort: 'none', fast: false })
		expect(prefs.drafts.invalid.agent).toEqual({ fast: false })
	})

	test('merges read marks monotonically', () => {
		const { store } = testStore()
		store.patch({ readMarks: { a: '2026-08-01', b: '2026-08-03' } })
		const prefs = store.patch({ readMarks: { a: '2026-07-01', b: '2026-08-04', c: '2026-08-02' } })
		expect(prefs.readMarks).toEqual({ a: '2026-08-01', b: '2026-08-04', c: '2026-08-02' })
	})

	test('keeps a deletion tombstone over a stale or tied live draft', () => {
		const { store } = testStore()
		store.patch({
			drafts: {
				chat: {
					text: 'already sent',
					agent: { model: 'Sonnet' },
					attachments: [attachment],
					updatedAt: 20,
					deleted: false
				}
			}
		})
		store.patch({ drafts: { chat: { text: '', agent: {}, attachments: [], updatedAt: 30, deleted: true } } })
		store.patch({
			drafts: { chat: { text: 'stale', agent: {}, attachments: [attachment], updatedAt: 29, deleted: false } }
		})
		store.patch({
			drafts: { chat: { text: 'tie', agent: {}, attachments: [attachment], updatedAt: 30, deleted: false } }
		})
		expect(store.read().drafts.chat).toEqual({ text: '', agent: {}, attachments: [], updatedAt: 30, deleted: true })
	})

	test('accepts a newer edit and stores text with staged agent settings as one revision', () => {
		const { store } = testStore()
		store.patch({ drafts: { chat: { text: '', agent: {}, attachments: [], updatedAt: 10, deleted: true } } })
		const prefs = store.patch({
			drafts: {
				chat: {
					text: 'try another approach',
					agent: { model: 'Codex', effort: 'high', plan: true },
					attachments: [attachment],
					updatedAt: 11,
					deleted: false
				}
			}
		})
		expect(prefs.drafts.chat).toMatchObject({
			text: 'try another approach',
			agent: { model: 'Codex', effort: 'high', plan: true },
			attachments: [attachment],
			updatedAt: 11,
			deleted: false
		})
	})

	test('preserves attachments from a cached client unless a new client explicitly changes them', () => {
		const { store } = testStore()
		store.patch({
			drafts: {
				chat: { text: 'caption', agent: {}, attachments: [attachment], updatedAt: 10, deleted: false }
			}
		})

		// Builds from before attachment sync have no `attachments` field. A text edit
		// from one must not silently detach files it cannot see in its wire type.
		store.patch({ drafts: { chat: { text: 'edited caption', agent: {}, updatedAt: 11, deleted: false } } })
		expect(store.read().drafts.chat.attachments).toEqual([attachment])

		store.patch({
			drafts: { chat: { text: 'edited caption', agent: {}, attachments: [], updatedAt: 12, deleted: false } }
		})
		expect(store.read().drafts.chat.attachments).toEqual([])
	})

	test('sanitizes hand-edited data and writes the file privately', () => {
		const { store, file } = testStore()
		const unsafeAttachment = {
			name: '..',
			path: '.context/attachments/unsafe/..',
			bytes: 1,
			token: '@⟦..⟧(.context%2Fattachments%2Funsafe%2F..)'
		}
		const prefs = store.patch({
			readMarks: { good: '2026-08-01', empty: '', bad: 42 as unknown as string },
			drafts: {
				good: {
					text: 'hello',
					agent: { model: 'Codex', plan: true },
					attachments: [attachment, attachment, unsafeAttachment],
					updatedAt: 1,
					deleted: false
				},
				bad: { text: 'ignored', agent: {}, attachments: [], updatedAt: -1, deleted: false }
			}
		})
		expect(prefs.readMarks).toEqual({ good: '2026-08-01' })
		expect(Object.keys(prefs.drafts)).toEqual(['good'])
		expect(prefs.drafts.good.attachments).toEqual([attachment])
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(prefs)
	})
})
