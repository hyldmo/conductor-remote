/** Durable text from the relay's Realtime sideband. Never opens Conductor's database. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { matchQuery } from '../search.ts'
import { HIT_CLOSE, HIT_OPEN } from '../shared.ts'
import type { VoiceHistoryCall, VoiceHistoryEntry, VoiceHistorySearchResponse, VoiceHistorySummary } from '../wire.ts'

export const MAX_VOICE_SEARCH_CHARS = 500

interface StoredEntry extends VoiceHistoryEntry {
	previousId?: string | null
	parts: Record<string, { text: string; final: boolean }>
}

type NewCall = Pick<VoiceHistorySummary, 'callId' | 'startedAt' | 'transport' | 'model' | 'voice' | 'language'>

interface ItemRow {
	item_id: string
	record: string
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function field(value: Record<string, unknown>, key: string): string | undefined {
	return typeof value[key] === 'string' ? value[key] : undefined
}

/** Completion events can arrive out of order. Follow the conversation's item links, including tool items. */
function ordered(entries: StoredEntry[]): StoredEntry[] {
	const ids = new Set(entries.map(entry => entry.id))
	const children = new Map<string | null, StoredEntry[]>()
	for (const entry of entries) {
		const parent = entry.previousId && ids.has(entry.previousId) ? entry.previousId : null
		const siblings = children.get(parent) ?? []
		siblings.push(entry)
		children.set(parent, siblings)
	}
	const result: StoredEntry[] = []
	const seen = new Set<string>()
	const visit = (root: StoredEntry) => {
		const stack = [root]
		while (stack.length) {
			const entry = stack.pop()!
			if (seen.has(entry.id)) continue
			seen.add(entry.id)
			result.push(entry)
			stack.push(...(children.get(entry.id) ?? []).toReversed())
		}
	}
	for (const entry of children.get(null) ?? []) visit(entry)
	// A missing predecessor or malformed cycle must never hide captured text.
	for (const entry of entries) visit(entry)
	return result
}

export class VoiceHistory {
	readonly file: string
	private db: DatabaseSync | null = null
	private readonly now: () => number
	private readonly log: (line: string) => void
	private readonly pending = new Map<string, Map<string, StoredEntry>>()
	private readonly unstarted = new Map<string, { input: NewCall; resumed: boolean }>()
	private readonly errors = new Map<string, string>()
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(file: string, deps: { now?: () => number; log?: (line: string) => void } = {}) {
		this.file = file
		this.now = deps.now ?? Date.now
		this.log = deps.log ?? console.warn
	}

	private connection(): DatabaseSync {
		if (this.db) return this.db
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		fs.closeSync(fs.openSync(this.file, 'a', 0o600))
		fs.chmodSync(this.file, 0o600)
		const db = new DatabaseSync(this.file)
		try {
			db.exec(
				'PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL'
			)
			const version = db.prepare('PRAGMA user_version').get()?.user_version
			if (version !== 0 && version !== 1 && version !== 2) throw new Error('Voice history was written by a newer relay')
			db.exec(`
				CREATE TABLE IF NOT EXISTS calls (
					call_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, record TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at DESC, call_id);
				CREATE TABLE IF NOT EXISTS entries (
					seq INTEGER PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(call_id),
					item_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(call_id, item_id)
				);
			`)
			if (version !== 2) {
				// The archive is authoritative; search is derived and backfilled once.
				// Keep its updates in the same transaction as the caption correction.
				db.exec(`
					BEGIN IMMEDIATE;
					CREATE VIRTUAL TABLE voice_search USING fts5(text, tokenize='porter unicode61');
					INSERT INTO voice_search(rowid, text)
						SELECT seq, json_extract(record, '$.text') FROM entries
						WHERE json_extract(record, '$.role') IN ('user', 'assistant');
					CREATE TRIGGER voice_search_insert AFTER INSERT ON entries BEGIN
						INSERT INTO voice_search(rowid, text) SELECT new.seq, json_extract(new.record, '$.text')
						WHERE json_extract(new.record, '$.role') IN ('user', 'assistant');
					END;
					CREATE TRIGGER voice_search_update AFTER UPDATE ON entries BEGIN
						DELETE FROM voice_search WHERE rowid = old.seq;
						INSERT INTO voice_search(rowid, text) SELECT new.seq, json_extract(new.record, '$.text')
						WHERE json_extract(new.record, '$.role') IN ('user', 'assistant');
					END;
					CREATE TRIGGER voice_search_delete AFTER DELETE ON entries BEGIN
						DELETE FROM voice_search WHERE rowid = old.seq;
					END;
					PRAGMA user_version = 2;
					COMMIT;
				`)
			}
			this.db = db
			return db
		} catch (error) {
			db.close()
			throw error
		}
	}

	private safely(callId: string, run: () => void): void {
		try {
			run()
		} catch (error) {
			// Keep this failure visible through the history API; never break the live call.
			const message = 'Some of this call could not be saved. Check the relay logs.'
			if (!this.errors.has(callId))
				this.log(`[voice] transcript save failed: ${error instanceof Error ? error.message : String(error)}`)
			this.errors.set(callId, message)
		}
	}

	private summary(callId: string): VoiceHistorySummary | null {
		const row = this.connection().prepare('SELECT record FROM calls WHERE call_id = ?').get(callId)
		return row ? (JSON.parse(row.record as string) as VoiceHistorySummary) : null
	}

	private saveSummary(call: VoiceHistorySummary): void {
		this.connection()
			.prepare(
				'INSERT INTO calls(call_id, started_at, record) VALUES (?, ?, ?) ON CONFLICT(call_id) DO UPDATE SET record = excluded.record'
			)
			.run(call.callId, call.startedAt, JSON.stringify(call))
	}

	start(input: NewCall, resumed = false): void {
		this.unstarted.set(input.callId, { input, resumed })
		this.safely(input.callId, () => {
			const previous = this.summary(input.callId)
			this.saveSummary(
				previous
					? {
							...previous,
							status: 'active',
							endedAt: null,
							hasGaps: previous.hasGaps || resumed || this.errors.has(input.callId)
						}
					: {
							...input,
							updatedAt: input.startedAt,
							endedAt: null,
							status: 'active',
							hasGaps: resumed || this.errors.has(input.callId),
							preview: '',
							entryCount: 0
						}
			)
			this.unstarted.delete(input.callId)
		})
	}

	/** A restart cannot prove what happened while the sideband was down. Preserve that gap. */
	recover(): void {
		this.safely('recovery', () => {
			for (const row of this.connection().prepare('SELECT record FROM calls').all()) {
				const call = JSON.parse(row.record as string) as VoiceHistorySummary
				if (call.status === 'active') this.saveSummary({ ...call, status: 'interrupted', hasGaps: true })
			}
		})
	}

	finish(callId: string, status: 'ended' | 'interrupted'): void {
		this.safely(callId, () => {
			this.flush(callId)
			const call = this.summary(callId)
			if (!call) return
			this.saveSummary({
				...call,
				status,
				endedAt: status === 'ended' ? this.now() : null,
				hasGaps: call.hasGaps || status === 'interrupted' || this.errors.has(callId),
				captureError: this.errors.get(callId) ?? call.captureError
			})
		})
	}

	/** Tag relay-authored nudges before sending them, so they can never impersonate the caller. */
	internal(callId: string, itemId: string): void {
		this.safely(callId, () => {
			this.entry(callId, itemId).role = 'relay'
			this.flush(callId)
		})
	}

	private entry(callId: string, itemId: string): StoredEntry {
		let pending = this.pending.get(callId)
		if (!pending) {
			pending = new Map()
			this.pending.set(callId, pending)
		}
		let entry = pending.get(itemId)
		if (!entry) {
			const row = this.connection()
				.prepare('SELECT record FROM entries WHERE call_id = ? AND item_id = ?')
				.get(callId, itemId)
			entry = row
				? (JSON.parse(row.record as string) as StoredEntry)
				: {
						id: itemId,
						role: 'relay',
						text: '',
						at: this.now(),
						partial: true,
						interrupted: false,
						transcriptionFailed: false,
						parts: {}
					}
			pending.set(itemId, entry)
		}
		return entry
	}

	private part(entry: StoredEntry, index: number, text: string, final: boolean): void {
		// A final event replaces deltas; repeats and response.done snapshots are idempotent.
		if (!final && entry.parts[index]?.final) return
		entry.parts[index] = { text: final ? text : (entry.parts[index]?.text ?? '') + text, final }
		entry.text = Object.entries(entry.parts)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, part]) => part.text)
			.join('\n')
			.trim()
		entry.partial = Object.values(entry.parts).some(part => !part.final)
	}

	private item(callId: string, raw: unknown, previousId?: unknown, final = false): void {
		const item = object(raw)
		if (!item || typeof item.id !== 'string') return
		const entry = this.entry(callId, item.id)
		if (typeof previousId === 'string' || previousId === null) entry.previousId = previousId
		if (item.type === 'message') {
			if (entry.role !== 'relay' || !item.id.startsWith('relay_')) {
				if (item.role === 'user' || item.role === 'assistant') entry.role = item.role
			}
			if (Array.isArray(item.content))
				item.content.forEach((rawPart, index) => {
					const part = object(rawPart)
					if (!part) return
					const text = field(part, 'text') ?? field(part, 'transcript')
					if (text && (final || !entry.parts[index]?.text))
						this.part(entry, index, text, final || part.type === 'input_text')
				})
		} else if ((item.type === 'function_call' || item.type === 'mcp_call') && typeof item.name === 'string') {
			entry.role = 'tool'
			entry.text = item.name
			entry.partial = false
		}
		if (item.status === 'incomplete') entry.interrupted = true
	}

	/** Only allowlisted text fields are stored. Raw audio, tool arguments, tokens and headers never enter the archive. */
	record(callId: string, event: Record<string, unknown>): void {
		const unstarted = this.unstarted.get(callId)
		if (unstarted) this.start(unstarted.input, unstarted.resumed)
		this.safely(callId, () => {
			const type = field(event, 'type') ?? ''
			const itemId = field(event, 'item_id')
			const index = typeof event.content_index === 'number' ? event.content_index : 0
			let flush = true
			if (
				type === 'conversation.item.added' ||
				type === 'conversation.item.created' ||
				type === 'conversation.item.done'
			) {
				this.item(callId, event.item, event.previous_item_id, type.endsWith('.done'))
			} else if (type === 'input_audio_buffer.committed' && itemId) {
				const entry = this.entry(callId, itemId)
				entry.role = 'user'
				if (typeof event.previous_item_id === 'string' || event.previous_item_id === null)
					entry.previousId = event.previous_item_id
			} else if (
				itemId &&
				(type === 'conversation.item.input_audio_transcription.completed' ||
					type === 'conversation.item.input_audio_transcription.delta')
			) {
				const entry = this.entry(callId, itemId)
				entry.role = 'user'
				const final = type.endsWith('.completed')
				const text = field(event, final ? 'transcript' : 'delta')
				if (text !== undefined) this.part(entry, index, text, final)
				flush = final
			} else if (
				itemId &&
				/^(response\.(output_audio_transcript|audio_transcript|output_text|text))\.(delta|done)$/.test(type)
			) {
				const entry = this.entry(callId, itemId)
				entry.role = 'assistant'
				const final = type.endsWith('.done')
				const text = field(event, final ? (type.includes('transcript') ? 'transcript' : 'text') : 'delta')
				if (text !== undefined) this.part(entry, index, text, final)
				flush = final
			} else if (type === 'conversation.item.input_audio_transcription.failed' && itemId) {
				const entry = this.entry(callId, itemId)
				entry.role = 'user'
				entry.transcriptionFailed = true
			} else if (type === 'conversation.item.truncated' && itemId) {
				this.entry(callId, itemId).interrupted = true
			} else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
				this.item(callId, event.item, undefined, type.endsWith('.done'))
			} else if (type === 'response.done') {
				const response = object(event.response)
				if (Array.isArray(response?.output))
					for (const item of response.output) {
						this.item(callId, item, undefined, true)
						const id = field(object(item) ?? {}, 'id')
						if (
							id &&
							(response.status === 'cancelled' || response.status === 'incomplete' || response.status === 'failed')
						)
							this.entry(callId, id).interrupted = true
					}
			} else return
			if (flush) this.flush(callId)
			else if (!this.timer) {
				this.timer = setTimeout(() => {
					this.timer = null
					for (const id of this.pending.keys()) this.safely(id, () => this.flush(id))
				}, 500)
				this.timer.unref()
			}
		})
	}

	private flush(callId: string): void {
		const pending = this.pending.get(callId)
		if (!pending?.size) return
		const db = this.connection()
		const call = this.summary(callId)
		if (!call) throw new Error('The voice call could not be saved before its transcript')
		db.exec('BEGIN IMMEDIATE')
		try {
			const write = db.prepare(
				'INSERT INTO entries(call_id, item_id, record) VALUES (?, ?, ?) ON CONFLICT(call_id, item_id) DO UPDATE SET record = excluded.record'
			)
			for (const entry of pending.values()) write.run(callId, entry.id, JSON.stringify(entry))
			const entries = this.storedEntries(callId).filter(
				entry => entry.role !== 'relay' && (entry.text || entry.transcriptionFailed)
			)
			this.saveSummary({
				...call,
				updatedAt: this.now(),
				entryCount: entries.length,
				preview: (
					entries.find(entry => entry.role === 'user' && entry.text)?.text ??
					entries.find(entry => entry.text)?.text ??
					''
				).slice(0, 160),
				hasGaps: call.hasGaps || this.errors.has(callId),
				captureError: this.errors.get(callId) ?? call.captureError
			})
			db.exec('COMMIT')
			this.pending.delete(callId)
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	}

	private storedEntries(callId: string): StoredEntry[] {
		const rows = this.connection()
			.prepare('SELECT item_id, record FROM entries WHERE call_id = ? ORDER BY seq')
			.all(callId) as unknown as ItemRow[]
		return ordered(rows.map(row => JSON.parse(row.record) as StoredEntry))
	}

	list(limit = 30, offset = 0): { calls: VoiceHistorySummary[]; hasMore: boolean } {
		for (const id of this.pending.keys()) this.safely(id, () => this.flush(id))
		const rows = this.connection()
			.prepare('SELECT record FROM calls ORDER BY started_at DESC, call_id DESC LIMIT ? OFFSET ?')
			.all(limit + 1, offset)
		return {
			calls: rows.slice(0, limit).map(row => {
				const call = JSON.parse(row.record as string) as VoiceHistorySummary
				return { ...call, captureError: this.errors.get(call.callId) ?? call.captureError }
			}),
			hasMore: rows.length > limit
		}
	}

	read(callId: string): VoiceHistoryCall | null {
		this.safely(callId, () => this.flush(callId))
		const call = this.status(callId)
		if (!call) return null
		const entries = this.storedEntries(callId)
			.filter(entry => entry.role !== 'relay' && (entry.text || entry.transcriptionFailed))
			.map(({ parts: _parts, previousId: _previous, ...entry }) => entry)
		return { ...call, entries }
	}

	search(
		query: string,
		options: { limit?: number; offset?: number; callId?: string } = {}
	): VoiceHistorySearchResponse {
		if (query.length > MAX_VOICE_SEARCH_CHARS)
			throw new Error(`query must be at most ${MAX_VOICE_SEARCH_CHARS} characters`)
		const expression = matchQuery(query)
		if (!expression) return { query, hits: [], hasMore: false }
		for (const id of this.pending.keys()) this.safely(id, () => this.flush(id))
		const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 12)))
		const offset = Math.max(0, Math.floor(options.offset ?? 0))
		const rows = this.connection()
			.prepare(`
			SELECT c.record AS call_record, e.record AS entry_record,
				snippet(voice_search, 0, ?, ?, '…', 48) AS snippet
			FROM voice_search JOIN entries e ON e.seq = voice_search.rowid
			JOIN calls c ON c.call_id = e.call_id
			WHERE voice_search MATCH ? AND (? IS NULL OR e.call_id = ?)
			ORDER BY bm25(voice_search), c.started_at DESC, e.seq DESC LIMIT ? OFFSET ?
		`)
			.all(HIT_OPEN, HIT_CLOSE, expression, options.callId ?? null, options.callId ?? null, limit + 1, offset)
		return {
			query,
			hasMore: rows.length > limit,
			hits: rows.slice(0, limit).map(row => {
				const call = JSON.parse(row.call_record as string) as VoiceHistorySummary
				const entry = JSON.parse(row.entry_record as string) as VoiceHistoryEntry
				return {
					call: { ...call, captureError: this.errors.get(call.callId) ?? call.captureError },
					itemId: entry.id,
					role: entry.role as 'user' | 'assistant',
					at: entry.at,
					partial: entry.partial,
					interrupted: entry.interrupted,
					transcriptionFailed: entry.transcriptionFailed,
					snippet: row.snippet as string
				}
			})
		}
	}

	status(callId: string): VoiceHistorySummary | null {
		const call = this.summary(callId)
		if (!call && this.errors.has(callId)) throw new Error(this.errors.get(callId))
		return call ? { ...call, captureError: this.errors.get(callId) ?? call.captureError } : null
	}

	close(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		for (const id of this.pending.keys()) this.safely(id, () => this.flush(id))
		this.db?.close()
		this.db = null
	}
}
