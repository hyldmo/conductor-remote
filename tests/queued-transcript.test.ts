import { describe, expect, test } from 'vitest'
import type { ConductorDb } from '../src/db.ts'
import { Reads } from '../src/reads.ts'
import type { TranscriptEntry } from '../src/transcript.ts'
import { withQueuedEntries } from '../web/src/lib/transcript-merge.ts'

type MessageRow = {
	rowid: number
	id: string
	role: string | null
	content: string
	full_message: string | null
	created_at: string
	sent_at: string | null
	queue_order: number | null
}

type OutboxRow = {
	message_id: string
	delivery_payload: string
	mode: string
	queue_order: number
	created_at: string
}

const message = (rowid: number, id: string, content: string): MessageRow => ({
	rowid,
	id,
	role: 'user',
	content,
	full_message: null,
	created_at: `2026-09-03T12:00:${String(rowid).padStart(2, '0')}.000Z`,
	sent_at: `2026-09-03T12:00:${String(rowid).padStart(2, '0')}.000Z`,
	queue_order: null
})

const outbox = (messageId: string, text: string, queueOrder: number, mode = 'queue'): OutboxRow => ({
	message_id: messageId,
	delivery_payload: JSON.stringify({ message: text }),
	mode,
	queue_order: queueOrder,
	created_at: `2026-09-03T12:01:${String(queueOrder).padStart(2, '0')}.000Z`
})

class FakeDb {
	messages: MessageRow[] = []
	outbox: OutboxRow[] = []
	hasOutbox = true

	query<T>(sql: string, params: unknown[] = []): T[] {
		if (sql.includes('sqlite_master') && sql.includes('session_messages_outbox')) {
			return (this.hasOutbox ? [{ present: 1 }] : []) as T[]
		}
		if (sql.includes('WITH') && sql.includes('session_messages_outbox')) {
			const sessionId = String(params[0] ?? '')
			const rowid = this.messages.reduce((max, row) => Math.max(max, row.rowid), 0)
			return [
				{ rowid, message_id: null },
				...this.outbox.map(row => ({ rowid, message_id: row.message_id, session_id: sessionId }))
			] as T[]
		}
		if (sql.includes('FROM session_messages_outbox')) {
			const rows = sql.includes("mode = 'queue'") ? this.outbox.filter(row => row.mode === 'queue') : this.outbox
			return [...rows].sort((a, b) => a.queue_order - b.queue_order) as T[]
		}
		if (sql.includes('FROM session_messages') && sql.includes('rowid >')) {
			const after = Number(params[1] ?? 0)
			return this.messages.filter(row => row.rowid > after).sort((a, b) => a.rowid - b.rowid) as T[]
		}
		if (sql.includes('MAX(rowid)') && sql.includes('FROM session_messages')) {
			return [{ rowid: this.messages.reduce((max, row) => Math.max(max, row.rowid), 0) }] as T[]
		}
		if (sql.includes('FROM sessions s')) return []
		throw new Error(`unexpected query: ${sql}`)
	}
}

const readsFrom = (db: FakeDb) => new Reads(db as unknown as ConductorDb, '/tmp', () => new Map())

const entry = (id: string, queued = false): TranscriptEntry => ({
	id,
	rowid: queued ? 0 : 1,
	role: 'user',
	text: id,
	ts: '2026-09-03T12:00:00.000Z',
	queued
})

describe('Conductor message outbox', () => {
	test('returns queue-mode outbox messages as an ordered queued snapshot', () => {
		const db = new FakeDb()
		db.messages = [message(10, 'sent-1', 'already sent')]
		db.outbox = [
			outbox('queued-2', 'second', 2),
			outbox('steer-1', 'steering', 1, 'steer'),
			outbox('queued-1', 'first', 1)
		]

		const result = readsFrom(db).getMessages('chat-1')

		expect(result.entries.map(row => row.text)).toEqual(['already sent'])
		expect(result.queued).toEqual([
			{
				id: 'queued-1',
				rowid: 0,
				role: 'user',
				text: 'first',
				ts: '2026-09-03T12:01:01.000Z',
				queued: true
			},
			{
				id: 'queued-2',
				rowid: 0,
				role: 'user',
				text: 'second',
				ts: '2026-09-03T12:01:02.000Z',
				queued: true
			}
		])
	})

	test('ignores an outbox payload it cannot safely render', () => {
		const db = new FakeDb()
		db.outbox = [
			{ ...outbox('broken-json', 'unused', 1), delivery_payload: '{' },
			{ ...outbox('missing-message', 'unused', 2), delivery_payload: '{}' },
			outbox('visible', 'keep me', 3)
		]

		expect(
			readsFrom(db)
				.getMessages('chat-1')
				.queued.map(row => row.id)
		).toEqual(['visible'])
	})

	test('keeps the legacy in-row queue signal when the outbox table is absent', () => {
		const db = new FakeDb()
		db.hasOutbox = false
		db.messages = [{ ...message(10, 'legacy', 'waiting'), sent_at: null, queue_order: 1 }]

		const reads = readsFrom(db)
		const result = reads.getMessages('chat-1')

		expect(result.entries).toMatchObject([{ id: 'legacy', text: 'waiting', queued: true }])
		expect(result.queued).toEqual([])
		expect(reads.deliveryCursor('chat-1')).toMatchObject({ rowid: 10 })
	})
})

describe('queued transcript snapshots', () => {
	test('replaces the snapshot without duplicating it on every poll', () => {
		const sent = entry('sent')
		const queued = entry('queued', true)

		expect(withQueuedEntries([sent], [queued])).toEqual([sent, queued])
		expect(withQueuedEntries([sent], [queued])).toHaveLength(2)
		expect(withQueuedEntries([sent], [])).toEqual([sent])
	})

	test('prefers the durable row when an outbox item is dispatched during a poll', () => {
		const durable = entry('same-id')
		const staleSnapshot = { ...entry('same-id', true), text: 'still queued' }

		expect(withQueuedEntries([durable], [staleSnapshot])).toEqual([durable])
	})
})

describe('queued messages as send receipts', () => {
	test('counts a newly accepted outbox message as delivered', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')

		db.outbox = [outbox('new-id', 'same words', 1)]

		expect(reads.promptDeliveredSince('chat-1', 'same words', before)).toBe(true)
	})

	test('does not mistake an older identical queued message for this send', () => {
		const db = new FakeDb()
		db.outbox = [outbox('old-id', 'same words', 1)]
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')

		expect(reads.promptDeliveredSince('chat-1', 'same words', before)).toBe(false)

		// Dispatching the old outbox item creates a new session_messages row. Its stable
		// message id is what prevents that move from becoming a receipt for a second send.
		db.outbox = []
		db.messages = [message(1, 'old-id', 'same words')]
		expect(reads.promptDeliveredSince('chat-1', 'same words', before)).toBe(false)

		db.messages.push(message(2, 'new-id', 'same words'))
		expect(reads.promptDeliveredSince('chat-1', 'same words', before)).toBe(true)
	})
})
