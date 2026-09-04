import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import {
	ORCHESTRATION_BOOTSTRAP_SQL,
	ORCHESTRATION_SCHEMA_VERSION,
	ORCHESTRATION_TABLE_NAMES,
	relayInstanceSelectSchema,
	relayInstances,
	type StoredJson,
	uiMutex,
	uiMutexSelectSchema,
	uiQuarantine,
	uiQuarantineSelectSchema,
	type WorkflowAdoptionCandidate,
	type WorkflowEffectAttemptRow,
	type WorkflowEffectRow,
	type WorkflowEffectState,
	type WorkflowEventRow,
	type WorkflowJobAttemptRow,
	type WorkflowJobRole,
	type WorkflowJobRow,
	type WorkflowJobState,
	type WorkflowRetryClass,
	type WorkflowRunRow,
	type WorkflowTarget,
	workflowCapabilities,
	workflowCapabilitySelectSchema,
	workflowEffectAttemptSelectSchema,
	workflowEffectAttempts,
	workflowEffectSelectSchema,
	workflowEffects,
	workflowEventSelectSchema,
	workflowEvents,
	workflowIdempotency,
	workflowJobAttemptSelectSchema,
	workflowJobAttempts,
	workflowJobSelectSchema,
	workflowJobs,
	workflowRunSelectSchema,
	workflowRuns
} from './orchestration-schema.ts'
import { scrubWorkflowSecrets, withoutWindowEvidence } from './shared.ts'
import type { WorkflowPhase, WorkflowRoleName, WorkflowRunWire } from './wire.ts'
import type { FrozenWorkflowRole, FrozenWorkflowRoles } from './workflow.ts'
import { isTerminalWorkflowJobState, isTerminalWorkflowPhase } from './workflow-machine.ts'

export {
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkflowAdoptionCandidate,
	type WorkflowEffectState,
	type WorkflowJobRole,
	type WorkflowJobState,
	type WorkflowRetryClass,
	type WorkflowTarget
} from './orchestration-schema.ts'
export type { WorkflowPhase, WorkflowRoleName } from './wire.ts'
export type { FrozenWorkflowRole, FrozenWorkflowRoles } from './workflow.ts'

export const ORCHESTRATION_PROTOCOL_VERSION = 1

export interface ProcessIdentity {
	pid: number
	processStartedAt: string
}

export interface RelayIdentity extends ProcessIdentity {
	instanceId: string
	protocolVersion: number
}

/**
 * True when the exact PID/start identity is alive. For an external identity with
 * `processGroup`, implementations must also return true while any group member
 * remains alive; failure to prove the entire group dead must fail closed.
 */
export type ProcessProbe = (process: ProcessIdentity & { processGroup?: number }) => boolean

export interface WorkflowBlockedState {
	actionId: string
	errorCode: string
	message: string
	resumePhase: Exclude<WorkflowPhase, 'blocked' | 'completed' | 'cancelled'>
	retryClass: WorkflowRetryClass
	candidates?: WorkflowAdoptionCandidate[]
	blockedAt?: number
}

export interface WorkflowRunRecord {
	id: string
	objective: string
	target: WorkflowTarget
	roles: FrozenWorkflowRoles
	phase: WorkflowPhase
	cycle: number
	revision: number
	workspaceId?: string
	rootSessionId?: string
	pristineEvidence?: unknown
	deliveryBaseline?: unknown
	planningInterpretation?: string
	cancellationGeneration: number
	blocked?: WorkflowBlockedState
	implementationBatonsDelivered: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowJobRecord {
	id: string
	runId: string
	logicalKey: string
	role: WorkflowJobRole
	cycle: number
	revision: number
	resolvedRole: FrozenWorkflowRole
	prompt: string
	state: WorkflowJobState
	cancellationGeneration: number
	owner?: RelayIdentity
	transcriptCursor?: unknown
	childSessionId?: string
	outcome?: unknown
	taskReceipt?: unknown
	batonReceipt?: unknown
	attemptCount: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowJobAttemptRecord {
	id: string
	jobId: string
	attemptNumber: number
	state: WorkflowJobState
	childSessionId?: string
	openEffectId?: string
	configureEffectId?: string
	taskEffectId?: string
	batonEffectId?: string
	outcome?: unknown
	failureEvidence?: unknown
	owner?: RelayIdentity
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowEffectRecord {
	id: string
	runId: string
	actionId: string
	jobId?: string
	kind: string
	state: WorkflowEffectState
	target?: unknown
	inputs?: unknown
	baseline?: unknown
	cursor?: unknown
	receipt?: unknown
	errorCode?: string
	errorMessage?: string
	owner?: RelayIdentity
	launchNonce?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	attemptCount: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowEffectAttemptRecord {
	id: string
	effectId: string
	attemptNumber: number
	state: WorkflowEffectState
	owner: RelayIdentity
	launchNonce?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	receipt?: unknown
	evidence?: unknown
	errorCode?: string
	errorMessage?: string
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowCapabilityRecord {
	id: string
	tokenHash: string
	runId: string
	rootSessionId: string
	cycle: number
	phase: WorkflowPhase
	revision: number
	allowedRoles: WorkflowJobRole[]
	issuedWith?: { rowid: number; turnId?: string }
	consumedAt?: number
	revokedAt?: number
	createdAt: number
}

export interface WorkflowEventRecord {
	id: number
	runId: string
	eventKey: string
	type: string
	data?: unknown
	createdAt: number
}

export type WorkflowRunProjection = WorkflowRunWire

export interface RelayInstanceRecord extends RelayIdentity {
	canDriveUi: boolean
	heartbeatAt: number
	registeredAt: number
	metadata?: unknown
}

export interface UiLeaseOwner extends RelayIdentity {
	nonce: string
	actionId: string
	effectId?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	deadlineAt: number
	acquiredAt: number
	updatedAt: number
}

export interface UiLease {
	instanceId: string
	pid: number
	processStartedAt: string
	nonce: string
	actionId: string
	effectId?: string
}

export interface UiQuarantineRecord {
	active: boolean
	actionId?: string
	effectId?: string
	reason?: string
	owner?: RelayIdentity
	externalProcess?: ProcessIdentity & { processGroup?: number }
	createdAt?: number
	clearedAt?: number
	clearedBy?: string
}

export type AcquireUiLeaseResult =
	| { status: 'acquired'; lease: UiLease; reclaimed?: UiLeaseOwner }
	| { status: 'busy'; owner: UiLeaseOwner; reason: 'owner_alive' | 'external_process_alive' | 'changed' }
	| { status: 'quarantined'; quarantine: UiQuarantineRecord }

export type AbandonedEffectRecovery =
	| { status: 'owner_alive'; effect: WorkflowEffectRecord }
	| { status: 'external_process_alive'; effect: WorkflowEffectRecord }
	| { status: 'safely_prepared'; effect: WorkflowEffectRecord }
	| { status: 'ambiguous'; effect: WorkflowEffectRecord }
	| { status: 'unowned' | 'changed' | 'terminal'; effect: WorkflowEffectRecord }

export type AbandonedJobRecovery =
	| { status: 'owner_alive' | 'unsafe' | 'changed'; job: WorkflowJobRecord }
	| { status: 'requeued'; job: WorkflowJobRecord }

/** Structural match for `writes.ts` without coupling the coordinator to the actuator module. */
export interface OrchestrationSharedUiLeaseProvider {
	acquire(request: { priority: 'interactive' | 'background'; actionId?: string }): Promise<{
		markMayExecute(externalProcess?: ProcessIdentity & { processGroup?: number }): void | Promise<void>
		release(): void | Promise<void>
	}>
}

export class OrchestrationError extends Error {}

export class UnsupportedOrchestrationSchemaError extends OrchestrationError {
	readonly foundVersion: number
	readonly supportedVersion = ORCHESTRATION_SCHEMA_VERSION

	constructor(foundVersion: number) {
		super(`orchestration schema ${foundVersion} is newer than supported schema ${ORCHESTRATION_SCHEMA_VERSION}`)
		this.name = 'UnsupportedOrchestrationSchemaError'
		this.foundVersion = foundVersion
	}
}

export class IdempotencyConflictError extends OrchestrationError {
	readonly operation: string
	readonly clientId: string

	constructor(operation: string, clientId: string) {
		super(`clientId ${clientId} was already used with a different ${operation} request`)
		this.name = 'IdempotencyConflictError'
		this.operation = operation
		this.clientId = clientId
	}
}

export class WorkflowTransitionError extends OrchestrationError {
	constructor(message: string) {
		super(message)
		this.name = 'WorkflowTransitionError'
	}
}

export class UiLeaseUnavailableError extends OrchestrationError {
	readonly result: Exclude<AcquireUiLeaseResult, { status: 'acquired' }>

	constructor(result: Exclude<AcquireUiLeaseResult, { status: 'acquired' }>) {
		const message =
			result.status === 'busy'
				? `Conductor's UI is busy — held by relay PID ${result.owner.pid} (${result.reason}). Try again shortly.`
				: `Conductor's UI is quarantined — ${result.quarantine.reason ?? 'confirm Conductor is stable on the phone'}.`
		super(message)
		this.name = 'UiLeaseUnavailableError'
		this.result = result
	}
}

export interface OrchestrationDbOptions {
	now?: () => number
	processProbe?: ProcessProbe
	busyTimeoutMs?: number
	scrubPublicText?: (text: string) => string
}

const ACTIVE_PHASES: WorkflowPhase[] = [
	'creating_workspace',
	'binding_root',
	'pending_root',
	'exploring',
	'planning',
	'implementing',
	'reviewing',
	'blocked'
]
const RUNNABLE_PHASES: WorkflowPhase[] = ACTIVE_PHASES.filter(phase => phase !== 'blocked')
const ALL_JOB_STATES: WorkflowJobState[] = [
	'dormant',
	'queued',
	'owned',
	'opening',
	'configuring',
	'sending',
	'running',
	'returning',
	'returned',
	'failed',
	'cancelled'
]
const TERMINAL_EFFECT_STATES: WorkflowEffectState[] = ['committed', 'failed', 'ambiguous', 'cancelled']
const migrations = [ORCHESTRATION_BOOTSTRAP_SQL]
const sqliteRetryWait = new Int32Array(new SharedArrayBuffer(4))

const nonEmpty = (value: string, name: string): string => {
	if (!value.trim()) throw new OrchestrationError(`${name} must not be empty`)
	return value
}

const validateProcessIdentity = (identity: ProcessIdentity, name: string): void => {
	if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new OrchestrationError(`${name} PID is invalid`)
	nonEmpty(identity.processStartedAt, `${name} process-start identity`)
}

const validateRelayIdentity = (identity: RelayIdentity): void => {
	nonEmpty(identity.instanceId, 'relay instance ID')
	validateProcessIdentity(identity, 'relay')
	if (!Number.isSafeInteger(identity.protocolVersion) || identity.protocolVersion < 0) {
		throw new OrchestrationError('relay orchestration protocol is invalid')
	}
}

const json = (value: unknown): string => {
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new OrchestrationError('value is not JSON serializable')
	return encoded
}

const optionalJson = (value: unknown): string | null => (value === undefined ? null : json(value))

const jsonProperty = <TKey extends string, TValue>(key: TKey, stored: StoredJson<TValue> | null) =>
	stored === null ? {} : ({ [key]: stored.value } as Record<TKey, TValue>)

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
	value !== null &&
	(typeof value === 'object' || typeof value === 'function') &&
	typeof (value as { then?: unknown }).then === 'function'

const canonicalize = (value: unknown, inArray = false): unknown => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new OrchestrationError('canonical request contains a non-finite number')
		return Object.is(value, -0) ? 0 : value
	}
	if (typeof value === 'undefined') return inArray ? null : undefined
	if (Array.isArray(value)) return value.map(entry => canonicalize(entry, true))
	if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new OrchestrationError('canonical requests must contain only JSON objects and values')
	}
	const result: Record<string, unknown> = {}
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const normalized = canonicalize((value as Record<string, unknown>)[key])
		if (normalized !== undefined) result[key] = normalized
	}
	return result
}

export const canonicalRequestJson = (request: unknown): string => json(canonicalize(request))
export const canonicalRequestHash = (request: unknown): string =>
	createHash('sha256').update(canonicalRequestJson(request)).digest('hex')
export const hashCapabilityToken = (token: string): string =>
	createHash('sha256').update(nonEmpty(token, 'capability token')).digest('hex')

const isConstraintError = (error: unknown): boolean =>
	error instanceof Error && /constraint failed|unique constraint/i.test(error.message)

const ownerFromColumns = (row: {
	ownerInstanceId: string | null
	ownerPid: number | null
	ownerProcessStartedAt: string | null
	ownerProtocolVersion: number | null
}): RelayIdentity | undefined => {
	if (
		row.ownerInstanceId === null ||
		row.ownerPid === null ||
		row.ownerProcessStartedAt === null ||
		row.ownerProtocolVersion === null
	) {
		return undefined
	}
	return {
		instanceId: row.ownerInstanceId,
		pid: row.ownerPid,
		processStartedAt: row.ownerProcessStartedAt,
		protocolVersion: row.ownerProtocolVersion
	}
}

const externalFromColumns = (row: {
	externalPid: number | null
	externalProcessStartedAt: string | null
	externalProcessGroup: number | null
}): (ProcessIdentity & { processGroup?: number }) | undefined => {
	if (row.externalPid === null || row.externalProcessStartedAt === null) return undefined
	return {
		pid: row.externalPid,
		processStartedAt: row.externalProcessStartedAt,
		...(row.externalProcessGroup === null ? {} : { processGroup: row.externalProcessGroup })
	}
}

const sameProcess = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
	left.pid === right.pid && left.processStartedAt === right.processStartedAt

const sameOwner = (left: RelayIdentity, right: RelayIdentity): boolean =>
	left.instanceId === right.instanceId && left.protocolVersion === right.protocolVersion && sameProcess(left, right)

const processAuditKey = (identity: ProcessIdentity & { processGroup?: number }): string =>
	`${identity.pid}:${createHash('sha256')
		.update(`${identity.processStartedAt}\0${identity.processGroup ?? ''}`)
		.digest('hex')
		.slice(0, 16)}`

const ownerAuditKey = (owner: RelayIdentity): string =>
	createHash('sha256')
		.update(`${owner.instanceId}\0${owner.pid}\0${owner.processStartedAt}\0${owner.protocolVersion}`)
		.digest('hex')
		.slice(0, 16)

const defaultScrub = (text: string): string =>
	withoutWindowEvidence(scrubWorkflowSecrets(text))
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim()

/**
 * Durable, relay-owned Workflow coordinator state. Every mutating method is a
 * short synchronous `BEGIN IMMEDIATE` transaction. `idempotentMutation` callbacks
 * must therefore be synchronous; domain methods called inside one join its transaction.
 */
export class OrchestrationDb {
	private db: DatabaseSync
	private orm: NodeSQLiteDatabase
	private readonly now: () => number
	private readonly processProbe: ProcessProbe
	private readonly scrubPublicText: (text: string) => string
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

	private immediate<T>(operation: () => T): T {
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

	idempotentMutation<T>(
		operation: string,
		clientId: string,
		request: unknown,
		mutate: () => T,
		link: { runId?: string; actionId?: string } = {}
	): { replayed: boolean; result: T } {
		nonEmpty(operation, 'operation')
		nonEmpty(clientId, 'clientId')
		const requestHash = canonicalRequestHash(request)
		return this.immediate(() => {
			const existing = this.orm
				.select({ requestHash: workflowIdempotency.requestHash, result: workflowIdempotency.result })
				.from(workflowIdempotency)
				.where(and(eq(workflowIdempotency.operation, operation), eq(workflowIdempotency.clientId, clientId)))
				.get()
			if (existing) {
				if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(operation, clientId)
				return { replayed: true, result: existing.result as T }
			}

			const result = mutate()
			if (isPromiseLike(result)) throw new OrchestrationError('idempotent mutations must be synchronous')
			const resultRecord = asObject(result)
			const resultRunId = typeof resultRecord.runId === 'string' ? resultRecord.runId : undefined
			const resultActionId = typeof resultRecord.actionId === 'string' ? resultRecord.actionId : undefined
			this.db
				.prepare(
					`INSERT INTO workflow_idempotency
						(operation, client_id, request_hash, result_json, run_id, action_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					operation,
					clientId,
					requestHash,
					json(result),
					link.runId ?? resultRunId ?? null,
					link.actionId ?? resultActionId ?? null,
					this.now()
				)
			return { replayed: false, result }
		})
	}

	/**
	 * Read the stable result before re-running live preconditions. This matters for
	 * Workflow Start: after the first accepted request, its root is intentionally no
	 * longer pristine and roles.json may have changed, but an identical client retry
	 * must still receive the original accepted run.
	 */
	getIdempotentMutation<T>(operation: string, clientId: string, request: unknown): { result: T } | undefined {
		nonEmpty(operation, 'operation')
		nonEmpty(clientId, 'clientId')
		const existing = this.orm
			.select({ requestHash: workflowIdempotency.requestHash, result: workflowIdempotency.result })
			.from(workflowIdempotency)
			.where(and(eq(workflowIdempotency.operation, operation), eq(workflowIdempotency.clientId, clientId)))
			.get()
		if (!existing) return undefined
		if (existing.requestHash !== canonicalRequestHash(request)) {
			throw new IdempotencyConflictError(operation, clientId)
		}
		return { result: existing.result as T }
	}

	createWorkflowRun(input: {
		id?: string
		clientId: string
		objective: string
		target: WorkflowTarget
		roles: FrozenWorkflowRoles
		workspaceId?: string
		rootSessionId?: string
		pristineEvidence?: unknown
		deliveryBaseline?: unknown
		bootstrapPrompt?: string
		initialEffects?: Array<{
			id?: string
			actionId: string
			kind: string
			target?: unknown
			inputs?: unknown
			baseline?: unknown
			cursor?: unknown
		}>
		/** Compatibility shorthand for callers preparing exactly one initial effect. */
		initialEffect?: {
			id?: string
			actionId: string
			kind: string
			target?: unknown
			inputs?: unknown
			baseline?: unknown
			cursor?: unknown
		}
	}): { replayed: boolean; run: WorkflowRunRecord } {
		const initialEffects = input.initialEffects ?? (input.initialEffect ? [input.initialEffect] : [])
		if (new Set(initialEffects.map(effect => effect.actionId)).size !== initialEffects.length) {
			throw new OrchestrationError('initial Workflow effects must have unique action IDs')
		}
		// Idempotency belongs to the normalized UI request, not to derived preflight
		// evidence. Re-reading roles or the now-non-pristine root on a transport retry
		// must not turn the same tap into a conflict.
		const request = { objective: input.objective, target: input.target }
		let createdRunId: string | undefined
		const answer = this.idempotentMutation(
			'start_workflow',
			input.clientId,
			request,
			() => {
				const runId = input.id ?? randomUUID()
				createdRunId = runId
				const at = this.now()
				const phase: WorkflowPhase = input.target.kind === 'new_workspace' ? 'creating_workspace' : 'pending_root'
				if (input.target.kind === 'existing_session') {
					if (input.workspaceId && input.workspaceId !== input.target.workspaceId) {
						throw new OrchestrationError('workspace binding conflicts with the existing-session target')
					}
					if (input.rootSessionId && input.rootSessionId !== input.target.sessionId) {
						throw new OrchestrationError('root binding conflicts with the existing-session target')
					}
				}
				try {
					this.db
						.prepare(
							`INSERT INTO workflow_runs (
								id, objective, target_json, roles_json, phase, workspace_id, root_session_id,
								pristine_evidence_json, delivery_baseline_json, created_at, updated_at
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
						)
						.run(
							runId,
							nonEmpty(input.objective, 'objective'),
							json(input.target),
							json(input.roles),
							phase,
							input.target.kind === 'existing_session' ? input.target.workspaceId : (input.workspaceId ?? null),
							input.target.kind === 'existing_session' ? input.target.sessionId : (input.rootSessionId ?? null),
							optionalJson(input.pristineEvidence),
							optionalJson(input.deliveryBaseline),
							at,
							at
						)
				} catch (error) {
					if (isConstraintError(error)) {
						throw new WorkflowTransitionError('the root already belongs to an active Workflow')
					}
					throw error
				}

				this.insertJob({
					id: `${runId}:explore:0`,
					runId,
					logicalKey: 'explore:0',
					role: 'exploration',
					cycle: 0,
					revision: 0,
					resolvedRole: input.roles.exploration,
					prompt: input.bootstrapPrompt ?? input.objective,
					state: 'dormant',
					cancellationGeneration: 0,
					at
				})
				for (const effect of initialEffects) {
					this.insertEffect({
						...effect,
						id: effect.id ?? `${runId}:${effect.actionId}`,
						runId,
						at
					})
				}
				this.appendEvent(runId, 'workflow_started', 'workflow_started', {
					target: input.target,
					bootstrapJob: 'explore:0',
					initialActionIds: initialEffects.map(effect => effect.actionId)
				})
				return { runId }
			},
			{ runId: input.id, actionId: initialEffects[0]?.actionId }
		)
		const runId = answer.result.runId ?? createdRunId
		if (!runId) throw new OrchestrationError('idempotent Workflow result did not contain a run ID')
		const run = this.getWorkflowRun(runId)
		if (!run) throw new OrchestrationError(`Workflow ${runId} disappeared after creation`)
		return { replayed: answer.replayed, run }
	}

	getWorkflowRun(id: string): WorkflowRunRecord | undefined {
		const row = this.orm.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get()
		return row ? this.decodeRun(row) : undefined
	}

	findActiveWorkflowByRoot(rootSessionId: string): WorkflowRunRecord | undefined {
		const row = this.orm
			.select()
			.from(workflowRuns)
			.where(
				and(eq(workflowRuns.rootSessionId, rootSessionId), notInArray(workflowRuns.phase, ['completed', 'cancelled']))
			)
			.get()
		return row ? this.decodeRun(row) : undefined
	}

	transitionWorkflowRun(input: {
		runId: string
		expectedPhase?: WorkflowPhase | WorkflowPhase[]
		expectedCancellationGeneration: number
		phase?: WorkflowPhase
		cycle?: number
		revision?: number
		workspaceId?: string | null
		rootSessionId?: string | null
		pristineEvidence?: unknown
		deliveryBaseline?: unknown
		planningInterpretation?: string | null
		implementationBatonsDelivered?: number
		blocked?: WorkflowBlockedState | null
		eventKey: string
		eventType: string
		eventData?: unknown
	}): WorkflowRunRecord {
		return this.immediate(() => {
			const current = this.requireRun(input.runId)
			if (isTerminalWorkflowPhase(current.phase)) {
				throw new WorkflowTransitionError(`terminal Workflow ${current.id} cannot transition from ${current.phase}`)
			}
			this.checkRunGuard(current, input.expectedPhase, input.expectedCancellationGeneration)
			const phase = input.phase ?? current.phase
			const terminalAt = isTerminalWorkflowPhase(phase) ? (current.terminalAt ?? this.now()) : undefined
			const blocked = input.blocked === undefined ? current.blocked : (input.blocked ?? undefined)
			const at = this.now()
			try {
				this.db
					.prepare(
						`UPDATE workflow_runs SET
							phase = ?, cycle = ?, revision = ?, workspace_id = ?, root_session_id = ?,
							pristine_evidence_json = ?, delivery_baseline_json = ?, planning_interpretation = ?,
							blocked_action_id = ?, blocked_error_code = ?, blocked_message = ?, resume_phase = ?,
							retry_class = ?, blocked_candidates_json = ?, blocked_at = ?,
							implementation_batons_delivered = ?, updated_at = ?, terminal_at = ?
						 WHERE id = ? AND cancellation_generation = ?`
					)
					.run(
						phase,
						input.cycle ?? current.cycle,
						input.revision ?? current.revision,
						input.workspaceId === undefined ? (current.workspaceId ?? null) : input.workspaceId,
						input.rootSessionId === undefined ? (current.rootSessionId ?? null) : input.rootSessionId,
						input.pristineEvidence === undefined
							? optionalJson(current.pristineEvidence)
							: optionalJson(input.pristineEvidence),
						input.deliveryBaseline === undefined
							? optionalJson(current.deliveryBaseline)
							: optionalJson(input.deliveryBaseline),
						input.planningInterpretation === undefined
							? (current.planningInterpretation ?? null)
							: input.planningInterpretation,
						blocked?.actionId ?? null,
						blocked?.errorCode ?? null,
						blocked?.message ?? null,
						blocked?.resumePhase ?? null,
						blocked?.retryClass ?? null,
						optionalJson(blocked?.candidates),
						blocked ? (blocked.blockedAt ?? at) : null,
						input.implementationBatonsDelivered ?? current.implementationBatonsDelivered,
						at,
						terminalAt ?? null,
						input.runId,
						input.expectedCancellationGeneration
					)
			} catch (error) {
				if (isConstraintError(error)) {
					throw new WorkflowTransitionError('the requested root is already bound to another active Workflow')
				}
				throw error
			}
			this.appendEvent(input.runId, input.eventKey, input.eventType, input.eventData)
			return this.requireRun(input.runId)
		})
	}

	cancelWorkflowRun(runId: string, eventKey: string, eventData?: unknown): WorkflowRunRecord {
		return this.immediate(() => {
			const run = this.requireRun(runId)
			if (run.phase === 'cancelled') return run
			if (run.phase === 'completed') throw new WorkflowTransitionError('a completed Workflow cannot be cancelled')
			const at = this.now()
			const generation = run.cancellationGeneration + 1
			this.db
				.prepare(
					`UPDATE workflow_runs SET phase = 'cancelled', cancellation_generation = ?, updated_at = ?, terminal_at = ?,
						blocked_action_id = NULL, blocked_error_code = NULL, blocked_message = NULL, resume_phase = NULL,
						retry_class = NULL, blocked_candidates_json = NULL, blocked_at = NULL
					 WHERE id = ? AND cancellation_generation = ?`
				)
				.run(generation, at, at, runId, run.cancellationGeneration)
			this.db
				.prepare(
					`UPDATE workflow_jobs SET state = 'cancelled', cancellation_generation = ?, updated_at = ?, terminal_at = ?
					 WHERE run_id = ? AND state NOT IN ('returned', 'failed', 'cancelled')`
				)
				.run(generation, at, at, runId)
			this.db
				.prepare(
					`UPDATE workflow_job_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
					 WHERE job_id IN (SELECT id FROM workflow_jobs WHERE run_id = ?)
						AND state NOT IN ('returned', 'failed', 'cancelled')`
				)
				.run(at, at, runId)
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'cancelled', updated_at = ?, terminal_at = ?
					 WHERE run_id = ? AND state IN ('prepared', 'failed')`
				)
				.run(at, at, runId)
			this.db
				.prepare(
					`UPDATE workflow_effect_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
					 WHERE effect_id IN (SELECT id FROM workflow_effects WHERE run_id = ?) AND state = 'prepared'`
				)
				.run(at, at, runId)
			this.appendEvent(runId, eventKey, 'workflow_cancelled', eventData)
			return this.requireRun(runId)
		})
	}

	private requireRun(id: string): WorkflowRunRecord {
		const run = this.getWorkflowRun(id)
		if (!run) throw new WorkflowTransitionError(`Workflow ${id} does not exist`)
		return run
	}

	private checkRunGuard(
		run: WorkflowRunRecord,
		expectedPhase: WorkflowPhase | WorkflowPhase[] | undefined,
		expectedCancellationGeneration: number
	): void {
		const phases = Array.isArray(expectedPhase) ? expectedPhase : expectedPhase ? [expectedPhase] : undefined
		if (phases && !phases.includes(run.phase)) {
			throw new WorkflowTransitionError(`Workflow ${run.id} is ${run.phase}, expected ${phases.join(' or ')}`)
		}
		if (run.cancellationGeneration !== expectedCancellationGeneration) {
			throw new WorkflowTransitionError(`Workflow ${run.id} cancellation generation changed`)
		}
	}

	private decodeRun(candidate: WorkflowRunRow): WorkflowRunRecord {
		const row = workflowRunSelectSchema.parse(candidate)
		const blocked = row.blockedActionId
			? {
					actionId: row.blockedActionId,
					errorCode: row.blockedErrorCode ?? 'workflow_blocked',
					message: row.blockedMessage ?? 'Workflow is blocked',
					resumePhase: row.resumePhase ?? 'pending_root',
					retryClass: row.retryClass ?? 'terminal',
					...(row.blockedCandidates ? { candidates: row.blockedCandidates.value } : {}),
					...(row.blockedAt === null ? {} : { blockedAt: row.blockedAt })
				}
			: undefined
		return {
			id: row.id,
			objective: row.objective,
			target: row.target,
			roles: row.roles,
			phase: row.phase,
			cycle: row.cycle,
			revision: row.revision,
			...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
			...(row.rootSessionId === null ? {} : { rootSessionId: row.rootSessionId }),
			...jsonProperty('pristineEvidence', row.pristineEvidence),
			...jsonProperty('deliveryBaseline', row.deliveryBaseline),
			...(row.planningInterpretation === null ? {} : { planningInterpretation: row.planningInterpretation }),
			cancellationGeneration: row.cancellationGeneration,
			...(blocked ? { blocked } : {}),
			implementationBatonsDelivered: row.implementationBatonsDelivered,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt })
		}
	}

	private insertJob(input: {
		id: string
		runId: string
		logicalKey: string
		role: WorkflowJobRole
		cycle: number
		revision: number
		resolvedRole: FrozenWorkflowRole
		prompt: string
		state: WorkflowJobState
		cancellationGeneration: number
		transcriptCursor?: unknown
		at: number
	}): void {
		this.db
			.prepare(
				`INSERT INTO workflow_jobs (
					id, run_id, logical_key, role, cycle, revision, resolved_role_json, prompt, state, cancellation_generation,
					transcript_cursor_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.id,
				input.runId,
				input.logicalKey,
				input.role,
				input.cycle,
				input.revision,
				json(input.resolvedRole),
				input.prompt,
				input.state,
				input.cancellationGeneration,
				optionalJson(input.transcriptCursor),
				input.at,
				input.at
			)
	}

	createWorkflowJob(input: {
		id?: string
		runId: string
		logicalKey: string
		role: WorkflowJobRole
		cycle?: number
		revision?: number
		resolvedRole: FrozenWorkflowRole
		prompt: string
		state?: 'dormant' | 'queued'
		transcriptCursor?: unknown
		expectedCancellationGeneration: number
		eventKey: string
	}): { created: boolean; job: WorkflowJobRecord } {
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			this.checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
			const existing = this.orm
				.select()
				.from(workflowJobs)
				.where(and(eq(workflowJobs.runId, input.runId), eq(workflowJobs.logicalKey, input.logicalKey)))
				.get()
			if (existing) {
				const decoded = this.decodeJob(existing)
				if (
					decoded.role !== input.role ||
					decoded.cycle !== (input.cycle ?? run.cycle) ||
					decoded.revision !== (input.revision ?? run.revision) ||
					canonicalRequestJson(decoded.resolvedRole) !== canonicalRequestJson(input.resolvedRole) ||
					decoded.prompt !== input.prompt
				) {
					throw new WorkflowTransitionError(`logical job ${input.logicalKey} already has different frozen inputs`)
				}
				return { created: false, job: decoded }
			}
			const id = input.id ?? randomUUID()
			const at = this.now()
			this.insertJob({
				...input,
				id,
				cycle: input.cycle ?? run.cycle,
				revision: input.revision ?? run.revision,
				state: input.state ?? 'queued',
				cancellationGeneration: run.cancellationGeneration,
				at
			})
			this.touchRun(input.runId, at)
			this.appendEvent(input.runId, input.eventKey, 'workflow_job_created', {
				jobId: id,
				logicalKey: input.logicalKey,
				role: input.role,
				cycle: input.cycle ?? run.cycle,
				revision: input.revision ?? run.revision,
				state: input.state ?? 'queued'
			})
			return { created: true, job: this.requireJob(id) }
		})
	}

	activateWorkflowJob(
		jobId: string,
		expectedCancellationGeneration: number,
		eventKey: string,
		transcriptCursor?: unknown
	): WorkflowJobRecord {
		return this.updateWorkflowJob({
			jobId,
			expectedStates: ['dormant'],
			expectedCancellationGeneration,
			state: 'queued',
			...(transcriptCursor === undefined ? {} : { transcriptCursor }),
			eventKey,
			eventType: 'workflow_job_activated'
		})
	}

	getWorkflowJob(id: string): WorkflowJobRecord | undefined {
		const row = this.orm.select().from(workflowJobs).where(eq(workflowJobs.id, id)).get()
		return row ? this.decodeJob(row) : undefined
	}

	listWorkflowJobs(runId: string): WorkflowJobRecord[] {
		return this.orm
			.select()
			.from(workflowJobs)
			.where(eq(workflowJobs.runId, runId))
			.orderBy(asc(workflowJobs.createdAt), asc(workflowJobs.id))
			.all()
			.map(row => this.decodeJob(row))
	}

	claimNextWorkflowJob(owner: RelayIdentity, runId?: string): WorkflowJobRecord | undefined {
		validateRelayIdentity(owner)
		return this.immediate(() => {
			const row = this.orm
				.select({ job: workflowJobs })
				.from(workflowJobs)
				.innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
				.where(
					and(
						eq(workflowJobs.state, 'queued'),
						eq(workflowJobs.cancellationGeneration, workflowRuns.cancellationGeneration),
						notInArray(workflowRuns.phase, ['blocked', 'completed', 'cancelled']),
						runId === undefined ? undefined : eq(workflowJobs.runId, runId)
					)
				)
				.orderBy(asc(workflowJobs.createdAt), asc(workflowJobs.id))
				.limit(1)
				.get()?.job
			if (!row) return undefined
			const at = this.now()
			const result = this.db
				.prepare(
					`UPDATE workflow_jobs SET state = 'owned', owner_instance_id = ?, owner_pid = ?,
						owner_process_started_at = ?, owner_protocol_version = ?, updated_at = ?
					 WHERE id = ? AND state = 'queued'`
				)
				.run(owner.instanceId, owner.pid, owner.processStartedAt, owner.protocolVersion, at, row.id)
			if (Number(result.changes) !== 1) return undefined
			this.touchRun(row.runId, at)
			this.appendEvent(
				row.runId,
				`job_claimed:${row.id}:${row.attemptCount + 1}:${ownerAuditKey(owner)}`,
				'workflow_job_claimed',
				{
					jobId: row.id,
					ownerInstanceId: owner.instanceId
				}
			)
			return this.requireJob(row.id)
		})
	}

	/** Requeue only the pre-effect `owned` state after exact process death is proven. */
	reconcileAbandonedWorkflowJobClaim(input: {
		jobId: string
		eventKey: string
		processProbe?: ProcessProbe
	}): AbandonedJobRecovery {
		const observed = this.requireJob(input.jobId)
		if (!observed.owner || observed.state !== 'owned') return { status: 'unsafe', job: observed }
		const observedOwner = observed.owner
		const probe = input.processProbe ?? this.processProbe
		if (this.probeAlive(observedOwner, probe)) return { status: 'owner_alive', job: observed }
		return this.immediate(() => {
			const current = this.requireJob(input.jobId)
			if (
				current.state !== 'owned' ||
				!current.owner ||
				!sameOwner(current.owner, observedOwner) ||
				current.attemptCount !== observed.attemptCount
			) {
				return { status: 'changed', job: current }
			}
			const at = this.now()
			this.db
				.prepare(
					`UPDATE workflow_jobs SET state = 'queued', owner_instance_id = NULL, owner_pid = NULL,
						owner_process_started_at = NULL, owner_protocol_version = NULL, updated_at = ? WHERE id = ?`
				)
				.run(at, current.id)
			this.touchRun(current.runId, at)
			this.appendEvent(
				current.runId,
				`${input.eventKey}:${ownerAuditKey(observedOwner)}`,
				'workflow_job_claim_recovered',
				{
					jobId: current.id,
					abandonedInstanceId: observedOwner.instanceId
				}
			)
			return { status: 'requeued', job: this.requireJob(current.id) }
		})
	}

	updateWorkflowJob(input: {
		jobId: string
		expectedStates: WorkflowJobState[]
		expectedCancellationGeneration: number
		state: WorkflowJobState
		transcriptCursor?: unknown
		childSessionId?: string | null
		outcome?: unknown
		taskReceipt?: unknown
		batonReceipt?: unknown
		clearOwner?: boolean
		eventKey: string
		eventType: string
		eventData?: unknown
	}): WorkflowJobRecord {
		return this.immediate(() => {
			const job = this.requireJob(input.jobId)
			const run = this.requireRun(job.runId)
			if (isTerminalWorkflowPhase(run.phase) || job.state === 'cancelled') {
				throw new WorkflowTransitionError(`cannot advance terminal job ${job.id}`)
			}
			this.checkRunGuard(run, undefined, input.expectedCancellationGeneration)
			if (!input.expectedStates.includes(job.state)) {
				throw new WorkflowTransitionError(
					`job ${job.id} is ${job.state}, expected ${input.expectedStates.join(' or ')}`
				)
			}
			const at = this.now()
			const terminalAt = isTerminalWorkflowJobState(input.state) ? (job.terminalAt ?? at) : null
			const result = this.db
				.prepare(
					`UPDATE workflow_jobs SET state = ?, transcript_cursor_json = ?, child_session_id = ?, outcome_json = ?, task_receipt_json = ?,
						baton_receipt_json = ?, owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?,
						owner_protocol_version = ?, updated_at = ?, terminal_at = ?
					 WHERE id = ? AND state = ? AND cancellation_generation = ?`
				)
				.run(
					input.state,
					input.transcriptCursor === undefined
						? optionalJson(job.transcriptCursor)
						: optionalJson(input.transcriptCursor),
					input.childSessionId === undefined ? (job.childSessionId ?? null) : input.childSessionId,
					input.outcome === undefined ? optionalJson(job.outcome) : optionalJson(input.outcome),
					input.taskReceipt === undefined ? optionalJson(job.taskReceipt) : optionalJson(input.taskReceipt),
					input.batonReceipt === undefined ? optionalJson(job.batonReceipt) : optionalJson(input.batonReceipt),
					input.clearOwner ? null : (job.owner?.instanceId ?? null),
					input.clearOwner ? null : (job.owner?.pid ?? null),
					input.clearOwner ? null : (job.owner?.processStartedAt ?? null),
					input.clearOwner ? null : (job.owner?.protocolVersion ?? null),
					at,
					terminalAt,
					job.id,
					job.state,
					input.expectedCancellationGeneration
				)
			if (Number(result.changes) !== 1) throw new WorkflowTransitionError(`job ${job.id} changed concurrently`)
			this.touchRun(job.runId, at)
			this.appendEvent(job.runId, input.eventKey, input.eventType, { jobId: job.id, ...asObject(input.eventData) })
			return this.requireJob(job.id)
		})
	}

	createWorkflowJobAttempt(input: {
		jobId: string
		owner: RelayIdentity
		state?: WorkflowJobState
		childSessionId?: string
		effectIds?: { open?: string; configure?: string; task?: string; baton?: string }
	}): WorkflowJobAttemptRecord {
		validateRelayIdentity(input.owner)
		return this.immediate(() => {
			const job = this.requireJob(input.jobId)
			const run = this.requireRun(job.runId)
			if (
				run.phase === 'completed' ||
				run.phase === 'cancelled' ||
				job.cancellationGeneration !== run.cancellationGeneration
			) {
				throw new WorkflowTransitionError(`cannot create an attempt for inactive job ${job.id}`)
			}
			if (job.state === 'cancelled' || job.state === 'returned') {
				throw new WorkflowTransitionError(`cannot attempt ${job.state} job ${job.id}`)
			}
			if (job.state !== 'owned' || !job.owner || !sameOwner(job.owner, input.owner)) {
				throw new WorkflowTransitionError(`job ${job.id} is not claimed by this relay`)
			}
			const attemptNumber = job.attemptCount + 1
			const id = `${job.id}:attempt:${attemptNumber}`
			const at = this.now()
			this.db
				.prepare(
					`INSERT INTO workflow_job_attempts (
						id, job_id, attempt_number, state, child_session_id, open_effect_id, configure_effect_id,
						task_effect_id, baton_effect_id, owner_instance_id, owner_pid, owner_process_started_at,
						owner_protocol_version, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					id,
					job.id,
					attemptNumber,
					input.state ?? job.state,
					input.childSessionId ?? null,
					input.effectIds?.open ?? null,
					input.effectIds?.configure ?? null,
					input.effectIds?.task ?? null,
					input.effectIds?.baton ?? null,
					input.owner.instanceId,
					input.owner.pid,
					input.owner.processStartedAt,
					input.owner.protocolVersion,
					at,
					at
				)
			this.db
				.prepare('UPDATE workflow_jobs SET attempt_count = ?, updated_at = ? WHERE id = ?')
				.run(attemptNumber, at, job.id)
			this.touchRun(job.runId, at)
			this.appendEvent(job.runId, `job_attempt:${job.id}:${attemptNumber}`, 'workflow_job_attempt_created', {
				jobId: job.id,
				attemptNumber
			})
			return this.requireJobAttempt(id)
		})
	}

	listWorkflowJobAttempts(jobId: string): WorkflowJobAttemptRecord[] {
		return this.orm
			.select()
			.from(workflowJobAttempts)
			.where(eq(workflowJobAttempts.jobId, jobId))
			.orderBy(asc(workflowJobAttempts.attemptNumber))
			.all()
			.map(row => this.decodeJobAttempt(row))
	}

	updateWorkflowJobAttempt(input: {
		jobId: string
		attemptNumber: number
		expectedState: WorkflowJobState
		state: WorkflowJobState
		childSessionId?: string | null
		outcome?: unknown
		failureEvidence?: unknown
		eventKey: string
		eventType: string
	}): WorkflowJobAttemptRecord {
		return this.immediate(() => {
			const job = this.requireJob(input.jobId)
			const run = this.requireRun(job.runId)
			if (
				run.phase === 'completed' ||
				run.phase === 'cancelled' ||
				job.state === 'cancelled' ||
				job.cancellationGeneration !== run.cancellationGeneration
			) {
				throw new WorkflowTransitionError(`cannot advance an attempt for inactive job ${job.id}`)
			}
			const id = `${job.id}:attempt:${input.attemptNumber}`
			const attempt = this.requireJobAttempt(id)
			if (attempt.state !== input.expectedState) {
				throw new WorkflowTransitionError(
					`job attempt ${input.attemptNumber} is ${attempt.state}, expected ${input.expectedState}`
				)
			}
			const at = this.now()
			const terminalAt = isTerminalWorkflowJobState(input.state) ? at : null
			const result = this.db
				.prepare(
					`UPDATE workflow_job_attempts SET state = ?, child_session_id = ?, outcome_json = ?,
						failure_evidence_json = ?, updated_at = ?, terminal_at = ?
					 WHERE id = ? AND state = ?`
				)
				.run(
					input.state,
					input.childSessionId === undefined ? (attempt.childSessionId ?? null) : input.childSessionId,
					input.outcome === undefined ? optionalJson(attempt.outcome) : optionalJson(input.outcome),
					input.failureEvidence === undefined
						? optionalJson(attempt.failureEvidence)
						: optionalJson(input.failureEvidence),
					at,
					terminalAt,
					id,
					input.expectedState
				)
			if (Number(result.changes) !== 1) throw new WorkflowTransitionError(`job attempt ${id} changed concurrently`)
			this.touchRun(job.runId, at)
			this.appendEvent(job.runId, input.eventKey, input.eventType, {
				jobId: job.id,
				attemptNumber: input.attemptNumber,
				state: input.state
			})
			return this.requireJobAttempt(id)
		})
	}

	/** Preserve an outcome observed after cancellation without reopening the job. */
	recordLateWorkflowChildResult(input: {
		runId: string
		jobId: string
		attemptNumber?: number
		outcome: unknown
		eventKey: string
	}): WorkflowJobRecord {
		return this.immediate(() => {
			const job = this.requireJob(input.jobId)
			const run = this.requireRun(input.runId)
			if (job.runId !== run.id) throw new WorkflowTransitionError(`job ${job.id} does not belong to Workflow ${run.id}`)
			if (run.phase !== 'cancelled' || job.state !== 'cancelled') {
				throw new WorkflowTransitionError(`job ${job.id} is not a cancelled late-result target`)
			}
			const attemptNumber = input.attemptNumber ?? job.attemptCount
			const attempt = attemptNumber > 0 ? this.requireJobAttempt(`${job.id}:attempt:${attemptNumber}`) : undefined
			const prior = this.findEvent(run.id, input.eventKey)
			if (prior) {
				if (prior.type !== 'late_child_result' || canonicalOptional(job.outcome) !== canonicalOptional(input.outcome)) {
					throw new WorkflowTransitionError(`late child event ${input.eventKey} conflicts with existing evidence`)
				}
				return job
			}
			const at = this.now()
			this.db
				.prepare('UPDATE workflow_jobs SET outcome_json = ?, updated_at = ? WHERE id = ?')
				.run(json(input.outcome), at, job.id)
			if (attempt) {
				this.db
					.prepare('UPDATE workflow_job_attempts SET outcome_json = ?, updated_at = ? WHERE id = ?')
					.run(json(input.outcome), at, attempt.id)
			}
			this.appendEvent(run.id, input.eventKey, 'late_child_result', {
				jobId: job.id,
				attemptNumber,
				outcome: input.outcome
			})
			return this.requireJob(job.id)
		})
	}

	private requireJob(id: string): WorkflowJobRecord {
		const job = this.getWorkflowJob(id)
		if (!job) throw new WorkflowTransitionError(`Workflow job ${id} does not exist`)
		return job
	}

	private decodeJob(candidate: WorkflowJobRow): WorkflowJobRecord {
		const row = workflowJobSelectSchema.parse(candidate)
		const owner = ownerFromColumns(row)
		return {
			id: row.id,
			runId: row.runId,
			logicalKey: row.logicalKey,
			role: row.role,
			cycle: row.cycle,
			revision: row.revision,
			resolvedRole: row.resolvedRole,
			prompt: row.prompt,
			state: row.state,
			cancellationGeneration: row.cancellationGeneration,
			...(owner ? { owner } : {}),
			...jsonProperty('transcriptCursor', row.transcriptCursor),
			...(row.childSessionId === null ? {} : { childSessionId: row.childSessionId }),
			...jsonProperty('outcome', row.outcome),
			...jsonProperty('taskReceipt', row.taskReceipt),
			...jsonProperty('batonReceipt', row.batonReceipt),
			attemptCount: row.attemptCount,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt })
		}
	}

	private requireJobAttempt(id: string): WorkflowJobAttemptRecord {
		const row = this.orm.select().from(workflowJobAttempts).where(eq(workflowJobAttempts.id, id)).get()
		if (!row) throw new WorkflowTransitionError(`Workflow job attempt ${id} does not exist`)
		return this.decodeJobAttempt(row)
	}

	private decodeJobAttempt(candidate: WorkflowJobAttemptRow): WorkflowJobAttemptRecord {
		const row = workflowJobAttemptSelectSchema.parse(candidate)
		const owner = ownerFromColumns(row)
		return {
			id: row.id,
			jobId: row.jobId,
			attemptNumber: row.attemptNumber,
			state: row.state,
			...(row.childSessionId === null ? {} : { childSessionId: row.childSessionId }),
			...(row.openEffectId === null ? {} : { openEffectId: row.openEffectId }),
			...(row.configureEffectId === null ? {} : { configureEffectId: row.configureEffectId }),
			...(row.taskEffectId === null ? {} : { taskEffectId: row.taskEffectId }),
			...(row.batonEffectId === null ? {} : { batonEffectId: row.batonEffectId }),
			...jsonProperty('outcome', row.outcome),
			...jsonProperty('failureEvidence', row.failureEvidence),
			...(owner ? { owner } : {}),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt })
		}
	}

	private insertEffect(input: {
		id: string
		runId: string
		actionId: string
		kind: string
		jobId?: string
		target?: unknown
		inputs?: unknown
		baseline?: unknown
		cursor?: unknown
		at: number
	}): void {
		this.db
			.prepare(
				`INSERT INTO workflow_effects (
					id, run_id, action_id, job_id, kind, state, target_json, inputs_json, baseline_json,
					cursor_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.id,
				input.runId,
				input.actionId,
				input.jobId ?? null,
				nonEmpty(input.kind, 'effect kind'),
				optionalJson(input.target),
				optionalJson(input.inputs),
				optionalJson(input.baseline),
				optionalJson(input.cursor),
				input.at,
				input.at
			)
	}

	prepareWorkflowEffect(input: {
		id?: string
		runId: string
		actionId: string
		kind: string
		jobId?: string
		target?: unknown
		inputs?: unknown
		baseline?: unknown
		cursor?: unknown
		expectedCancellationGeneration: number
		eventKey: string
	}): { created: boolean; effect: WorkflowEffectRecord } {
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			this.checkRunGuard(run, ACTIVE_PHASES, input.expectedCancellationGeneration)
			const existing = this.orm
				.select()
				.from(workflowEffects)
				.where(and(eq(workflowEffects.runId, input.runId), eq(workflowEffects.actionId, input.actionId)))
				.get()
			if (existing) {
				const effect = this.decodeEffect(existing)
				const same =
					effect.kind === input.kind &&
					effect.jobId === input.jobId &&
					canonicalOptional(effect.target) === canonicalOptional(input.target) &&
					canonicalOptional(effect.inputs) === canonicalOptional(input.inputs) &&
					canonicalOptional(effect.baseline) === canonicalOptional(input.baseline) &&
					canonicalOptional(effect.cursor) === canonicalOptional(input.cursor)
				if (!same) throw new WorkflowTransitionError(`action ${input.actionId} already has different frozen inputs`)
				return { created: false, effect }
			}
			const id = input.id ?? randomUUID()
			const at = this.now()
			this.insertEffect({ ...input, id, at })
			this.touchRun(input.runId, at)
			this.appendEvent(input.runId, input.eventKey, 'workflow_effect_prepared', {
				effectId: id,
				actionId: input.actionId,
				kind: input.kind,
				jobId: input.jobId
			})
			return { created: true, effect: this.requireEffect(id) }
		})
	}

	getWorkflowEffect(runId: string, actionId: string): WorkflowEffectRecord | undefined {
		const row = this.orm
			.select()
			.from(workflowEffects)
			.where(and(eq(workflowEffects.runId, runId), eq(workflowEffects.actionId, actionId)))
			.get()
		return row ? this.decodeEffect(row) : undefined
	}

	listWorkflowEffects(runId: string): WorkflowEffectRecord[] {
		return this.orm
			.select()
			.from(workflowEffects)
			.where(eq(workflowEffects.runId, runId))
			.orderBy(asc(workflowEffects.createdAt), asc(workflowEffects.id))
			.all()
			.map(row => this.decodeEffect(row))
	}

	/** Commit a positively reconciled settings match without entering the UI dispatch boundary. */
	markWorkflowEffectSatisfiedWithoutDispatch(input: {
		runId: string
		actionId: string
		expectedCancellationGeneration: number
		receipt: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			this.checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
			const effect = this.requireEffectByAction(input.runId, input.actionId)
			if (effect.kind !== 'configure_root' && effect.kind !== 'configure_child') {
				throw new WorkflowTransitionError(`effect ${input.actionId} is not a configuration effect`)
			}
			if (effect.state !== 'prepared' || effect.owner || effect.mayExecute) {
				throw new WorkflowTransitionError(`effect ${input.actionId} is not an unowned prepared configuration`)
			}
			const at = this.now()
			const result = this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'committed', receipt_json = ?, updated_at = ?, terminal_at = ?
					 WHERE id = ? AND state = 'prepared' AND owner_instance_id IS NULL AND may_execute = 0`
				)
				.run(json(input.receipt), at, at, effect.id)
			if (Number(result.changes) !== 1) {
				throw new WorkflowTransitionError(`configuration effect ${input.actionId} changed concurrently`)
			}
			this.touchRun(input.runId, at)
			this.appendEvent(
				input.runId,
				input.eventKey ?? `effect_satisfied_without_dispatch:${input.actionId}`,
				'workflow_effect_satisfied_without_dispatch',
				{ effectId: effect.id, actionId: effect.actionId, receipt: input.receipt }
			)
			return this.requireEffect(effect.id)
		})
	}

	claimPreparedWorkflowEffect(input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		expectedCancellationGeneration: number
	}): { effect: WorkflowEffectRecord; attempt: WorkflowEffectAttemptRecord } | undefined {
		validateRelayIdentity(input.owner)
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			this.checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
			const effect = this.getWorkflowEffect(input.runId, input.actionId)
			if (effect?.state !== 'prepared' || effect.owner) return undefined
			const attemptNumber = effect.attemptCount + 1
			const attemptId = `${effect.id}:attempt:${attemptNumber}`
			const at = this.now()
			const result = this.db
				.prepare(
					`UPDATE workflow_effects SET owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?,
						owner_protocol_version = ?, attempt_count = ?, updated_at = ?
					 WHERE id = ? AND state = 'prepared' AND owner_instance_id IS NULL`
				)
				.run(
					input.owner.instanceId,
					input.owner.pid,
					input.owner.processStartedAt,
					input.owner.protocolVersion,
					attemptNumber,
					at,
					effect.id
				)
			if (Number(result.changes) !== 1) return undefined
			this.db
				.prepare(
					`INSERT INTO workflow_effect_attempts (
						id, effect_id, attempt_number, state, owner_instance_id, owner_pid,
						owner_process_started_at, owner_protocol_version, created_at, updated_at
					) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`
				)
				.run(
					attemptId,
					effect.id,
					attemptNumber,
					input.owner.instanceId,
					input.owner.pid,
					input.owner.processStartedAt,
					input.owner.protocolVersion,
					at,
					at
				)
			this.touchRun(input.runId, at)
			this.appendEvent(input.runId, `effect_claimed:${input.actionId}:${attemptNumber}`, 'workflow_effect_claimed', {
				effectId: effect.id,
				actionId: input.actionId,
				attemptNumber
			})
			return { effect: this.requireEffect(effect.id), attempt: this.requireEffectAttempt(attemptId) }
		})
	}

	markWorkflowEffectDispatched(input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		launchNonce: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
		mayExecute?: boolean
		eventKey?: string
	}): WorkflowEffectRecord {
		validateRelayIdentity(input.owner)
		if (input.externalProcess) validateProcessIdentity(input.externalProcess, 'external effect process')
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			if (!RUNNABLE_PHASES.includes(run.phase)) {
				throw new WorkflowTransitionError(`Workflow ${run.id} cannot dispatch a UI effect while ${run.phase}`)
			}
			return this.transitionEffect({
				...input,
				from: ['prepared'],
				to: 'dispatched',
				mayExecute: input.mayExecute ?? false,
				eventKey: input.eventKey ?? `effect_dispatched:${input.actionId}:${input.attemptNumber}`,
				eventType: 'workflow_effect_dispatched'
			})
		})
	}

	markWorkflowEffectMayExecute(input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		launchNonce: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
	}): WorkflowEffectRecord {
		validateRelayIdentity(input.owner)
		if (input.externalProcess) validateProcessIdentity(input.externalProcess, 'external effect process')
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			if (!RUNNABLE_PHASES.includes(run.phase)) {
				throw new WorkflowTransitionError(`Workflow ${run.id} cannot release a UI gate while ${run.phase}`)
			}
			const effect = this.requireEffectByAction(input.runId, input.actionId)
			this.requireEffectOwner(effect, input.owner, input.attemptNumber)
			if (effect.state !== 'dispatched' || effect.launchNonce !== input.launchNonce) {
				throw new WorkflowTransitionError(`effect ${input.actionId} is not the matching dispatched attempt`)
			}
			const identityKey = input.externalProcess ? processAuditKey(input.externalProcess) : 'in-process'
			const eventKey = `effect_may_execute:${input.actionId}:${input.attemptNumber}:${identityKey}`
			const prior = this.findEvent(input.runId, eventKey)
			if (prior) {
				if (prior.type !== 'workflow_effect_may_execute') {
					throw new WorkflowTransitionError(`effect execution event ${eventKey} conflicts with existing audit`)
				}
				return effect
			}
			const at = this.now()
			const externalProcess = input.externalProcess ?? effect.externalProcess
			this.db
				.prepare(
					`UPDATE workflow_effects SET may_execute = 1, external_pid = ?, external_process_started_at = ?,
						external_process_group = ?, updated_at = ? WHERE id = ?`
				)
				.run(
					externalProcess?.pid ?? null,
					externalProcess?.processStartedAt ?? null,
					externalProcess?.processGroup ?? null,
					at,
					effect.id
				)
			this.db
				.prepare(
					`UPDATE workflow_effect_attempts SET may_execute = 1, external_pid = ?,
						external_process_started_at = ?, external_process_group = ?, updated_at = ?
					 WHERE effect_id = ? AND attempt_number = ?`
				)
				.run(
					externalProcess?.pid ?? null,
					externalProcess?.processStartedAt ?? null,
					externalProcess?.processGroup ?? null,
					at,
					effect.id,
					input.attemptNumber
				)
			this.touchRun(input.runId, at)
			this.appendEvent(input.runId, eventKey, 'workflow_effect_may_execute', {
				effectId: effect.id,
				actionId: input.actionId,
				attemptNumber: input.attemptNumber,
				...(input.externalProcess ? { externalProcess: input.externalProcess } : {})
			})
			return this.requireEffect(effect.id)
		})
	}

	markWorkflowEffectCommitted(input: {
		runId: string
		actionId: string
		owner?: RelayIdentity
		attemptNumber?: number
		receipt: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.transitionEffect({
			...input,
			from: ['dispatched', 'ambiguous'],
			to: 'committed',
			eventKey: input.eventKey ?? `effect_committed:${input.actionId}`,
			eventType: 'workflow_effect_committed'
		})
	}

	markWorkflowEffectFailed(input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.transitionEffect({
			...input,
			from: ['prepared'],
			to: 'failed',
			eventKey: input.eventKey ?? `effect_failed:${input.actionId}:${input.attemptNumber}`,
			eventType: 'workflow_effect_failed'
		})
	}

	markWorkflowEffectFailedBeforeMayExecute(input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.transitionEffect({
			...input,
			from: ['dispatched'],
			to: 'failed',
			requireMayExecute: false,
			mayExecute: false,
			eventKey: input.eventKey ?? `effect_failed_before_execute:${input.actionId}:${input.attemptNumber}`,
			eventType: 'workflow_effect_failed_before_may_execute'
		})
	}

	markWorkflowEffectAmbiguous(input: {
		runId: string
		actionId: string
		owner?: RelayIdentity
		attemptNumber?: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.transitionEffect({
			...input,
			from: ['dispatched'],
			to: 'ambiguous',
			eventKey: input.eventKey ?? `effect_ambiguous:${input.actionId}`,
			eventType: 'workflow_effect_ambiguous'
		})
	}

	markWorkflowEffectReceiptLost(input: {
		runId: string
		actionId: string
		expectedReceipt: unknown
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}): WorkflowEffectRecord {
		return this.immediate(() => {
			const effect = this.requireEffectByAction(input.runId, input.actionId)
			const receipt = asObject(input.expectedReceipt)
			if (receipt.kind !== 'outbox' || typeof receipt.id !== 'string') {
				throw new WorkflowTransitionError('only a tagged outbox receipt can become lost')
			}
			if (canonicalOptional(effect.receipt) !== canonicalOptional(input.expectedReceipt)) {
				throw new WorkflowTransitionError(`effect ${input.actionId} receipt changed before loss reconciliation`)
			}
			if (effect.state === 'ambiguous' && effect.errorCode === input.errorCode) return effect
			if (effect.state !== 'committed') {
				throw new WorkflowTransitionError(`effect ${input.actionId} is ${effect.state}, expected committed`)
			}
			const at = this.now()
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'ambiguous', error_code = ?, error_message = ?,
						updated_at = ?, terminal_at = ? WHERE id = ? AND state = 'committed'`
				)
				.run(input.errorCode, input.errorMessage, at, at, effect.id)
			if (effect.attemptCount > 0) {
				this.db
					.prepare(
						`UPDATE workflow_effect_attempts SET state = 'ambiguous', evidence_json = ?, error_code = ?,
							error_message = ?, updated_at = ?, terminal_at = ? WHERE effect_id = ? AND attempt_number = ?`
					)
					.run(
						optionalJson(input.evidence),
						input.errorCode,
						input.errorMessage,
						at,
						at,
						effect.id,
						effect.attemptCount
					)
			}
			this.touchRun(input.runId, at)
			this.appendEvent(
				input.runId,
				input.eventKey ?? `effect_receipt_lost:${input.actionId}:${String(receipt.id)}`,
				'workflow_effect_receipt_lost',
				{ effectId: effect.id, actionId: input.actionId, errorCode: input.errorCode }
			)
			return this.requireEffect(effect.id)
		})
	}

	/** Record a post-cancellation receipt without reopening the run or effect. */
	recordLateWorkflowEffect(input: {
		runId: string
		actionId: string
		receipt: unknown
		eventKey: string
	}): WorkflowEffectRecord {
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			if (run.phase !== 'cancelled') {
				throw new WorkflowTransitionError(`Workflow ${run.id} is not cancelled`)
			}
			const effect = this.requireEffectByAction(run.id, input.actionId)
			const prior = this.findEvent(run.id, input.eventKey)
			if (prior) {
				if (prior.type !== 'late_effect' || canonicalOptional(effect.receipt) !== canonicalOptional(input.receipt)) {
					throw new WorkflowTransitionError(`late effect event ${input.eventKey} conflicts with existing evidence`)
				}
				return effect
			}
			const at = this.now()
			const settled = effect.state === 'dispatched' || effect.state === 'ambiguous'
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = ?, receipt_json = ?, error_code = ?, error_message = ?,
						updated_at = ?, terminal_at = COALESCE(terminal_at, ?) WHERE id = ?`
				)
				.run(
					settled ? 'committed' : effect.state,
					json(input.receipt),
					settled ? null : (effect.errorCode ?? null),
					settled ? null : (effect.errorMessage ?? null),
					at,
					settled ? at : (effect.terminalAt ?? null),
					effect.id
				)
			if (effect.attemptCount > 0) {
				this.db
					.prepare(
						`UPDATE workflow_effect_attempts SET state = CASE WHEN state IN ('dispatched', 'ambiguous') THEN 'committed' ELSE state END,
							receipt_json = ?, error_code = CASE WHEN state IN ('dispatched', 'ambiguous') THEN NULL ELSE error_code END,
							error_message = CASE WHEN state IN ('dispatched', 'ambiguous') THEN NULL ELSE error_message END,
							updated_at = ?, terminal_at = CASE WHEN state IN ('dispatched', 'ambiguous') THEN COALESCE(terminal_at, ?) ELSE terminal_at END
						 WHERE effect_id = ? AND attempt_number = ?`
					)
					.run(json(input.receipt), at, at, effect.id, effect.attemptCount)
			}
			const receipt = asObject(input.receipt)
			const deliveredMessage =
				receipt.kind === 'message' &&
				typeof receipt.id === 'string' &&
				Number.isSafeInteger(receipt.rowid) &&
				(receipt.turnId === null || typeof receipt.turnId === 'string')
			if (effect.jobId && deliveredMessage && (effect.kind === 'send_task' || effect.kind === 'return_baton')) {
				const receiptColumn = effect.kind === 'send_task' ? 'task_receipt_json' : 'baton_receipt_json'
				this.db
					.prepare(`UPDATE workflow_jobs SET ${receiptColumn} = ?, updated_at = ? WHERE id = ? AND run_id = ?`)
					.run(json(input.receipt), at, effect.jobId, run.id)
			}
			// A positive receipt is stronger than an earlier ambiguity. Clear only the
			// hold for this exact effect inside the same transaction; a newer unrelated
			// quarantine can never be erased by a late callback.
			this.db
				.prepare(
					`UPDATE ui_quarantine SET active = 0, cleared_at = ?, cleared_by = ?
					 WHERE id = 1 AND active = 1 AND (
						effect_id = ? OR (effect_id IS NULL AND action_id IN (?, ?))
					 )`
				)
				.run(at, `late-effect:${input.eventKey}`, effect.id, effect.id, effect.actionId)
			this.touchRun(run.id, at)
			this.appendEvent(run.id, input.eventKey, 'late_effect', {
				effectId: effect.id,
				actionId: effect.actionId,
				receipt: input.receipt
			})
			return this.requireEffect(effect.id)
		})
	}

	markWorkflowEffectCancelled(input: { runId: string; actionId: string; eventKey?: string }): WorkflowEffectRecord {
		return this.transitionEffect({
			...input,
			from: ['prepared', 'failed'],
			to: 'cancelled',
			eventKey: input.eventKey ?? `effect_cancelled:${input.actionId}`,
			eventType: 'workflow_effect_cancelled'
		})
	}

	/**
	 * Reconcile an orphan only after the caller checked for a positive receipt.
	 * A dead owner before `mayExecute` is safely reset; every later boundary is ambiguous.
	 */
	reconcileAbandonedWorkflowEffect(input: {
		runId: string
		actionId: string
		eventKey: string
		processProbe?: ProcessProbe
	}): AbandonedEffectRecovery {
		const observed = this.requireEffectByAction(input.runId, input.actionId)
		if (!observed.owner) return { status: 'unowned', effect: observed }
		if (TERMINAL_EFFECT_STATES.includes(observed.state)) return { status: 'terminal', effect: observed }
		const probe = input.processProbe ?? this.processProbe
		if (this.probeAlive(observed.owner, probe)) return { status: 'owner_alive', effect: observed }
		if (observed.externalProcess && this.probeAlive(observed.externalProcess, probe)) {
			return { status: 'external_process_alive', effect: observed }
		}

		return this.immediate(() => {
			const current = this.requireEffectByAction(input.runId, input.actionId)
			const run = this.requireRun(input.runId)
			if (
				!current.owner ||
				!sameOwner(current.owner, observed.owner as RelayIdentity) ||
				current.state !== observed.state ||
				current.attemptCount !== observed.attemptCount ||
				current.mayExecute !== observed.mayExecute ||
				!sameOptionalProcess(current.externalProcess, observed.externalProcess)
			) {
				return { status: 'changed', effect: current }
			}
			const safelyPrepared = current.state === 'prepared' || (current.state === 'dispatched' && !current.mayExecute)
			const terminalRun = isTerminalWorkflowPhase(run.phase)
			const at = this.now()
			if (safelyPrepared) {
				this.db
					.prepare(
						`UPDATE workflow_effects SET state = ?, owner_instance_id = NULL, owner_pid = NULL,
							owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
							external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
							may_execute = 0, error_code = NULL, error_message = NULL, updated_at = ?, terminal_at = ?
						 WHERE id = ?`
					)
					.run(terminalRun ? 'cancelled' : 'prepared', at, terminalRun ? at : null, current.id)
				if (current.attemptCount > 0) {
					this.db
						.prepare(
							`UPDATE workflow_effect_attempts SET state = 'cancelled', evidence_json = ?, updated_at = ?, terminal_at = ?
							 WHERE effect_id = ? AND attempt_number = ?`
						)
						.run(json({ reason: 'owner_died_before_may_execute' }), at, at, current.id, current.attemptCount)
				}
				this.touchRun(current.runId, at)
				this.appendEvent(
					current.runId,
					input.eventKey,
					terminalRun ? 'workflow_effect_cancelled_after_owner_exit' : 'workflow_effect_safely_recovered',
					{
						effectId: current.id,
						actionId: current.actionId,
						attemptNumber: current.attemptCount
					}
				)
				return {
					status: terminalRun ? 'terminal' : 'safely_prepared',
					effect: this.requireEffect(current.id)
				}
			}

			this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'ambiguous', error_code = 'ambiguous_effect',
						error_message = 'The UI action may have executed before its relay owner exited.',
						updated_at = ?, terminal_at = ? WHERE id = ?`
				)
				.run(at, at, current.id)
			if (current.attemptCount > 0) {
				this.db
					.prepare(
						`UPDATE workflow_effect_attempts SET state = 'ambiguous', error_code = 'ambiguous_effect',
							error_message = 'The UI action may have executed before its relay owner exited.',
							updated_at = ?, terminal_at = ? WHERE effect_id = ? AND attempt_number = ?`
					)
					.run(at, at, current.id, current.attemptCount)
			}
			this.touchRun(current.runId, at)
			this.appendEvent(current.runId, input.eventKey, 'workflow_effect_abandoned_ambiguous', {
				effectId: current.id,
				actionId: current.actionId,
				attemptNumber: current.attemptCount
			})
			return { status: 'ambiguous', effect: this.requireEffect(current.id) }
		})
	}

	retryWorkflowEffect(runId: string, actionId: string, eventKey: string): WorkflowEffectRecord {
		return this.immediate(() => {
			const run = this.requireRun(runId)
			if (isTerminalWorkflowPhase(run.phase)) {
				throw new WorkflowTransitionError(`terminal Workflow ${run.id} cannot retry effects`)
			}
			const effect = this.requireEffectByAction(runId, actionId)
			if (effect.state !== 'failed')
				throw new WorkflowTransitionError(`effect ${actionId} is not deterministically failed`)
			const at = this.now()
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'prepared', owner_instance_id = NULL, owner_pid = NULL,
						owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
						external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
						may_execute = 0, error_code = NULL, error_message = NULL, updated_at = ?, terminal_at = NULL
					 WHERE id = ?`
				)
				.run(at, effect.id)
			this.touchRun(runId, at)
			this.appendEvent(runId, eventKey, 'workflow_effect_retry_prepared', {
				effectId: effect.id,
				actionId,
				nextAttempt: effect.attemptCount + 1
			})
			return this.requireEffect(effect.id)
		})
	}

	/** Used only behind the explicit, idempotent phone confirmation for duplicate risk. */
	replayAmbiguousWorkflowEffect(runId: string, actionId: string, eventKey: string): WorkflowEffectRecord {
		return this.immediate(() => {
			const run = this.requireRun(runId)
			if (isTerminalWorkflowPhase(run.phase)) {
				throw new WorkflowTransitionError(`terminal Workflow ${run.id} cannot replay effects`)
			}
			const effect = this.requireEffectByAction(runId, actionId)
			if (effect.state !== 'ambiguous') {
				throw new WorkflowTransitionError(`effect ${actionId} is not ambiguous`)
			}
			const at = this.now()
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = 'prepared', owner_instance_id = NULL, owner_pid = NULL,
						owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
						external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
						may_execute = 0, receipt_json = NULL, error_code = NULL, error_message = NULL,
						updated_at = ?, terminal_at = NULL WHERE id = ?`
				)
				.run(at, effect.id)
			this.touchRun(runId, at)
			this.appendEvent(runId, eventKey, 'workflow_effect_risky_replay_prepared', {
				effectId: effect.id,
				actionId,
				previousAttempt: effect.attemptCount,
				nextAttempt: effect.attemptCount + 1
			})
			return this.requireEffect(effect.id)
		})
	}

	private transitionEffect(input: {
		runId: string
		actionId: string
		from: WorkflowEffectState[]
		to: WorkflowEffectState
		owner?: RelayIdentity
		attemptNumber?: number
		launchNonce?: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
		mayExecute?: boolean
		requireMayExecute?: boolean
		receipt?: unknown
		errorCode?: string
		errorMessage?: string
		evidence?: unknown
		eventKey: string
		eventType: string
	}): WorkflowEffectRecord {
		return this.immediate(() => {
			const effect = this.requireEffectByAction(input.runId, input.actionId)
			const run = this.requireRun(input.runId)
			if (!input.from.includes(effect.state)) {
				throw new WorkflowTransitionError(
					`effect ${input.actionId} is ${effect.state}, expected ${input.from.join(' or ')}`
				)
			}
			if (input.requireMayExecute !== undefined && effect.mayExecute !== input.requireMayExecute) {
				throw new WorkflowTransitionError(`effect ${input.actionId} mayExecute evidence changed`)
			}
			const attemptNumber = input.attemptNumber ?? (effect.attemptCount > 0 ? effect.attemptCount : undefined)
			if (input.owner && attemptNumber !== undefined) {
				this.requireEffectOwner(effect, input.owner, attemptNumber)
			}
			const at = this.now()
			const terminalAt = TERMINAL_EFFECT_STATES.includes(input.to) ? at : null
			const externalProcess = input.externalProcess ?? effect.externalProcess
			this.db
				.prepare(
					`UPDATE workflow_effects SET state = ?, launch_nonce = ?, external_pid = ?,
						external_process_started_at = ?, external_process_group = ?, may_execute = ?, receipt_json = ?,
						error_code = ?, error_message = ?, updated_at = ?, terminal_at = ? WHERE id = ?`
				)
				.run(
					input.to,
					input.launchNonce ?? effect.launchNonce ?? null,
					externalProcess?.pid ?? null,
					externalProcess?.processStartedAt ?? null,
					externalProcess?.processGroup ?? null,
					input.mayExecute === undefined ? (effect.mayExecute ? 1 : 0) : input.mayExecute ? 1 : 0,
					input.receipt === undefined ? optionalJson(effect.receipt) : optionalJson(input.receipt),
					input.errorCode ?? effect.errorCode ?? null,
					input.errorMessage ?? effect.errorMessage ?? null,
					at,
					terminalAt,
					effect.id
				)
			if (attemptNumber !== undefined) {
				this.db
					.prepare(
						`UPDATE workflow_effect_attempts SET state = ?, launch_nonce = ?, external_pid = ?,
							external_process_started_at = ?, external_process_group = ?, may_execute = ?, receipt_json = ?,
							evidence_json = ?, error_code = ?, error_message = ?, updated_at = ?, terminal_at = ?
						 WHERE effect_id = ? AND attempt_number = ?`
					)
					.run(
						input.to,
						input.launchNonce ?? effect.launchNonce ?? null,
						externalProcess?.pid ?? null,
						externalProcess?.processStartedAt ?? null,
						externalProcess?.processGroup ?? null,
						input.mayExecute === undefined ? (effect.mayExecute ? 1 : 0) : input.mayExecute ? 1 : 0,
						input.receipt === undefined ? optionalJson(effect.receipt) : optionalJson(input.receipt),
						optionalJson(input.evidence),
						input.errorCode ?? null,
						input.errorMessage ?? null,
						at,
						terminalAt,
						effect.id,
						attemptNumber
					)
			}
			this.touchRun(input.runId, at)
			const late = input.to === 'committed' && isTerminalWorkflowPhase(run.phase)
			this.appendEvent(input.runId, input.eventKey, late ? 'late_effect' : input.eventType, {
				effectId: effect.id,
				actionId: input.actionId,
				attemptNumber,
				errorCode: input.errorCode,
				...(late ? { intendedEventType: input.eventType } : {})
			})
			return this.requireEffect(effect.id)
		})
	}

	private requireEffectByAction(runId: string, actionId: string): WorkflowEffectRecord {
		const effect = this.getWorkflowEffect(runId, actionId)
		if (!effect) throw new WorkflowTransitionError(`Workflow effect ${actionId} does not exist`)
		return effect
	}

	private requireEffect(id: string): WorkflowEffectRecord {
		const row = this.orm.select().from(workflowEffects).where(eq(workflowEffects.id, id)).get()
		if (!row) throw new WorkflowTransitionError(`Workflow effect ${id} does not exist`)
		return this.decodeEffect(row)
	}

	private decodeEffect(candidate: WorkflowEffectRow): WorkflowEffectRecord {
		const row = workflowEffectSelectSchema.parse(candidate)
		const owner = ownerFromColumns(row)
		const externalProcess = externalFromColumns(row)
		return {
			id: row.id,
			runId: row.runId,
			actionId: row.actionId,
			...(row.jobId === null ? {} : { jobId: row.jobId }),
			kind: row.kind,
			state: row.state,
			...jsonProperty('target', row.target),
			...jsonProperty('inputs', row.inputs),
			...jsonProperty('baseline', row.baseline),
			...jsonProperty('cursor', row.cursor),
			...jsonProperty('receipt', row.receipt),
			...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
			...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
			...(owner ? { owner } : {}),
			...(row.launchNonce === null ? {} : { launchNonce: row.launchNonce }),
			...(externalProcess ? { externalProcess } : {}),
			mayExecute: row.mayExecute,
			attemptCount: row.attemptCount,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt })
		}
	}

	private requireEffectAttempt(id: string): WorkflowEffectAttemptRecord {
		const row = this.orm.select().from(workflowEffectAttempts).where(eq(workflowEffectAttempts.id, id)).get()
		if (!row) throw new WorkflowTransitionError(`Workflow effect attempt ${id} does not exist`)
		return this.decodeEffectAttempt(row)
	}

	listWorkflowEffectAttempts(effectId: string): WorkflowEffectAttemptRecord[] {
		return this.orm
			.select()
			.from(workflowEffectAttempts)
			.where(eq(workflowEffectAttempts.effectId, effectId))
			.orderBy(asc(workflowEffectAttempts.attemptNumber))
			.all()
			.map(row => this.decodeEffectAttempt(row))
	}

	private decodeEffectAttempt(candidate: WorkflowEffectAttemptRow): WorkflowEffectAttemptRecord {
		const row = workflowEffectAttemptSelectSchema.parse(candidate)
		const id = row.id
		const owner = ownerFromColumns(row)
		if (!owner) throw new OrchestrationError(`Workflow effect attempt ${id} has no owner`)
		const externalProcess = externalFromColumns(row)
		return {
			id,
			effectId: row.effectId,
			attemptNumber: row.attemptNumber,
			state: row.state,
			owner,
			...(row.launchNonce === null ? {} : { launchNonce: row.launchNonce }),
			...(externalProcess ? { externalProcess } : {}),
			mayExecute: row.mayExecute,
			...jsonProperty('receipt', row.receipt),
			...jsonProperty('evidence', row.evidence),
			...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
			...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt })
		}
	}

	private requireEffectOwner(effect: WorkflowEffectRecord, owner: RelayIdentity, attemptNumber: number): void {
		if (!effect.owner || !sameOwner(effect.owner, owner) || effect.attemptCount !== attemptNumber) {
			throw new WorkflowTransitionError(`effect ${effect.actionId} is not owned by this relay attempt`)
		}
	}

	getWorkflowCapability(tokenHash: string): WorkflowCapabilityRecord | undefined {
		const candidate = this.orm
			.select()
			.from(workflowCapabilities)
			.where(eq(workflowCapabilities.tokenHash, tokenHash.toLowerCase()))
			.get()
		if (!candidate) return undefined
		const row = workflowCapabilitySelectSchema.parse(candidate)
		return {
			id: row.id,
			tokenHash: row.tokenHash,
			runId: row.runId,
			rootSessionId: row.rootSessionId,
			cycle: row.cycle,
			phase: row.phase,
			revision: row.revision,
			allowedRoles: row.allowedRoles,
			...(row.issuedWithRowid === null
				? {}
				: {
						issuedWith: {
							rowid: row.issuedWithRowid,
							...(row.issuedWithTurnId === null ? {} : { turnId: row.issuedWithTurnId })
						}
					}),
			...(row.consumedAt === null ? {} : { consumedAt: row.consumedAt }),
			...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
			createdAt: row.createdAt
		}
	}

	issueWorkflowCapability(input: {
		id?: string
		tokenHash: string
		runId: string
		rootSessionId: string
		cycle: number
		phase: WorkflowPhase
		revision: number
		allowedRoles: WorkflowJobRole[]
		issuedWith?: { rowid: number; turnId?: string }
		eventKey: string
	}): string {
		if (!/^[a-f\d]{64}$/i.test(input.tokenHash))
			throw new OrchestrationError('capability token hash must be SHA-256 hex')
		return this.immediate(() => {
			const run = this.requireRun(input.runId)
			if (run.rootSessionId !== input.rootSessionId)
				throw new WorkflowTransitionError('capability root does not match Workflow')
			if (run.phase !== input.phase || run.cycle !== input.cycle || run.revision !== input.revision) {
				throw new WorkflowTransitionError('capability coordinates do not match Workflow')
			}
			const id = input.id ?? randomUUID()
			const at = this.now()
			this.db
				.prepare(
					`INSERT INTO workflow_capabilities (
						id, token_hash, run_id, root_session_id, cycle, phase, revision, allowed_roles_json,
						issued_with_rowid, issued_with_turn_id, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					id,
					input.tokenHash.toLowerCase(),
					input.runId,
					input.rootSessionId,
					input.cycle,
					input.phase,
					input.revision,
					json([...new Set(input.allowedRoles)].sort()),
					input.issuedWith?.rowid ?? null,
					input.issuedWith?.turnId ?? null,
					at
				)
			this.appendEvent(input.runId, input.eventKey, 'workflow_capability_issued', {
				capabilityId: id,
				phase: input.phase,
				cycle: input.cycle,
				revision: input.revision,
				allowedRoles: input.allowedRoles,
				issuedWith: input.issuedWith
			})
			return id
		})
	}

	consumeWorkflowCapability(input: {
		tokenHash: string
		runId: string
		rootSessionId: string
		role: WorkflowJobRole
		expectedPhase: WorkflowPhase
		expectedCycle: number
		expectedRevision: number
		eventKey: string
	}): string {
		return this.immediate(() => {
			const capability = this.getWorkflowCapability(input.tokenHash)
			if (
				!capability ||
				capability.runId !== input.runId ||
				capability.rootSessionId !== input.rootSessionId ||
				capability.phase !== input.expectedPhase ||
				capability.cycle !== input.expectedCycle ||
				capability.revision !== input.expectedRevision ||
				capability.consumedAt !== undefined ||
				capability.revokedAt !== undefined ||
				!capability.allowedRoles.includes(input.role)
			) {
				throw new WorkflowTransitionError('Workflow capability is invalid, stale, consumed, or wrong-role')
			}
			const run = this.requireRun(input.runId)
			if (
				run.rootSessionId !== input.rootSessionId ||
				run.phase !== input.expectedPhase ||
				run.cycle !== input.expectedCycle ||
				run.revision !== input.expectedRevision
			) {
				throw new WorkflowTransitionError('Workflow advanced past this capability')
			}
			const at = this.now()
			this.db.prepare('UPDATE workflow_capabilities SET consumed_at = ? WHERE id = ?').run(at, capability.id)
			this.appendEvent(input.runId, input.eventKey, 'workflow_capability_consumed', {
				capabilityId: capability.id,
				role: input.role
			})
			return capability.id
		})
	}

	revokeWorkflowCapabilities(runId: string, eventKey: string, phase?: WorkflowPhase): number {
		return this.immediate(() => {
			const at = this.now()
			const result = this.db
				.prepare(
					`UPDATE workflow_capabilities SET revoked_at = ?
					 WHERE run_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND (? IS NULL OR phase = ?)`
				)
				.run(at, runId, phase ?? null, phase ?? null)
			const count = Number(result.changes)
			this.appendEvent(runId, eventKey, 'workflow_capabilities_revoked', { phase, count })
			return count
		})
	}

	listWorkflowEvents(runId: string): WorkflowEventRecord[] {
		return this.orm
			.select()
			.from(workflowEvents)
			.where(eq(workflowEvents.runId, runId))
			.orderBy(asc(workflowEvents.id))
			.all()
			.map(row => this.decodeEvent(row))
	}

	private findEvent(runId: string, eventKey: string): WorkflowEventRecord | undefined {
		const row = this.orm
			.select()
			.from(workflowEvents)
			.where(and(eq(workflowEvents.runId, runId), eq(workflowEvents.eventKey, eventKey)))
			.get()
		return row ? this.decodeEvent(row) : undefined
	}

	private decodeEvent(candidate: WorkflowEventRow): WorkflowEventRecord {
		const row = workflowEventSelectSchema.parse(candidate)
		return {
			id: row.id,
			runId: row.runId,
			eventKey: row.eventKey,
			type: row.type,
			...jsonProperty('data', row.data),
			createdAt: row.createdAt
		}
	}

	private appendEvent(runId: string, eventKey: string, type: string, data?: unknown): void {
		this.db
			.prepare('INSERT INTO workflow_events(run_id, event_key, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
			.run(runId, nonEmpty(eventKey, 'event key'), nonEmpty(type, 'event type'), optionalJson(data), this.now())
	}

	private touchRun(runId: string, at: number): void {
		this.db.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(at, runId)
	}

	registerRelayInstance(input: RelayIdentity & { canDriveUi?: boolean; metadata?: unknown }): RelayInstanceRecord {
		validateRelayIdentity(input)
		return this.immediate(() => {
			const at = this.now()
			this.db
				.prepare(
					`INSERT INTO relay_instances (
						instance_id, pid, process_started_at, protocol_version, can_drive_ui,
						heartbeat_at, registered_at, metadata_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(instance_id) DO UPDATE SET
						pid = excluded.pid,
						process_started_at = excluded.process_started_at,
						protocol_version = excluded.protocol_version,
						can_drive_ui = excluded.can_drive_ui,
						heartbeat_at = excluded.heartbeat_at,
						registered_at = CASE
							WHEN relay_instances.pid = excluded.pid
							 AND relay_instances.process_started_at = excluded.process_started_at
							THEN relay_instances.registered_at ELSE excluded.registered_at END,
						metadata_json = excluded.metadata_json`
				)
				.run(
					input.instanceId,
					input.pid,
					input.processStartedAt,
					input.protocolVersion,
					input.canDriveUi === false ? 0 : 1,
					at,
					at,
					optionalJson(input.metadata)
				)
			return this.requireRelayInstance(input.instanceId)
		})
	}

	heartbeatRelayInstance(identity: RelayIdentity): boolean {
		return this.immediate(() => {
			const result = this.db
				.prepare(
					`UPDATE relay_instances SET heartbeat_at = ?
					 WHERE instance_id = ? AND pid = ? AND process_started_at = ? AND protocol_version = ?`
				)
				.run(this.now(), identity.instanceId, identity.pid, identity.processStartedAt, identity.protocolVersion)
			return Number(result.changes) === 1
		})
	}

	listRelayInstances(): RelayInstanceRecord[] {
		return this.orm
			.select()
			.from(relayInstances)
			.orderBy(asc(relayInstances.registeredAt), asc(relayInstances.instanceId))
			.all()
			.map(candidate => {
				const row = relayInstanceSelectSchema.parse(candidate)
				return {
					instanceId: row.instanceId,
					pid: row.pid,
					processStartedAt: row.processStartedAt,
					protocolVersion: row.protocolVersion,
					canDriveUi: row.canDriveUi,
					heartbeatAt: row.heartbeatAt,
					registeredAt: row.registeredAt,
					...jsonProperty('metadata', row.metadata)
				}
			})
	}

	findIncompatibleRelayInstances(
		current: RelayIdentity,
		probe: ProcessProbe = this.processProbe
	): RelayInstanceRecord[] {
		return this.listRelayInstances().filter(instance => {
			if (!instance.canDriveUi || sameOwner(instance, current) || instance.protocolVersion === current.protocolVersion)
				return false
			return this.probeAlive(instance, probe)
		})
	}

	private requireRelayInstance(instanceId: string): RelayInstanceRecord {
		const instance = this.listRelayInstances().find(entry => entry.instanceId === instanceId)
		if (!instance) throw new OrchestrationError(`relay instance ${instanceId} does not exist`)
		return instance
	}

	acquireUiLease(input: {
		owner: RelayIdentity
		actionId: string
		effectId?: string
		deadlineAt: number
		priority: 'interactive' | 'background'
		nonce?: string
		processProbe?: ProcessProbe
	}): AcquireUiLeaseResult {
		validateRelayIdentity(input.owner)
		const probe = input.processProbe ?? this.processProbe
		const observed = this.readUiLeaseOwner()
		const ownerAlive = observed ? this.probeAlive(observed, probe) : false
		const externalAlive = observed?.externalProcess ? this.probeAlive(observed.externalProcess, probe) : false
		return this.immediate(() => {
			this.assertRelayRegistered(input.owner)
			const quarantine = this.getUiQuarantine()
			if (quarantine.active && input.priority === 'background') return { status: 'quarantined', quarantine }

			const current = this.readUiLeaseOwner()
			if (observed && (!current || !sameLeaseSnapshot(observed, current))) {
				return current ? { status: 'busy', owner: current, reason: 'changed' } : this.assignUiLease(input)
			}
			if (!observed && current) return { status: 'busy', owner: current, reason: 'changed' }
			if (current) {
				if (ownerAlive) return { status: 'busy', owner: current, reason: 'owner_alive' }
				if (current.externalProcess && externalAlive) {
					return { status: 'busy', owner: current, reason: 'external_process_alive' }
				}
				if (current.mayExecute) {
					this.clearUiMutex(current)
					const hold = this.activateUiQuarantine({
						actionId: current.actionId,
						effectId: current.effectId,
						reason: 'a dead UI lease owner may have emitted an external action',
						owner: current,
						externalProcess: current.externalProcess
					})
					if (input.priority === 'background') return { status: 'quarantined', quarantine: hold }
					return this.assignUiLease(input, current)
				}
				this.clearUiMutex(current)
				return this.assignUiLease(input, current)
			}
			return this.assignUiLease(input)
		})
	}

	private assertRelayRegistered(owner: RelayIdentity): void {
		const row = this.db
			.prepare(
				`SELECT 1 present FROM relay_instances
				 WHERE instance_id = ? AND pid = ? AND process_started_at = ? AND protocol_version = ? AND can_drive_ui = 1`
			)
			.get(owner.instanceId, owner.pid, owner.processStartedAt, owner.protocolVersion) as
			| { present: number }
			| undefined
		if (!row)
			throw new OrchestrationError(`relay ${owner.instanceId} is not registered as this live UI-driving process`)
	}

	private assignUiLease(
		input: {
			owner: RelayIdentity
			actionId: string
			effectId?: string
			deadlineAt: number
			nonce?: string
		},
		reclaimed?: UiLeaseOwner
	): AcquireUiLeaseResult {
		const nonce = input.nonce ?? randomUUID()
		const at = this.now()
		const result = this.db
			.prepare(
				`UPDATE ui_mutex SET owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?,
					owner_protocol_version = ?, nonce = ?, action_id = ?, effect_id = ?, external_pid = NULL,
					external_process_started_at = NULL, external_process_group = NULL, may_execute = 0,
					deadline_at = ?, acquired_at = ?, updated_at = ?
				 WHERE id = 1 AND owner_instance_id IS NULL`
			)
			.run(
				input.owner.instanceId,
				input.owner.pid,
				input.owner.processStartedAt,
				input.owner.protocolVersion,
				nonce,
				nonEmpty(input.actionId, 'UI action ID'),
				input.effectId ?? null,
				input.deadlineAt,
				at,
				at
			)
		if (Number(result.changes) !== 1) {
			const owner = this.readUiLeaseOwner()
			if (!owner) throw new OrchestrationError('UI mutex changed while being acquired')
			return { status: 'busy', owner, reason: 'changed' }
		}
		return {
			status: 'acquired',
			lease: {
				instanceId: input.owner.instanceId,
				pid: input.owner.pid,
				processStartedAt: input.owner.processStartedAt,
				nonce,
				actionId: input.actionId,
				...(input.effectId ? { effectId: input.effectId } : {})
			},
			...(reclaimed ? { reclaimed } : {})
		}
	}

	markUiLeaseMayExecute(
		lease: UiLease,
		externalProcess?: ProcessIdentity & { processGroup?: number },
		deadlineAt?: number
	): boolean {
		if (externalProcess) validateProcessIdentity(externalProcess, 'external UI process')
		return this.immediate(() => {
			const result = this.db
				.prepare(
					`UPDATE ui_mutex SET may_execute = 1, external_pid = COALESCE(?, external_pid),
						external_process_started_at = COALESCE(?, external_process_started_at),
						external_process_group = CASE WHEN ? IS NULL THEN external_process_group ELSE ? END,
						deadline_at = COALESCE(?, deadline_at), updated_at = ?
					 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ?
						AND nonce = ? AND action_id = ?`
				)
				.run(
					externalProcess?.pid ?? null,
					externalProcess?.processStartedAt ?? null,
					externalProcess?.pid ?? null,
					externalProcess?.processGroup ?? null,
					deadlineAt ?? null,
					this.now(),
					lease.instanceId,
					lease.pid,
					lease.processStartedAt,
					lease.nonce,
					lease.actionId
				)
			return Number(result.changes) === 1
		})
	}

	renewUiLease(lease: UiLease, deadlineAt: number): boolean {
		return this.immediate(() => {
			const result = this.db
				.prepare(
					`UPDATE ui_mutex SET deadline_at = ?, updated_at = ?
					 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ?
						AND nonce = ? AND action_id = ?`
				)
				.run(deadlineAt, this.now(), lease.instanceId, lease.pid, lease.processStartedAt, lease.nonce, lease.actionId)
			return Number(result.changes) === 1
		})
	}

	releaseUiLease(lease: UiLease): boolean {
		const observed = this.readUiLeaseOwner()
		if (
			observed &&
			observed.instanceId === lease.instanceId &&
			observed.pid === lease.pid &&
			observed.processStartedAt === lease.processStartedAt &&
			observed.nonce === lease.nonce &&
			observed.actionId === lease.actionId &&
			observed.externalProcess &&
			this.probeAlive(observed.externalProcess, this.processProbe)
		) {
			// A returned/failed caller is not proof that a detached helper (or one of
			// its process-group children) is gone. Retain the durable owner so the
			// watchdog can terminate and prove the exact group dead before reclaim.
			return false
		}
		return this.immediate(() => {
			const result = this.db
				.prepare(
					`UPDATE ui_mutex SET owner_instance_id = NULL, owner_pid = NULL, owner_process_started_at = NULL,
						owner_protocol_version = NULL, nonce = NULL, action_id = NULL, effect_id = NULL,
						external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
						may_execute = 0, deadline_at = NULL, acquired_at = NULL, updated_at = ?
					 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ?
						AND nonce = ? AND action_id = ?`
				)
				.run(this.now(), lease.instanceId, lease.pid, lease.processStartedAt, lease.nonce, lease.actionId)
			return Number(result.changes) === 1
		})
	}

	getUiLeaseOwner(): UiLeaseOwner | undefined {
		return this.readUiLeaseOwner()
	}

	/** Adapter installed with `configureSharedUiLeaseProvider` in `writes.ts`. */
	createSharedUiLeaseProvider(
		owner: RelayIdentity,
		options: { leaseMs?: number } = {}
	): OrchestrationSharedUiLeaseProvider {
		const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000)
		return {
			acquire: async request => {
				const result = this.acquireUiLease({
					owner,
					actionId: request.actionId ?? `ui:${owner.instanceId}:${randomUUID()}`,
					deadlineAt: this.now() + leaseMs,
					priority: request.priority
				})
				if (result.status !== 'acquired') throw new UiLeaseUnavailableError(result)
				return {
					markMayExecute: externalProcess => {
						if (!this.markUiLeaseMayExecute(result.lease, externalProcess)) {
							throw new OrchestrationError('lost the shared UI lease before dispatch')
						}
					},
					release: () => {
						if (!this.releaseUiLease(result.lease)) {
							throw new OrchestrationError(
								'shared UI lease release did not match its durable owner or its external process is still live'
							)
						}
					}
				}
			}
		}
	}

	private readUiLeaseOwner(): UiLeaseOwner | undefined {
		const candidate = this.orm.select().from(uiMutex).where(eq(uiMutex.id, 1)).get()
		if (!candidate) throw new OrchestrationError('orchestration UI mutex singleton is missing')
		const row = uiMutexSelectSchema.parse(candidate)
		const owner = ownerFromColumns(row)
		if (
			!owner ||
			row.nonce === null ||
			row.actionId === null ||
			row.deadlineAt === null ||
			row.acquiredAt === null ||
			row.updatedAt === null
		) {
			return undefined
		}
		const externalProcess = externalFromColumns(row)
		return {
			...owner,
			nonce: row.nonce,
			actionId: row.actionId,
			...(row.effectId === null ? {} : { effectId: row.effectId }),
			...(externalProcess ? { externalProcess } : {}),
			mayExecute: row.mayExecute,
			deadlineAt: row.deadlineAt,
			acquiredAt: row.acquiredAt,
			updatedAt: row.updatedAt
		}
	}

	private clearUiMutex(expected: UiLeaseOwner): void {
		this.db
			.prepare(
				`UPDATE ui_mutex SET owner_instance_id = NULL, owner_pid = NULL, owner_process_started_at = NULL,
					owner_protocol_version = NULL, nonce = NULL, action_id = NULL, effect_id = NULL,
					external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
					may_execute = 0, deadline_at = NULL, acquired_at = NULL, updated_at = ?
				 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ? AND nonce = ?`
			)
			.run(this.now(), expected.instanceId, expected.pid, expected.processStartedAt, expected.nonce)
	}

	activateUiQuarantine(input: {
		actionId: string
		effectId?: string
		reason: string
		owner?: RelayIdentity
		externalProcess?: ProcessIdentity & { processGroup?: number }
	}): UiQuarantineRecord {
		return this.immediate(() => {
			const current = this.getUiQuarantine()
			if (current.active) return current
			const at = this.now()
			this.db
				.prepare(
					`UPDATE ui_quarantine SET active = 1, action_id = ?, effect_id = ?, reason = ?,
						owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?, owner_protocol_version = ?,
						external_pid = ?, external_process_started_at = ?, external_process_group = ?,
						created_at = ?, cleared_at = NULL, cleared_by = NULL WHERE id = 1`
				)
				.run(
					input.actionId,
					input.effectId ?? null,
					nonEmpty(input.reason, 'quarantine reason'),
					input.owner?.instanceId ?? null,
					input.owner?.pid ?? null,
					input.owner?.processStartedAt ?? null,
					input.owner?.protocolVersion ?? null,
					input.externalProcess?.pid ?? null,
					input.externalProcess?.processStartedAt ?? null,
					input.externalProcess?.processGroup ?? null,
					at
				)
			return this.getUiQuarantine()
		})
	}

	clearUiQuarantine(clearedBy: string): boolean {
		return this.immediate(() => {
			const result = this.db
				.prepare('UPDATE ui_quarantine SET active = 0, cleared_at = ?, cleared_by = ? WHERE id = 1 AND active = 1')
				.run(this.now(), nonEmpty(clearedBy, 'quarantine clearer'))
			return Number(result.changes) === 1
		})
	}

	getUiQuarantine(): UiQuarantineRecord {
		const candidate = this.orm.select().from(uiQuarantine).where(eq(uiQuarantine.id, 1)).get()
		if (!candidate) throw new OrchestrationError('orchestration UI quarantine singleton is missing')
		const row = uiQuarantineSelectSchema.parse(candidate)
		const owner = ownerFromColumns(row)
		const externalProcess = externalFromColumns(row)
		return {
			active: row.active,
			...(row.actionId === null ? {} : { actionId: row.actionId }),
			...(row.effectId === null ? {} : { effectId: row.effectId }),
			...(row.reason === null ? {} : { reason: row.reason }),
			...(owner ? { owner } : {}),
			...(externalProcess ? { externalProcess } : {}),
			...(row.createdAt === null ? {} : { createdAt: row.createdAt }),
			...(row.clearedAt === null ? {} : { clearedAt: row.clearedAt }),
			...(row.clearedBy === null ? {} : { clearedBy: row.clearedBy })
		}
	}

	private probeAlive(identity: ProcessIdentity, probe: ProcessProbe): boolean {
		try {
			return probe(identity)
		} catch {
			// Failure to prove death must never authorize overlap.
			return true
		}
	}

	getWorkflowProjection(runId: string): WorkflowRunProjection | undefined {
		const run = this.getWorkflowRun(runId)
		return run ? this.projectRun(run) : undefined
	}

	listWorkflowProjections(options: { includeTerminal?: boolean } = {}): WorkflowRunProjection[] {
		return this.orm
			.select()
			.from(workflowRuns)
			.where(options.includeTerminal ? undefined : notInArray(workflowRuns.phase, ['completed', 'cancelled']))
			.orderBy(desc(workflowRuns.updatedAt))
			.all()
			.map(row => this.projectRun(this.decodeRun(row)))
	}

	/**
	 * The sidebar keeps the identity of the newest Workflow that touched each live
	 * workspace after that run reaches a terminal phase. Limit the query to the
	 * workspaces on screen and project only one run per workspace: terminal history
	 * is unbounded, while `/api/state` is polled every few seconds.
	 */
	listLatestWorkflowProjectionsForWorkspaces(workspaceIds: readonly string[]): WorkflowRunProjection[] {
		const ids = [...new Set(workspaceIds.filter(Boolean))]
		if (!ids.length) return []
		const placeholders = ids.map(() => '?').join(', ')
		const newest = this.db
			.prepare(
				`SELECT id FROM (
					SELECT id, created_at, updated_at,
						ROW_NUMBER() OVER (
							PARTITION BY workspace_id
							ORDER BY created_at DESC, updated_at DESC, id DESC
						) AS ordinal
					FROM workflow_runs
					WHERE workspace_id IN (${placeholders})
				) WHERE ordinal = 1
				ORDER BY created_at DESC, updated_at DESC, id DESC`
			)
			.all(...ids) as unknown as Array<{ id: string }>
		if (!newest.length) return []
		const rows = this.orm
			.select()
			.from(workflowRuns)
			.where(
				inArray(
					workflowRuns.id,
					newest.map(row => row.id)
				)
			)
			.all()
		const byId = new Map(rows.map(row => [row.id, row]))
		return newest.flatMap(({ id }) => {
			const row = byId.get(id)
			return row ? [this.projectRun(this.decodeRun(row))] : []
		})
	}

	/**
	 * Active runs always need driving. A cancelled run remains wakeable only while
	 * it has durable evidence that can still settle: an external effect whose
	 * outcome is unknown, an accepted outbox receipt awaiting promotion, or a
	 * delivered child turn whose final outcome has not appeared yet.
	 */
	listWorkflowRunIdsNeedingWake(): string[] {
		return (
			this.db
				.prepare(
					`SELECT r.id FROM workflow_runs r
					 WHERE r.phase NOT IN ('completed', 'cancelled')
						OR (
							r.phase = 'cancelled' AND (
								EXISTS (
									SELECT 1 FROM workflow_effects e
									WHERE e.run_id = r.id AND (
										e.state IN ('dispatched', 'ambiguous') OR
										(e.state = 'committed' AND json_extract(e.receipt_json, '$.kind') = 'outbox')
									)
								) OR EXISTS (
									SELECT 1 FROM workflow_jobs j
									WHERE j.run_id = r.id AND j.state = 'cancelled'
										AND j.child_session_id IS NOT NULL AND j.outcome_json IS NULL
										AND (
											json_extract(j.task_receipt_json, '$.kind') = 'message' OR EXISTS (
												SELECT 1 FROM workflow_effects task
												WHERE task.job_id = j.id AND task.kind = 'send_task'
													AND task.state = 'committed'
													AND json_extract(task.receipt_json, '$.kind') = 'message'
											)
										)
								)
							)
						)
					 ORDER BY r.updated_at DESC, r.id`
				)
				.all() as unknown as Array<{ id: string }>
		).map(row => row.id)
	}

	private projectRun(run: WorkflowRunRecord): WorkflowRunProjection {
		const jobs = this.listWorkflowJobs(run.id)
		const summary = (role: WorkflowJobRole) => {
			const selected = jobs.filter(job => job.role === role && job.state !== 'cancelled')
			return {
				requested: selected.length,
				running: selected.filter(job => !isTerminalWorkflowJobState(job.state) && job.state !== 'dormant').length,
				returned: selected.filter(job => job.state === 'returned').length,
				failed: selected.filter(job => job.state === 'failed').length
			}
		}
		const publicRole = (role: FrozenWorkflowRole): WorkflowRunWire['roles'][WorkflowRoleName] => ({
			agentType: role.agentType,
			model: role.model,
			...(role.effort === undefined ? {} : { effort: role.effort }),
			...(role.fast === undefined ? {} : { fast: role.fast })
		})
		const blocked = run.blocked
		const candidates = (blocked?.candidates ?? []).slice(0, 20).map(candidate => ({
			id: candidate.id,
			title: this.scrubPublicText(candidate.title).slice(0, 200),
			repo: this.scrubPublicText(candidate.repo).slice(0, 200),
			createdAt: candidate.createdAt
		}))
		const blockedEffect = blocked ? this.getWorkflowEffect(run.id, blocked.actionId) : undefined
		const adoptionKind =
			blocked?.candidates?.[0]?.kind ?? (blockedEffect?.kind === 'create_workspace' ? 'workspace' : 'session')
		// Risky replay still needs the stable action id when reconciliation found no
		// candidate. The fixed wire deliberately has no second public effect-id field,
		// so retain the recovery envelope with an empty candidates array.
		const exposeRecoveryAction =
			!!blocked &&
			(candidates.length > 0 || blocked.retryClass === 'ambiguous') &&
			(adoptionKind === 'workspace' || adoptionKind === 'session')
		const outstanding = jobs.some(job => !isTerminalWorkflowJobState(job.state))
		const implementationReturned = jobs.some(job => job.role === 'implementation' && job.state === 'returned')
		return {
			id: run.id,
			...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
			...(run.rootSessionId ? { rootSessionId: run.rootSessionId } : {}),
			phase: run.phase,
			objectiveExcerpt: this.scrubPublicText(run.objective).slice(0, 240),
			roles: {
				planning: publicRole(run.roles.planning),
				exploration: publicRole(run.roles.exploration),
				implementation: publicRole(run.roles.implementation)
			},
			jobs: { exploration: summary('exploration'), implementation: summary('implementation') },
			...(blocked
				? {
						error: {
							code: blocked.errorCode,
							message: this.scrubPublicText(blocked.message).slice(0, 500),
							retryable: blocked.retryClass === 'deterministic'
						}
					}
				: {}),
			...(exposeRecoveryAction ? { adoption: { actionId: blocked.actionId, kind: adoptionKind, candidates } } : {}),
			actions: {
				canRetry: run.phase === 'blocked' && run.blocked?.retryClass === 'deterministic',
				canAdopt: run.phase === 'blocked' && candidates.length > 0,
				canReplayAmbiguous: run.phase === 'blocked' && run.blocked?.retryClass === 'ambiguous',
				canCancel: !isTerminalWorkflowPhase(run.phase),
				canComplete: run.phase === 'reviewing' && implementationReturned && !outstanding
			},
			createdAt: run.createdAt,
			updatedAt: run.updatedAt
		}
	}

	compactTerminalRuns(options: { olderThan: number; limit?: number }): number {
		return this.immediate(() => {
			const rows = this.db
				.prepare(
					`SELECT id FROM workflow_runs
					 WHERE phase IN ('completed', 'cancelled') AND terminal_at IS NOT NULL AND terminal_at < ?
						AND NOT EXISTS (
							SELECT 1 FROM workflow_events e
							WHERE e.run_id = workflow_runs.id AND e.type = 'terminal_compacted'
						)
					 ORDER BY terminal_at LIMIT ?`
				)
				.all(options.olderThan, Math.max(1, Math.min(options.limit ?? 20, 100))) as Array<{ id: string }>
			for (const row of rows) {
				const jobs = this.listWorkflowJobs(row.id)
				const effects = this.db
					.prepare('SELECT state, COUNT(*) count FROM workflow_effects WHERE run_id = ? GROUP BY state')
					.all(row.id) as Array<{ state: string; count: number }>
				this.db.prepare('DELETE FROM workflow_capabilities WHERE run_id = ?').run(row.id)
				this.db.prepare('DELETE FROM workflow_jobs WHERE run_id = ?').run(row.id)
				this.db.prepare('DELETE FROM workflow_effects WHERE run_id = ?').run(row.id)
				this.db.prepare('DELETE FROM workflow_events WHERE run_id = ?').run(row.id)
				this.appendEvent(row.id, 'terminal_compacted', 'terminal_compacted', {
					jobs: Object.fromEntries(
						(['exploration', 'implementation'] as const).map(role => [
							role,
							Object.fromEntries(
								ALL_JOB_STATES.map(state => [
									state,
									jobs.filter(job => job.role === role && job.state === state).length
								])
							)
						])
					),
					effects: Object.fromEntries(effects.map(effect => [effect.state, effect.count]))
				})
			}
			return rows.length
		})
	}
}

const asObject = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const canonicalOptional = (value: unknown): string =>
	value === undefined ? '__orchestration_undefined__' : canonicalRequestJson(value)

const sameOptionalProcess = (
	left: (ProcessIdentity & { processGroup?: number }) | undefined,
	right: (ProcessIdentity & { processGroup?: number }) | undefined
): boolean =>
	left === undefined
		? right === undefined
		: right !== undefined && sameProcess(left, right) && left.processGroup === right.processGroup

const sameLeaseSnapshot = (left: UiLeaseOwner, right: UiLeaseOwner): boolean =>
	sameOwner(left, right) &&
	left.nonce === right.nonce &&
	left.actionId === right.actionId &&
	left.effectId === right.effectId &&
	left.mayExecute === right.mayExecute &&
	left.deadlineAt === right.deadlineAt &&
	sameOptionalProcess(left.externalProcess, right.externalProcess)
