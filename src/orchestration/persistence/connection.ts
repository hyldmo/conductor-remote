import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { OrchestrationError, UnsupportedOrchestrationSchemaError } from './errors.ts'
import { ORCHESTRATION_BOOTSTRAP_SQL, ORCHESTRATION_SCHEMA_VERSION, ORCHESTRATION_TABLE_NAMES } from './schema.ts'
import type { OrchestrationDbOptions, ProcessProbe } from './types.ts'
import { defaultScrub, isPromiseLike } from './values.ts'

const migrations = [ORCHESTRATION_BOOTSTRAP_SQL]

const sqliteRetryWait = new Int32Array(new SharedArrayBuffer(4))

/**
 * Durable, relay-owned Workflow coordinator state. Every mutating method is a
 * short synchronous `BEGIN IMMEDIATE` transaction. `idempotentMutation` callbacks
 * must therefore be synchronous; domain methods called inside one join its transaction.
 */
export class PersistenceConnection {
	db: DatabaseSync
	orm: NodeSQLiteDatabase
	readonly now: () => number
	readonly processProbe: ProcessProbe
	readonly scrubPublicText: (text: string) => string
	private readonly busyTimeoutMs: number
	private transactionDepth = 0
	readonly schemaVersion: number
	readonly writable: boolean
	readonly schemaWarning: string | undefined

	constructor(file: string, options: OrchestrationDbOptions = {}) {
		if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
		this.now = options.now ?? Date.now
		// Without an exact process-identity probe, failure to prove death must fail closed.
		this.processProbe = options.processProbe ?? (() => true)
		this.scrubPublicText = options.scrubPublicText ?? defaultScrub
		this.busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))
		this.db = new DatabaseSync(file)
		this.orm = drizzle({ client: this.db })
		this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`)
		this.db.exec('PRAGMA foreign_keys = ON')

		let found: number
		try {
			found = this.detectSchemaVersion()
		} catch (error) {
			this.reopenReadOnly(file)
			this.schemaVersion = -1
			this.writable = false
			this.schemaWarning = error instanceof Error ? error.message : 'orchestration schema metadata is corrupt'
			return
		}
		if (found > ORCHESTRATION_SCHEMA_VERSION) {
			this.reopenReadOnly(file)
			this.schemaVersion = found
			this.writable = false
			this.schemaWarning = `orchestration schema ${found} requires a newer relay`
			return
		}

		// `busy_timeout` does not reliably wait for a concurrent journal-mode change.
		// Relay processes can cold-start together, so retry only these initialization
		// pragmas within the same bounded budget used by SQLite statements.
		this.execInitializationPragma('PRAGMA journal_mode = WAL')
		this.execInitializationPragma('PRAGMA synchronous = NORMAL')
		for (let next = found + 1; next <= ORCHESTRATION_SCHEMA_VERSION; next++) this.applyMigration(next)
		let schemaProblem: string | undefined
		try {
			schemaProblem = this.currentSchemaProblem()
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			schemaProblem = `orchestration schema could not be validated: ${detail}`
		}
		if (schemaProblem) {
			this.reopenReadOnly(file)
			this.schemaVersion = ORCHESTRATION_SCHEMA_VERSION
			this.writable = false
			this.schemaWarning = schemaProblem
			return
		}
		this.schemaVersion = ORCHESTRATION_SCHEMA_VERSION
		this.writable = true
		this.schemaWarning = undefined
	}

	close(): void {
		this.db.close()
	}

	private reopenReadOnly(file: string): void {
		if (file === ':memory:') return
		this.db.close()
		this.db = new DatabaseSync(file, { readOnly: true })
		this.orm = drizzle({ client: this.db })
		this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`)
		this.db.exec('PRAGMA foreign_keys = ON')
	}

	private currentSchemaProblem(): string | undefined {
		const rows = this.db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${ORCHESTRATION_TABLE_NAMES.map(() => '?').join(',')})`
			)
			.all(...ORCHESTRATION_TABLE_NAMES) as unknown as Array<{ name: string }>
		const present = new Set(rows.map(row => row.name))
		const missing = ORCHESTRATION_TABLE_NAMES.filter(table => !present.has(table))
		if (missing.length > 0) return `orchestration schema is missing: ${missing.join(', ')}`
		const mutex = this.db.prepare('SELECT COUNT(*) count FROM ui_mutex WHERE id = 1').get() as { count: number }
		const quarantine = this.db.prepare('SELECT COUNT(*) count FROM ui_quarantine WHERE id = 1').get() as {
			count: number
		}
		if (Number(mutex.count) !== 1 || Number(quarantine.count) !== 1) {
			return 'orchestration schema is missing its singleton UI coordination rows'
		}
		return undefined
	}

	private execInitializationPragma(sql: string): void {
		const deadline = Date.now() + this.busyTimeoutMs
		for (;;) {
			try {
				this.db.exec(sql)
				return
			} catch (error) {
				const busy =
					error instanceof Error &&
					((error as Error & { errcode?: number }).errcode === 5 || /database is (?:locked|busy)/i.test(error.message))
				const remaining = deadline - Date.now()
				if (!busy || remaining <= 0) throw error
				Atomics.wait(sqliteRetryWait, 0, 0, Math.min(25, remaining))
			}
		}
	}

	private detectSchemaVersion(): number {
		const table = this.db
			.prepare("SELECT 1 present FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_meta'")
			.get() as { present: number } | undefined
		if (!table) {
			const stateTables = ORCHESTRATION_TABLE_NAMES.filter(name => name !== 'orchestration_meta')
			const existing = this.db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${stateTables.map(() => '?').join(',')}) ORDER BY name`
				)
				.all(...stateTables) as unknown as Array<{ name: string }>
			if (existing.length > 0) {
				throw new OrchestrationError(
					`orchestration schema version metadata is missing (found ${existing.map(row => row.name).join(', ')})`
				)
			}
			return 0
		}
		const row = this.db.prepare("SELECT value FROM orchestration_meta WHERE key = 'schema_version'").get() as
			| { value: string }
			| undefined
		if (!row) throw new OrchestrationError('orchestration schema version metadata is missing')
		const version = Number(row.value)
		if (!Number.isSafeInteger(version) || version < 0)
			throw new OrchestrationError('invalid orchestration schema version')
		return version
	}

	private applyMigration(version: number): void {
		const migration = migrations[version - 1]
		if (!migration) throw new OrchestrationError(`missing orchestration migration ${version}`)
		this.db.exec('BEGIN IMMEDIATE')
		try {
			// Another relay may have migrated after this connection's initial read but
			// before it acquired the write lock. Recheck under the lock and join it.
			const current = this.detectSchemaVersion()
			if (current >= version) {
				this.db.exec('COMMIT')
				return
			}
			if (current !== version - 1) {
				throw new OrchestrationError(`cannot migrate orchestration schema ${current} to ${version}`)
			}
			this.db.exec(migration)
			this.db
				.prepare('INSERT OR REPLACE INTO orchestration_meta(key, value) VALUES (?, ?)')
				.run('schema_version', String(version))
			this.db.exec('COMMIT')
		} catch (error) {
			this.db.exec('ROLLBACK')
			throw error
		}
	}

	private assertWritable(): void {
		if (!this.writable && this.schemaVersion > ORCHESTRATION_SCHEMA_VERSION) {
			throw new UnsupportedOrchestrationSchemaError(this.schemaVersion)
		}
		if (this.schemaWarning) throw new OrchestrationError(this.schemaWarning)
		if (!this.writable) throw new OrchestrationError('orchestration database is read-only')
	}

	immediate<T>(operation: () => T): T {
		this.assertWritable()
		if (this.transactionDepth > 0) return operation()
		this.db.exec('BEGIN IMMEDIATE')
		this.transactionDepth++
		try {
			const result = operation()
			if (isPromiseLike(result)) throw new OrchestrationError('orchestration transactions must be synchronous')
			this.db.exec('COMMIT')
			return result
		} catch (error) {
			this.db.exec('ROLLBACK')
			throw error
		} finally {
			this.transactionDepth--
		}
	}
}
