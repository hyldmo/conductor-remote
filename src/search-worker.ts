import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { ConductorDb } from './db.ts'
import {
	HIT_CLOSE,
	HIT_OPEN,
	type IndexStatus,
	matchQuery,
	type SearchHit,
	type SearchOptions,
	type SearchRole,
	type SearchWorkerMessage,
	type SearchWorkerRequest
} from './search.ts'
import { parseMessage } from './transcript.ts'

/** Bump when extraction or an invariant such as one-chunk-per-source changes stored rows. */
// v3 rebuilds every chunk through WorkflowSecretScrubber so a capability indexed by
// an older relay cannot survive after the private-envelope boundary is introduced.
const SCHEMA_VERSION = 3

/**
 * Source rows advanced per tick. The cursor moves by *scanned* rowid rather than
 * matched rowid, so a caught-up index re-scans nothing.
 */
const WINDOW_ROWS = 4000

const BACKFILL_PAUSE_MS = 5
const IDLE_POLL_MS = 15_000
const MAX_CHUNK_CHARS = 64_000
const CHUNK_LIMIT = 300
const SLOW_OPERATION_MS = 100
const SLOW_LOG_INTERVAL_MS = 60_000

const INDEXED_ROLES = new Set<string>(['user', 'assistant', 'thinking'] satisfies SearchRole[])

interface ChunkRow {
	session_id: string
	src_rowid: number
	role: string
	at: string
	score: number
	snippet: string
}

interface SourceRow {
	rowid: number
	id: string
	session_id: string
	role: string | null
	content: string | null
	full_message: string | null
	created_at: string
	sent_at: string | null
	queue_order: number | null
}

interface IndexedChunk {
	body: string
	sessionId: string
	srcRowid: number
	role: SearchRole
	at: string
}

interface WorkerConfig {
	sourceDbPath: string
	file: string
}

const port = parentPort
if (!port) throw new Error('search worker requires a parent port')

const post = (message: SearchWorkerMessage): void => port.postMessage(message)
const log = (level: 'log' | 'warn', message: string): void => post({ type: 'log', level, message })
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

class SearchIndexWorker {
	private readonly source: ConductorDb
	private readonly file: string
	private db: DatabaseSync | null = null
	private cursor = 0
	private chunks = 0
	private caughtUp = false
	private timer: NodeJS.Timeout | null = null
	private sourceMax = 0
	private readonly slowLogs = new Map<string, { at: number; suppressed: number }>()

	constructor(sourceDbPath: string, file: string) {
		this.source = new ConductorDb(sourceDbPath, { onSlowQuery: message => log('warn', message) })
		this.file = file
	}

	open(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		const db = new DatabaseSync(this.file)
		// Set the wait before any pragma or schema operation that may need the writer.
		// A second dev relay can own it for a batch; this wait is why the connection must
		// live off the HTTP thread.
		db.exec('PRAGMA busy_timeout = 5000')
		db.exec('PRAGMA journal_mode = WAL')
		db.exec('PRAGMA synchronous = NORMAL')
		db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
		const version = Number(this.readMeta(db, 'version') ?? 0)
		if (version !== SCHEMA_VERSION) {
			db.exec('DROP TABLE IF EXISTS chunks')
			db.exec(`
				CREATE VIRTUAL TABLE chunks USING fts5(
					body,
					session_id UNINDEXED,
					src_rowid UNINDEXED,
					role UNINDEXED,
					at UNINDEXED,
					tokenize='porter unicode61'
				)
			`)
			db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('version', String(SCHEMA_VERSION))
			db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('cursor', '0')
			if (version) log('log', `search index schema ${version} → ${SCHEMA_VERSION}, rebuilding`)
		}
		this.db = db
		this.cursor = Number(this.readMeta(db, 'cursor') ?? 0)
		this.chunks = Number((db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c)
	}

	start(): void {
		this.schedule(0)
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	status(): IndexStatus {
		if (!this.db) return { chunks: 0, ready: false, progress: 0 }
		if (this.caughtUp) return { chunks: this.chunks, ready: true, progress: 1 }
		if (!this.sourceMax) {
			const max = this.source.query<{ m: number | null }>('SELECT MAX(rowid) m FROM session_messages')[0]?.m
			this.sourceMax = max ?? 0
		}
		const progress = this.sourceMax ? Math.min(1, this.cursor / this.sourceMax) : 0
		return { chunks: this.chunks, ready: false, progress }
	}

	search(raw: string, { limit = CHUNK_LIMIT, sessionIds }: SearchOptions = {}): SearchHit[] {
		const started = performance.now()
		try {
			const db = this.db
			if (!db) return []
			const match = matchQuery(raw)
			if (!match || (sessionIds && !sessionIds.length)) return []
			const scope = sessionIds ? 'AND session_id IN (SELECT value FROM json_each(?))' : ''
			const params = sessionIds
				? [HIT_OPEN, HIT_CLOSE, match, JSON.stringify(sessionIds), limit]
				: [HIT_OPEN, HIT_CLOSE, match, limit]
			let rows: ChunkRow[]
			try {
				rows = db
					.prepare(
						`SELECT session_id, src_rowid, role, at, -bm25(chunks) AS score,
						        snippet(chunks, 0, ?, ?, '…', 24) AS snippet
						 FROM chunks WHERE chunks MATCH ? ${scope} ORDER BY bm25(chunks) LIMIT ?`
					)
					.all(...(params as never[])) as unknown as ChunkRow[]
			} catch (error) {
				throw new Error(`search failed for ${JSON.stringify(match)}: ${errorText(error)}`)
			}
			return rows.map(row => ({
				sessionId: row.session_id,
				srcRowid: Number(row.src_rowid),
				role: INDEXED_ROLES.has(row.role) ? (row.role as SearchRole) : 'assistant',
				at: row.at,
				score: Number(row.score),
				snippet: row.snippet
			}))
		} finally {
			this.reportSlow('query', performance.now() - started)
		}
	}

	private readMeta(db: DatabaseSync, key: string): string | null {
		const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v?: string } | undefined
		return row?.v ?? null
	}

	private schedule(ms: number): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			const started = performance.now()
			let more = false
			try {
				more = this.tick()
			} catch (error) {
				log('warn', `⚠ search index tick failed: ${errorText(error)}`)
			} finally {
				this.reportSlow('backfill batch', performance.now() - started)
			}
			try {
				post({ type: 'status', status: this.status() })
			} catch (error) {
				log('warn', `⚠ search index status failed: ${errorText(error)}`)
			}
			this.schedule(more ? BACKFILL_PAUSE_MS : IDLE_POLL_MS)
		}, ms)
		this.timer.unref?.()
	}

	/**
	 * Index one source-row window. Filtering happens after the rowid window is chosen,
	 * so the cursor advances across tool-only rows instead of scanning them forever.
	 */
	private tick(): boolean {
		const db = this.db
		if (!db) return false

		const startingCursor = this.cursor
		const window = this.source.query<{ rowid: number }>(
			'SELECT rowid FROM session_messages WHERE rowid > ? ORDER BY rowid LIMIT ?',
			[startingCursor, WINDOW_ROWS]
		)
		if (!window.length) {
			this.caughtUp = true
			return false
		}
		this.caughtUp = false
		const end = window[window.length - 1].rowid

		const rows = this.source.query<SourceRow>(
			`SELECT rowid, id, session_id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE rowid > ? AND rowid <= ? AND session_id IS NOT NULL
			   AND (role = 'user' OR content LIKE '%"type":"text"%' OR content LIKE '%"type":"thinking"%')
			 ORDER BY rowid`,
			[startingCursor, end]
		)

		// Parse outside the sidecar write transaction. A second relay may be waiting for
		// that writer, and parsing transcript JSON does not need to hold it.
		const chunks: IndexedChunk[] = []
		for (const row of rows) {
			for (const entry of parseMessage(row, null)) {
				if (!INDEXED_ROLES.has(entry.role)) continue
				const body = entry.text.trim()
				if (!body) continue
				chunks.push({
					body: body.slice(0, MAX_CHUNK_CHARS),
					sessionId: row.session_id,
					srcRowid: row.rowid,
					role: entry.role as SearchRole,
					at: entry.ts
				})
			}
		}

		// BEGIN IMMEDIATE serialises the cursor check with the batch write. Without the
		// check, a dev relay and the service can both read cursor N, wait for each other,
		// and then insert the same N→M chunks twice.
		db.exec('BEGIN IMMEDIATE')
		try {
			const durableCursor = Number(this.readMeta(db, 'cursor') ?? 0)
			if (durableCursor !== startingCursor) {
				db.exec('ROLLBACK')
				this.cursor = durableCursor
				this.chunks = Number((db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c)
				return true
			}

			const insert = db.prepare('INSERT INTO chunks(body, session_id, src_rowid, role, at) VALUES (?, ?, ?, ?, ?)')
			for (const chunk of chunks) {
				insert.run(chunk.body, chunk.sessionId, chunk.srcRowid, chunk.role, chunk.at)
			}
			db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('cursor', String(end))
			db.exec('COMMIT')
		} catch (error) {
			try {
				db.exec('ROLLBACK')
			} catch {
				// Preserve the original SQLite error.
			}
			throw error
		}
		this.cursor = end
		this.chunks += chunks.length
		return true
	}

	private reportSlow(operation: string, elapsedMs: number): void {
		if (elapsedMs < SLOW_OPERATION_MS) return
		const now = Date.now()
		const previous = this.slowLogs.get(operation)
		if (previous && now - previous.at < SLOW_LOG_INTERVAL_MS) {
			previous.suppressed++
			return
		}
		const suppressed = previous?.suppressed ? `; ${previous.suppressed} similar calls suppressed` : ''
		log('warn', `⚠ slow search index ${operation} (${Math.round(elapsedMs)}ms${suppressed})`)
		this.slowLogs.set(operation, { at: now, suppressed: 0 })
	}
}

const config = workerData as WorkerConfig
let index: SearchIndexWorker | null = null
try {
	index = new SearchIndexWorker(config.sourceDbPath, config.file)
	index.open()
	post({ type: 'status', status: index.status() })
	index.start()
} catch (error) {
	const message = errorText(error)
	log('warn', `⚠ search index unavailable (${message}) — /api/search will report it`)
	post({ type: 'status', status: { chunks: 0, ready: false, progress: 0, error: message } })
}

port.on('message', (request: SearchWorkerRequest) => {
	if (request.type !== 'search') return
	try {
		post({ type: 'result', id: request.id, hits: index?.search(request.raw, request.options) ?? [] })
	} catch (error) {
		post({ type: 'error', id: request.id, error: errorText(error) })
	}
})

process.once('exit', () => index?.stop())
