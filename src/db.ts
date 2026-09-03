import { DatabaseSync } from 'node:sqlite'

const SLOW_QUERY_MS = 100
const SLOW_QUERY_LOG_INTERVAL_MS = 60_000

export interface ConductorDbOptions {
	/** Override the sink when the DB lives in a worker and its logs belong to the parent. */
	onSlowQuery?: (message: string) => void
	/** Primarily useful to make the latency instrumentation deterministic in tests. */
	slowQueryMs?: number
}

/**
 * Read-only handle to Conductor's SQLite DB.
 *
 * The desktop app holds the same file open in WAL mode; a second read-only
 * connection sees every committed write without blocking the app. We never
 * write through this handle — writes go through the actuator (see writes.ts).
 */
export class ConductorDb {
	private readonly dbPath: string
	private readonly onSlowQuery: (message: string) => void
	private readonly slowQueryMs: number
	private readonly slowQueryLogs = new Map<string, { at: number; suppressed: number }>()
	private db: DatabaseSync

	constructor(dbPath: string, options: ConductorDbOptions = {}) {
		this.dbPath = dbPath
		this.onSlowQuery = options.onSlowQuery ?? (message => console.warn(message))
		this.slowQueryMs = options.slowQueryMs ?? SLOW_QUERY_MS
		this.db = this.open()
	}

	private open(): DatabaseSync {
		const db = new DatabaseSync(this.dbPath, { readOnly: true })
		try {
			db.exec('PRAGMA busy_timeout = 2000')
		} catch {
			// read-only connections may reject some pragmas; harmless
		}
		return db
	}

	query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
		const started = performance.now()
		let reopened = false
		try {
			try {
				return this.db.prepare(sql).all(...(params as never[])) as T[]
			} catch {
				// If the DB file was swapped underneath us (app update), reopen once.
				reopened = true
				this.db = this.open()
				return this.db.prepare(sql).all(...(params as never[])) as T[]
			}
		} finally {
			this.reportSlowQuery(sql, performance.now() - started, reopened)
		}
	}

	private reportSlowQuery(sql: string, elapsedMs: number, reopened: boolean): void {
		if (elapsedMs < this.slowQueryMs) return
		const summary = sql.replace(/\s+/g, ' ').trim()
		const now = Date.now()
		const previous = this.slowQueryLogs.get(summary)
		if (previous && now - previous.at < SLOW_QUERY_LOG_INTERVAL_MS) {
			previous.suppressed++
			return
		}

		const suppressed = previous?.suppressed ? `; ${previous.suppressed} similar calls suppressed` : ''
		const retried = reopened ? '; connection reopened' : ''
		try {
			this.onSlowQuery(
				`⚠ slow Conductor DB query (${Math.round(elapsedMs)}ms${retried}${suppressed}): ${summary.slice(0, 240)}`
			)
		} catch {
			// Instrumentation must never turn a successful read into a failed API call.
		}
		this.slowQueryLogs.set(summary, { at: now, suppressed: 0 })
	}
}
