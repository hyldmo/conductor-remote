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
	turn_id: string | null
}

type OutboxRow = {
	message_id: string
	delivery_payload: string
	mode: string
	queue_order: number
	created_at: string
}

const message = (rowid: number, id: string, content: string, turnId: string | null = `turn-${rowid}`): MessageRow => ({
	rowid,
	id,
	role: 'user',
	content,
	full_message: null,
	created_at: `2026-09-03T12:00:${String(rowid).padStart(2, '0')}.000Z`,
	sent_at: `2026-09-03T12:00:${String(rowid).padStart(2, '0')}.000Z`,
	queue_order: null,
	turn_id: turnId
})

const assistantMessage = (rowid: number, id: string, text: string, turnId: string): MessageRow => ({
	...message(rowid, id, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }), turnId),
	role: 'assistant'
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
	promoteOnOutboxRead = false

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
		if (sql.includes("'message' AS kind") && sql.includes('UNION ALL') && sql.includes('session_messages_outbox')) {
			const messageId = String(params[1] ?? '')
			const durable = this.messages.find(row => row.id === messageId)
			if (durable) {
				return [{ kind: 'message', id: durable.id, rowid: durable.rowid, turn_id: durable.turn_id }] as T[]
			}
			const accepted = this.outbox.find(row => row.message_id === messageId)
			return (accepted ? [{ kind: 'outbox', id: accepted.message_id, rowid: null, turn_id: null }] : []) as T[]
		}
		if (sql.includes('FROM session_messages_outbox')) {
			if (this.promoteOnOutboxRead) {
				this.promoteOnOutboxRead = false
				const promoted = this.outbox.shift()
				if (promoted) {
					const text = (JSON.parse(promoted.delivery_payload) as { message: string }).message
					this.messages.push(message(99, promoted.message_id, text, 'turn-promoted'))
				}
			}
			const rows = sql.includes("mode = 'queue'") ? this.outbox.filter(row => row.mode === 'queue') : this.outbox
			return [...rows].sort((a, b) => a.queue_order - b.queue_order) as T[]
		}
		if (sql.includes('FROM session_messages') && sql.includes("role = 'user'") && sql.includes('AND id = ?')) {
			const id = String(params[1] ?? '')
			return this.messages.filter(row => row.id === id) as T[]
		}
		if (sql.includes('FROM session_messages') && sql.includes('rowid >')) {
			const after = Number(params[1] ?? 0)
			const turnId = sql.includes('turn_id = ?') ? String(params[2] ?? '') : null
			return this.messages
				.filter(row => row.rowid > after && (turnId === null || row.turn_id === turnId))
				.sort((a, b) => a.rowid - b.rowid) as T[]
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
	test('reads one exact turn without absorbing a later manual answer', () => {
		const db = new FakeDb()
		db.messages = [
			message(10, 'managed-task', 'managed task', 'turn-managed'),
			assistantMessage(11, 'managed-answer', 'managed answer', 'turn-managed'),
			message(12, 'manual-task', 'manual follow-up', 'turn-manual'),
			assistantMessage(13, 'manual-answer', 'manual answer', 'turn-manual')
		]

		expect(readsFrom(db).getMessagesForTurn('chat-1', 'turn-managed', 10).entries).toMatchObject([
			{ role: 'assistant', text: 'managed answer', rowid: 11 }
		])
	})

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

	test('preserves the tagged outbox receipt as the same id becomes a durable turn', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')
		db.outbox = [outbox('receipt-id', 'managed prompt', 1)]

		expect(reads.deliveryReceiptSince('chat-1', 'managed prompt', before)).toEqual({
			kind: 'outbox',
			id: 'receipt-id'
		})
		expect(reads.deliveryReceiptForId('chat-1', 'receipt-id')).toEqual({
			kind: 'outbox',
			id: 'receipt-id'
		})

		db.outbox = []
		db.messages = [message(11, 'receipt-id', 'managed prompt', 'turn-managed')]
		expect(reads.deliveryReceiptForId('chat-1', 'receipt-id')).toEqual({
			kind: 'message',
			id: 'receipt-id',
			rowid: 11,
			turnId: 'turn-managed'
		})
	})

	test('prefers the durable receipt in one snapshot while a stale outbox row still exists', () => {
		const db = new FakeDb()
		db.outbox = [outbox('receipt-id', 'managed prompt', 1)]
		db.messages = [message(11, 'receipt-id', 'managed prompt', 'turn-managed')]

		expect(readsFrom(db).deliveryReceiptForId('chat-1', 'receipt-id')).toEqual({
			kind: 'message',
			id: 'receipt-id',
			rowid: 11,
			turnId: 'turn-managed'
		})
	})

	test('returns a delivered tagged receipt immediately when no outbox stage is observed', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')
		db.messages = [message(12, 'direct-id', 'direct prompt', 'turn-direct')]

		expect(reads.deliveryReceiptSince('chat-1', 'direct prompt', before)).toEqual({
			kind: 'message',
			id: 'direct-id',
			rowid: 12,
			turnId: 'turn-direct'
		})
	})

	test('closes the snapshot gap when an outbox row promotes after the first durable read', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')
		db.outbox = [outbox('promoted-id', 'promoted prompt', 1)]
		db.promoteOnOutboxRead = true

		expect(reads.deliveryReceiptSince('chat-1', 'promoted prompt', before)).toEqual({
			kind: 'message',
			id: 'promoted-id',
			rowid: 99,
			turnId: 'turn-promoted'
		})
	})

	test('recovers an orphaned Workflow send by its private correlation marker', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')
		const marker = '[conductor-remote workflow:run-1 action:send-root]'

		db.outbox = [outbox('workflow-id', `objective\n${marker}`, 1)]
		expect(reads.deliveryReceiptContainingSince('chat-1', marker, before)).toEqual({
			kind: 'outbox',
			id: 'workflow-id'
		})

		db.outbox = []
		db.messages = [message(13, 'workflow-id', `objective\n${marker}`, 'workflow-turn')]
		expect(reads.deliveryReceiptContainingSince('chat-1', marker, before)).toEqual({
			kind: 'message',
			id: 'workflow-id',
			rowid: 13,
			turnId: 'workflow-turn'
		})
	})

	test('closes the same promotion gap for Workflow correlation markers', () => {
		const db = new FakeDb()
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')
		const marker = '[conductor-remote workflow:run action:send-root]'
		db.outbox = [outbox('promoted-workflow-id', `objective\n${marker}`, 1)]
		db.promoteOnOutboxRead = true

		expect(reads.deliveryReceiptContainingSince('chat-1', marker, before)).toEqual({
			kind: 'message',
			id: 'promoted-workflow-id',
			rowid: 99,
			turnId: 'turn-promoted'
		})
	})

	test('does not recover a marker that existed before the Workflow effect cursor', () => {
		const db = new FakeDb()
		const marker = '[conductor-remote workflow:run-1 action:return]'
		db.outbox = [outbox('old-workflow-id', marker, 1)]
		const reads = readsFrom(db)
		const before = reads.deliveryCursor('chat-1')

		db.outbox = []
		db.messages = [message(14, 'old-workflow-id', marker, 'old-workflow-turn')]
		expect(reads.deliveryReceiptContainingSince('chat-1', marker, before)).toBeNull()
	})
})
