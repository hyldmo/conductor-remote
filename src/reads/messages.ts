import type { ConductorDb } from '../db.ts'
import {
	type ContextBreakdown,
	estimateContextCategories,
	estimateTextTokens
} from '../transcript/context-breakdown.ts'
import {
	type OutboxMessageRow,
	parseMessage,
	parseOutboxMessage,
	renderTranscript,
	type TranscriptEntry,
	toolImageAt
} from '../transcript/parser.ts'
import type { DeliveryCursor, DeliveryReceipt } from './types.ts'
import { resolveWorktree } from './worktrees.ts'

export class MessageReads {
	private readonly db: ConductorDb
	private readonly workspacesRoot: string
	constructor(db: ConductorDb, workspacesRoot: string) {
		this.db = db
		this.workspacesRoot = workspacesRoot
	}
	private messageOutboxAvailable: boolean | null = null
	private messageOutboxCheckedAt = 0
	/** Session → worktree path, cached: stable for a session's lifetime and polled every tick. */
	private readonly worktreeBySession = new Map<string, string | null>()

	/**
	 * The newest structured AskUserQuestion input, when a harness emitted one. Conductor's
	 * normal gstack path writes the same decision as prose, so this is deliberately a fallback
	 * behind `lastAssistantText`, not a second primary transcript parser.
	 */
	lastQuestionInput(sessionId: string): unknown | null {
		const rows = this.db.query<{ content: string | null }>(
			`SELECT content FROM session_messages
			 WHERE session_id = ? AND content LIKE '%AskUserQuestion%'
			 ORDER BY rowid DESC LIMIT 40`,
			[sessionId]
		)
		for (const row of rows) {
			if (!row.content) continue
			try {
				const parsed = JSON.parse(row.content) as {
					message?: { content?: { type?: unknown; name?: unknown; input?: unknown }[] }
				}
				for (const block of parsed.message?.content ?? []) {
					if (
						block.type === 'tool_use' &&
						typeof block.name === 'string' &&
						block.name.toLowerCase().endsWith('askuserquestion')
					)
						return block.input ?? null
				}
			} catch {
				// The LIKE is only a cheap prefilter; malformed history is skipped like parseMessage does.
			}
		}
		return null
	}

	/**
	 * The last thing the agent actually said in a chat — the body of a "finished"
	 * notification. Reads the tail rather than the whole transcript, and runs the
	 * same parser the phone renders with, so what lands on the lock screen is the
	 * text that will be at the bottom of the chat when it's opened.
	 */
	lastAssistantText(sessionId: string): string | null {
		const rows = this.db.query<{
			rowid: number
			id: string
			role: string | null
			content: string | null
			full_message: string | null
			created_at: string
			sent_at: string | null
			queue_order: number | null
		}>(
			`SELECT rowid, id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE session_id = ?
			 ORDER BY rowid DESC
			 LIMIT 20`,
			[sessionId]
		)
		// Rows come back newest-first; the last assistant text is the first one found.
		for (const row of rows) {
			const entries = parseMessage(row, null)
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].role === 'assistant' && entries[i].text.trim()) return entries[i].text.trim()
			}
		}
		return null
	}

	/**
	 * One image a tool returned, by the reference its transcript entry carries.
	 *
	 * The bytes sit in `session_messages.content` as base64, so this is the same read-only
	 * handle as everything else — nothing is written and nothing is cached to disk. The
	 * reference names a row and the image's position in it, and `toolImageAt` does the
	 * walk, because the numbering has to be the one `parseMessage` used.
	 */
	toolImage(reference: string): { mediaType: string; data: string } | null {
		const dot = reference.lastIndexOf('.')
		const rowid = Number(reference.slice(0, dot))
		const index = Number(reference.slice(dot + 1))
		if (dot < 0 || !Number.isInteger(rowid) || !Number.isInteger(index) || index < 0) return null
		const rows = this.db.query<{ content: string | null }>(
			'SELECT content FROM session_messages WHERE rowid = ? LIMIT 1',
			[rowid]
		)
		const content = rows[0]?.content
		return content ? toolImageAt(content, index) : null
	}

	private sessionWorktree(sessionId: string): string | null {
		const cached = this.worktreeBySession.get(sessionId)
		if (cached !== undefined) return cached
		const rows = this.db.query<{
			directory_name: string | null
			branch: string | null
			repo_name: string | null
			repo_root: string | null
		}>(
			`SELECT w.directory_name, w.branch, r.name AS repo_name, r.root_path AS repo_root
			 FROM sessions s
			 JOIN workspaces w ON w.id = s.workspace_id
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE s.id = ? LIMIT 1`,
			[sessionId]
		)
		const r = rows[0]
		const worktree = r
			? resolveWorktree(this.workspacesRoot, r.repo_name, r.directory_name, r.branch, r.repo_root)
			: null
		this.worktreeBySession.set(sessionId, worktree)
		return worktree
	}

	/**
	 * The outbox arrived in Conductor migration 123. Keep older desktop builds usable,
	 * and re-probe occasionally so a running relay notices an in-place app migration.
	 */
	private hasMessageOutbox(): boolean {
		if (this.messageOutboxAvailable === true) return true
		const now = Date.now()
		if (this.messageOutboxAvailable === false && now - this.messageOutboxCheckedAt < 60_000) return false
		const rows = this.db.query<{ present: number }>(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_messages_outbox' LIMIT 1"
		)
		this.messageOutboxAvailable = rows.length > 0
		this.messageOutboxCheckedAt = now
		return this.messageOutboxAvailable
	}

	/** Current outbox contents. `queueOnly` is the snapshot the transcript renders. */
	private outboxMessages(sessionId: string, queueOnly: boolean): TranscriptEntry[] {
		if (!this.hasMessageOutbox()) return []
		try {
			const rows = this.db.query<OutboxMessageRow>(
				`SELECT message_id, delivery_payload, created_at
				 FROM session_messages_outbox
				 WHERE session_id = ?${queueOnly ? " AND mode = 'queue'" : ''}
				 ORDER BY COALESCE(queue_order, 2147483647), created_at ASC`,
				[sessionId]
			)
			return rows.flatMap(row => {
				const entry = parseOutboxMessage(row)
				return entry ? [entry] : []
			})
		} catch (error) {
			// A Conductor rollback can swap the DB beneath the relay. Treat only the
			// missing-table case as an older schema; every other read failure stays loud.
			if (error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message)) {
				this.messageOutboxAvailable = false
				this.messageOutboxCheckedAt = Date.now()
				return []
			}
			throw error
		}
	}

	/** Snapshot the durable transcript cursor and pending message ids in one SQLite read. */
	deliveryCursor(sessionId: string): DeliveryCursor {
		if (!this.hasMessageOutbox()) {
			const row = this.db.query<{ rowid: number }>(
				'SELECT COALESCE(MAX(rowid), 0) AS rowid FROM session_messages WHERE session_id = ?',
				[sessionId]
			)[0]
			return { rowid: row?.rowid ?? 0, outboxIds: new Set() }
		}

		try {
			const rows = this.db.query<{ rowid: number; message_id: string | null }>(
				`WITH transcript_cursor AS (
				   SELECT COALESCE(MAX(rowid), 0) AS rowid
				   FROM session_messages
				   WHERE session_id = ?
				 )
				 SELECT transcript_cursor.rowid, NULL AS message_id
				 FROM transcript_cursor
				 UNION ALL
				 SELECT transcript_cursor.rowid, outbox.message_id
				 FROM transcript_cursor
				 JOIN session_messages_outbox outbox ON outbox.session_id = ?`,
				[sessionId, sessionId]
			)
			return {
				rowid: rows[0]?.rowid ?? 0,
				outboxIds: new Set(rows.flatMap(row => (row.message_id ? [row.message_id] : [])))
			}
		} catch (error) {
			if (!(error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message))) throw error
			this.messageOutboxAvailable = false
			this.messageOutboxCheckedAt = Date.now()
			return this.deliveryCursor(sessionId)
		}
	}

	/** Has this send created either a durable user row or a newly-owned outbox item? */
	promptDeliveredSince(sessionId: string, text: string, before: DeliveryCursor): boolean {
		return this.deliveryReceiptSince(sessionId, text, before) !== null
	}

	private deliveryMessageRows(
		where: string,
		params: unknown[]
	): Array<{
		rowid: number
		id: string
		content: string | null
		turn_id: string | null
	}> {
		const select = (turn: string) =>
			`SELECT rowid, id, content, ${turn} AS turn_id
			 FROM session_messages
			 WHERE session_id = ? AND role = 'user' AND ${where}
			 ORDER BY rowid ASC`
		try {
			return this.db.query(select('turn_id'), params)
		} catch (error) {
			// turn_id predates the current outbox protocol. Preserve the tagged receipt
			// on older Conductor builds, with a truthful null rather than inventing a turn.
			if (!(error instanceof Error && /no such column:\s*turn_id/i.test(error.message))) throw error
			return this.db.query(select('NULL'), params)
		}
	}

	private rawOutboxRows(
		sessionId: string,
		messageId?: string
	): Array<{
		message_id: string
		delivery_payload: string | null
	}> {
		if (!this.hasMessageOutbox()) return []
		try {
			return this.db.query(
				`SELECT message_id, delivery_payload
				 FROM session_messages_outbox
				 WHERE session_id = ?${messageId === undefined ? '' : ' AND message_id = ?'}
				 ORDER BY COALESCE(queue_order, 2147483647), created_at ASC`,
				messageId === undefined ? [sessionId] : [sessionId, messageId]
			)
		} catch (error) {
			if (!(error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message))) throw error
			this.messageOutboxAvailable = false
			this.messageOutboxCheckedAt = Date.now()
			return []
		}
	}

	private outboxText(payload: string | null): string | null {
		try {
			const message = (JSON.parse(payload ?? '') as { message?: unknown }).message
			return typeof message === 'string' ? message : null
		} catch {
			return null
		}
	}

	/**
	 * Find the first positive receipt created after a pre-send cursor. Matching uses
	 * the private raw text inside this read-only method: parsed transcripts intentionally
	 * redact Workflow capabilities, which would make two rotated envelopes look equal.
	 * A durable row wins over a stale outbox snapshot if promotion straddles the reads.
	 */
	deliveryReceiptSince(sessionId: string, text: string, before: DeliveryCursor): DeliveryReceipt | null {
		const target = text.trim()
		const durableReceipt = (): DeliveryReceipt | null => {
			const durable = this.deliveryMessageRows('rowid > ?', [sessionId, before.rowid]).find(
				row => row.content?.trim() === target && !before.outboxIds.has(row.id)
			)
			return durable ? { kind: 'message', id: durable.id, rowid: durable.rowid, turnId: durable.turn_id ?? null } : null
		}
		const durable = durableReceipt()
		if (durable) return durable
		const accepted = this.rawOutboxRows(sessionId).find(
			row => this.outboxText(row.delivery_payload)?.trim() === target && !before.outboxIds.has(row.message_id)
		)
		if (accepted) return { kind: 'outbox', id: accepted.message_id }
		// Promotion deletes the outbox row and inserts the durable row. If that
		// transaction lands after our first query but before the outbox query, one
		// final durable read closes the otherwise false-negative snapshot gap.
		return durableReceipt()
	}

	/**
	 * Recover an orphaned Workflow send by its persisted non-secret correlation
	 * marker. Raw message text stays inside this read-only boundary; callers receive
	 * only the tagged receipt, and ordinary transcript surfaces still scrub the whole
	 * private envelope that contains the marker.
	 */
	deliveryReceiptContainingSince(sessionId: string, marker: string, before: DeliveryCursor): DeliveryReceipt | null {
		if (!marker) return null
		const durableReceipt = (): DeliveryReceipt | null => {
			const durable = this.deliveryMessageRows('rowid > ?', [sessionId, before.rowid]).find(
				row => row.content?.includes(marker) && !before.outboxIds.has(row.id)
			)
			return durable ? { kind: 'message', id: durable.id, rowid: durable.rowid, turnId: durable.turn_id ?? null } : null
		}
		const durable = durableReceipt()
		if (durable) return durable
		const accepted = this.rawOutboxRows(sessionId).find(
			row => this.outboxText(row.delivery_payload)?.includes(marker) && !before.outboxIds.has(row.message_id)
		)
		return accepted ? { kind: 'outbox', id: accepted.message_id } : durableReceipt()
	}

	/** Follow one accepted id as Conductor promotes it from outbox to transcript. */
	deliveryReceiptForId(sessionId: string, messageId: string): DeliveryReceipt | null {
		if (!this.hasMessageOutbox()) {
			const durable = this.deliveryMessageRows('id = ?', [sessionId, messageId])[0]
			return durable ? { kind: 'message', id: durable.id, rowid: durable.rowid, turnId: durable.turn_id ?? null } : null
		}

		const select = (turn: string) => `
			SELECT kind, id, rowid, turn_id
			FROM (
				SELECT 'message' AS kind, id, rowid, ${turn} AS turn_id, 0 AS preference
				FROM session_messages
				WHERE session_id = ? AND role = 'user' AND id = ?
				UNION ALL
				SELECT 'outbox' AS kind, message_id AS id, NULL AS rowid, NULL AS turn_id, 1 AS preference
				FROM session_messages_outbox
				WHERE session_id = ? AND message_id = ?
			)
			ORDER BY preference
			LIMIT 1`
		type ReceiptRow = {
			kind: 'message' | 'outbox'
			id: string
			rowid: number | null
			turn_id: string | null
		}
		let row: ReceiptRow | undefined
		try {
			row = this.db.query<ReceiptRow>(select('turn_id'), [sessionId, messageId, sessionId, messageId])[0]
		} catch (error) {
			if (error instanceof Error && /no such column:\s*turn_id/i.test(error.message)) {
				row = this.db.query<ReceiptRow>(select('NULL'), [sessionId, messageId, sessionId, messageId])[0]
			} else if (error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message)) {
				this.messageOutboxAvailable = false
				this.messageOutboxCheckedAt = Date.now()
				return this.deliveryReceiptForId(sessionId, messageId)
			} else {
				throw error
			}
		}
		if (!row) return null
		if (row.kind === 'outbox') return { kind: 'outbox', id: row.id }
		if (!Number.isSafeInteger(row.rowid)) return null
		return { kind: 'message', id: row.id, rowid: row.rowid as number, turnId: row.turn_id ?? null }
	}

	/** Incremental durable transcript fetch, without the independently replaced outbox snapshot. */
	private durableMessages(
		sessionId: string,
		afterRowid: number,
		turnId?: string
	): { entries: TranscriptEntry[]; cursor: number } {
		const rows = this.db.query<{
			rowid: number
			id: string
			role: string | null
			content: string | null
			full_message: string | null
			created_at: string
			sent_at: string | null
			queue_order: number | null
		}>(
			`SELECT rowid, id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE session_id = ? AND rowid > ?${turnId === undefined ? '' : ' AND turn_id = ?'}
			 ORDER BY rowid ASC`,
			turnId === undefined ? [sessionId, afterRowid] : [sessionId, afterRowid, turnId]
		)
		const worktree = this.sessionWorktree(sessionId)
		const entries: TranscriptEntry[] = []
		let cursor = afterRowid
		for (const row of rows) {
			cursor = row.rowid
			entries.push(...parseMessage(row, worktree))
		}
		return { entries, cursor }
	}

	/** Incremental transcript rows plus the full current queue snapshot. */
	getMessages(
		sessionId: string,
		afterRowid = 0
	): { entries: TranscriptEntry[]; queued: TranscriptEntry[]; cursor: number } {
		return { ...this.durableMessages(sessionId, afterRowid), queued: this.outboxMessages(sessionId, true) }
	}

	/**
	 * The exact context total Conductor persisted, split into provider-neutral estimates.
	 *
	 * This is intentionally an on-demand read rather than another field on the two-second
	 * session poll: sizing the fork choices needs the full durable transcript, which can be
	 * tens of megabytes on a long-running chat. One query feeds both calculations so opening
	 * the sheet never walks that history twice.
	 */
	getContextBreakdown(sessionId: string): ContextBreakdown | null {
		const session = this.db.query<{ context_token_count: number | null; context_used_percent: number | null }>(
			`SELECT context_token_count, context_used_percent
			 FROM sessions
			 WHERE id = ? AND COALESCE(is_hidden, 0) = 0
			 LIMIT 1`,
			[sessionId]
		)[0]
		if (!session) return null

		const rows = this.db.query<{
			rowid: number
			id: string
			role: string | null
			content: string | null
			full_message: string | null
			created_at: string
			sent_at: string | null
			queue_order: number | null
		}>(
			`SELECT rowid, id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE session_id = ?
			 ORDER BY rowid ASC`,
			[sessionId]
		)
		const totalTokens = Math.max(0, Math.round(session.context_token_count ?? 0))
		const current = estimateContextCategories(rows, totalTokens)
		const worktree = this.sessionWorktree(sessionId)
		const entries = rows.flatMap(row => parseMessage(row, worktree))
		const forkTokens = {
			concise: estimateTextTokens(renderTranscript(entries, { thinking: false, tools: false }).text),
			reasoning: estimateTextTokens(renderTranscript(entries, { thinking: true, tools: false }).text),
			full: estimateTextTokens(renderTranscript(entries, { thinking: true, tools: true }).text)
		}
		return {
			totalTokens,
			usedPercent:
				typeof session.context_used_percent === 'number' && Number.isFinite(session.context_used_percent)
					? session.context_used_percent
					: null,
			compacted: current.compacted,
			categories: current.categories,
			forkTokens
		}
	}

	/** Exact durable frames from one Conductor turn; used to keep managed child outcomes correlated. */
	getMessagesForTurn(
		sessionId: string,
		turnId: string,
		afterRowid = 0
	): { entries: TranscriptEntry[]; cursor: number } {
		return this.durableMessages(sessionId, afterRowid, turnId)
	}
}
