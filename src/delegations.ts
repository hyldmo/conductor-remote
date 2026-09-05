/**
 * Worktree-scoped delegated-job and session-role persistence.
 *
 * Conductor owns the chat history; these small files hold only active/failed work
 * plus durable role identity. A decoder failure is public state, not permission to
 * delete a file: callers receive warnings and the bytes remain for repair/dismissal.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodeRoles } from './roles.ts'
import type {
	Attachment,
	DelegationError,
	DelegationOutcome,
	DelegationReturnMode,
	DelegationStatus,
	ResolvedDelegatedRole,
	SessionRoleAssignment
} from './wire.ts'

const DIRECTORY = path.join('.context', 'delegations')
const SESSIONS_FILE = 'sessions.json'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_TEXT = 1_000_000
const STATUSES = new Set<DelegationStatus>([
	'queued',
	'opening',
	'configuring',
	'sending',
	'running',
	'returning',
	'returned',
	'failed'
])
const ERROR_CODES = new Set<DelegationError['code']>([
	'invalid_request',
	'role_not_found',
	'model_missing',
	'provider_unknown',
	'same_provider',
	'workspace_not_found',
	'session_not_found',
	'delegation_not_found',
	'worktree_unavailable',
	'state_invalid',
	'opening_failed',
	'configuration_failed',
	'send_failed',
	'completion_failed',
	'return_failed'
])

export interface PersistedDelegation {
	version: 1
	id: string
	workspaceId: string
	parentSessionId: string
	childSessionId?: string
	role: string
	resolvedRole: ResolvedDelegatedRole
	prompt: string
	returnMode: DelegationReturnMode
	includeThinking: boolean
	throughRowid?: number
	status: DelegationStatus
	attempts: number
	createdAt: number
	updatedAt: number
	handoff?: Attachment
	sentRowid?: number
	completionRowid?: number
	/** Parent transcript cursor captured before a queued Baton was accepted. */
	returnCursor?: number
	returnAttachment?: Attachment
	returnText?: string
	returnRowid?: number
	outcome?: DelegationOutcome
	failure?: DelegationError
	lastAttemptAt?: number
}

export interface StateWarning {
	file: string
	message: string
}

export interface DelegationList {
	jobs: PersistedDelegation[]
	warnings: StateWarning[]
}

export interface SessionRolesRead {
	sessions: Record<string, SessionRoleAssignment>
	warning?: string
}

function object(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function text(value: unknown, field: string, maximum = 256): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${field} is invalid`)
	return value
}

function integer(value: unknown, field: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${field} is invalid`)
	return value as number
}

function decodeError(raw: unknown, field: string): DelegationError {
	const value = object(raw)
	if (!value || !ERROR_CODES.has(value.code as DelegationError['code'])) throw new Error(`${field}.code is invalid`)
	return {
		code: value.code as DelegationError['code'],
		message: text(value.message, `${field}.message`, 10_000),
		retryable: value.retryable === true
	}
}

function decodeOutcome(raw: unknown): DelegationOutcome {
	const value = object(raw)
	if (!value) throw new Error('outcome is invalid')
	if (value.kind === 'success') {
		return {
			kind: 'success',
			assistantRowid: integer(value.assistantRowid, 'outcome.assistantRowid', 1),
			text: text(value.text, 'outcome.text', MAX_TEXT)
		}
	}
	if (value.kind === 'error') {
		return {
			kind: 'error',
			...(value.assistantRowid === undefined
				? {}
				: { assistantRowid: integer(value.assistantRowid, 'outcome.assistantRowid', 1) }),
			...(value.text === undefined ? {} : { text: text(value.text, 'outcome.text', MAX_TEXT) }),
			error: text(value.error, 'outcome.error', 10_000)
		}
	}
	throw new Error('outcome.kind is invalid')
}

function decodeAttachment(raw: unknown): Attachment {
	const value = object(raw)
	if (!value) throw new Error('handoff is invalid')
	return {
		name: text(value.name, 'handoff.name', 256),
		path: text(value.path, 'handoff.path', 1_024),
		bytes: integer(value.bytes, 'handoff.bytes'),
		token: text(value.token, 'handoff.token', 2_048)
	}
}

function decodeResolvedRole(raw: unknown): ResolvedDelegatedRole {
	const value = object(raw)
	if (!value) throw new Error('resolvedRole is invalid')
	const agentType = text(value.agentType, 'resolvedRole.agentType', 64)
	const role = decodeRoles({
		version: 1,
		roles: { resolved: Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'agentType')) }
	}).roles.resolved
	return { ...role, agentType }
}

function requireStageFields(job: PersistedDelegation): void {
	if (['configuring', 'sending', 'running', 'returning', 'returned'].includes(job.status) && !job.childSessionId) {
		throw new Error(`${job.status} requires childSessionId`)
	}
	if (job.status === 'sending' && !job.handoff) throw new Error('sending requires handoff')
	if (['running', 'returning', 'returned'].includes(job.status) && job.sentRowid === undefined) {
		throw new Error(`${job.status} requires sentRowid`)
	}
	if (['returning', 'returned'].includes(job.status) && !job.outcome) {
		throw new Error(`${job.status} requires outcome`)
	}
	if (job.returnCursor !== undefined && (!job.returnAttachment || !job.returnText)) {
		throw new Error('a dispatched return requires returnAttachment and returnText')
	}
	if (job.status === 'returned' && job.returnRowid === undefined) throw new Error('returned requires returnRowid')
	if (job.status === 'failed' && !job.failure) throw new Error('failed requires failure')
}

export function decodeDelegation(raw: unknown): PersistedDelegation {
	const value = object(raw)
	if (!value) throw new Error('delegation must be an object')
	if (value.version !== 1) throw new Error(`unsupported delegation version ${String(value.version)}`)
	const id = text(value.id, 'id', 128)
	if (!SAFE_ID.test(id)) throw new Error('id is invalid')
	const status = value.status as DelegationStatus
	if (!STATUSES.has(status)) throw new Error('status is invalid')
	const returnMode = value.returnMode
	if (returnMode !== 'queue' && returnMode !== 'steer') throw new Error('returnMode is invalid')
	if (typeof value.includeThinking !== 'boolean') throw new Error('includeThinking is invalid')

	const job: PersistedDelegation = {
		version: 1,
		id,
		workspaceId: text(value.workspaceId, 'workspaceId'),
		parentSessionId: text(value.parentSessionId, 'parentSessionId'),
		...(value.childSessionId === undefined ? {} : { childSessionId: text(value.childSessionId, 'childSessionId') }),
		role: text(value.role, 'role', 64),
		resolvedRole: decodeResolvedRole(value.resolvedRole),
		prompt: text(value.prompt, 'prompt', MAX_TEXT),
		returnMode,
		includeThinking: value.includeThinking,
		...(value.throughRowid === undefined ? {} : { throughRowid: integer(value.throughRowid, 'throughRowid', 1) }),
		status,
		attempts: integer(value.attempts, 'attempts'),
		createdAt: integer(value.createdAt, 'createdAt'),
		updatedAt: integer(value.updatedAt, 'updatedAt'),
		...(value.handoff === undefined ? {} : { handoff: decodeAttachment(value.handoff) }),
		...(value.sentRowid === undefined ? {} : { sentRowid: integer(value.sentRowid, 'sentRowid', 1) }),
		...(value.completionRowid === undefined
			? {}
			: { completionRowid: integer(value.completionRowid, 'completionRowid', 1) }),
		...(value.returnCursor === undefined ? {} : { returnCursor: integer(value.returnCursor, 'returnCursor') }),
		...(value.returnAttachment === undefined ? {} : { returnAttachment: decodeAttachment(value.returnAttachment) }),
		...(value.returnText === undefined ? {} : { returnText: text(value.returnText, 'returnText', MAX_TEXT) }),
		...(value.returnRowid === undefined ? {} : { returnRowid: integer(value.returnRowid, 'returnRowid', 1) }),
		...(value.outcome === undefined ? {} : { outcome: decodeOutcome(value.outcome) }),
		...(value.failure === undefined ? {} : { failure: decodeError(value.failure, 'failure') }),
		...(value.lastAttemptAt === undefined ? {} : { lastAttemptAt: integer(value.lastAttemptAt, 'lastAttemptAt') })
	}
	requireStageFields(job)
	return job
}

function decodeSessionRoles(raw: unknown): Record<string, SessionRoleAssignment> {
	const value = object(raw)
	if (!value) throw new Error('session roles must be an object')
	if (value.version !== 1) throw new Error(`unsupported session roles version ${String(value.version)}`)
	const sessions = object(value.sessions)
	if (!sessions) throw new Error('sessions must be an object')
	const decoded: Record<string, SessionRoleAssignment> = {}
	for (const [sessionId, rawAssignment] of Object.entries(sessions)) {
		text(sessionId, 'session id')
		const assignment = object(rawAssignment)
		if (!assignment) throw new Error(`session ${sessionId} role is invalid`)
		const delegationId = assignment.delegationId
		if (delegationId !== undefined && (typeof delegationId !== 'string' || !SAFE_ID.test(delegationId))) {
			throw new Error(`session ${sessionId} delegationId is invalid`)
		}
		decoded[sessionId] = {
			role: text(assignment.role, `session ${sessionId} role`, 64),
			...(delegationId === undefined ? {} : { delegationId }),
			...(assignment.parentSessionId === undefined
				? {}
				: { parentSessionId: text(assignment.parentSessionId, `session ${sessionId} parentSessionId`) }),
			assignedAt: integer(assignment.assignedAt, `session ${sessionId} assignedAt`)
		}
	}
	return decoded
}

function atomicWrite(file: string, value: unknown): void {
	const temporary = `${file}.${process.pid}.tmp`
	fs.mkdirSync(path.dirname(file), { recursive: true })
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`, { mode: 0o600 })
		fs.chmodSync(temporary, 0o600)
		fs.renameSync(temporary, file)
	} catch (err) {
		try {
			fs.unlinkSync(temporary)
		} catch {}
		throw err
	}
}

export class DelegationStore {
	private readonly directory: string

	constructor(worktree: string) {
		this.directory = path.join(worktree, DIRECTORY)
	}

	list(): DelegationList {
		let files: string[]
		try {
			files = fs
				.readdirSync(this.directory)
				.filter(file => file.endsWith('.json') && file !== SESSIONS_FILE)
				.sort()
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], warnings: [] }
			return { jobs: [], warnings: [{ file: this.directory, message: String(err) }] }
		}
		const jobs: PersistedDelegation[] = []
		const warnings: StateWarning[] = []
		for (const file of files) {
			try {
				jobs.push(decodeDelegation(JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'))))
			} catch (err) {
				warnings.push({ file, message: err instanceof Error ? err.message : String(err) })
			}
		}
		return { jobs, warnings }
	}

	get(id: string): PersistedDelegation | null {
		if (!SAFE_ID.test(id)) return null
		try {
			return decodeDelegation(JSON.parse(fs.readFileSync(path.join(this.directory, `${id}.json`), 'utf8')))
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
	}

	put(raw: PersistedDelegation): PersistedDelegation {
		const job = decodeDelegation(raw)
		atomicWrite(path.join(this.directory, `${job.id}.json`), job)
		return job
	}

	remove(id: string): boolean {
		if (!SAFE_ID.test(id)) return false
		try {
			fs.unlinkSync(path.join(this.directory, `${id}.json`))
			return true
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
			throw err
		}
	}

	sessionRoles(): SessionRolesRead {
		const file = path.join(this.directory, SESSIONS_FILE)
		try {
			return { sessions: decodeSessionRoles(JSON.parse(fs.readFileSync(file, 'utf8'))) }
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} }
			return { sessions: {}, warning: err instanceof Error ? err.message : String(err) }
		}
	}

	assign(sessionId: string, assignment: SessionRoleAssignment): void {
		text(sessionId, 'session id')
		const current = this.sessionRoles()
		if (current.warning) throw new Error(`cannot update malformed sessions.json: ${current.warning}`)
		const sessions = decodeSessionRoles({
			version: 1,
			sessions: { ...current.sessions, [sessionId]: assignment }
		})
		atomicWrite(path.join(this.directory, SESSIONS_FILE), { version: 1, sessions })
	}
}

// ── guarded transitions and the single queue producer ──────────────────────────

const NEXT: Record<DelegationStatus, DelegationStatus[]> = {
	queued: ['opening', 'failed'],
	opening: ['configuring', 'failed'],
	configuring: ['sending', 'failed'],
	sending: ['running', 'failed'],
	running: ['returning', 'failed'],
	returning: ['returned', 'failed'],
	returned: [],
	failed: []
}

export interface DelegationTransitionPatch {
	childSessionId?: string
	handoff?: Attachment
	sentRowid?: number
	completionRowid?: number
	returnCursor?: number
	returnAttachment?: Attachment
	returnText?: string
	returnRowid?: number
	outcome?: DelegationOutcome
	failure?: DelegationError
	attempts?: number
	lastAttemptAt?: number
}

/** Pure state edge: only stage data may change; the accepted envelope stays frozen. */
export function transitionDelegation(
	job: PersistedDelegation,
	status: DelegationStatus,
	patch: DelegationTransitionPatch,
	updatedAt = Date.now()
): PersistedDelegation {
	if (!NEXT[job.status].includes(status)) throw new Error(`illegal delegation transition ${job.status} → ${status}`)
	if (status === 'failed' && !patch.failure) throw new Error('failed requires failure')
	return decodeDelegation({
		...job,
		status,
		updatedAt,
		...(patch.childSessionId === undefined ? {} : { childSessionId: patch.childSessionId }),
		...(patch.handoff === undefined ? {} : { handoff: patch.handoff }),
		...(patch.sentRowid === undefined ? {} : { sentRowid: patch.sentRowid }),
		...(patch.completionRowid === undefined ? {} : { completionRowid: patch.completionRowid }),
		...(patch.returnCursor === undefined ? {} : { returnCursor: patch.returnCursor }),
		...(patch.returnAttachment === undefined ? {} : { returnAttachment: patch.returnAttachment }),
		...(patch.returnText === undefined ? {} : { returnText: patch.returnText }),
		...(patch.returnRowid === undefined ? {} : { returnRowid: patch.returnRowid }),
		...(patch.outcome === undefined ? {} : { outcome: patch.outcome }),
		...(patch.failure === undefined ? {} : { failure: patch.failure }),
		...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
		...(patch.lastAttemptAt === undefined ? {} : { lastAttemptAt: patch.lastAttemptAt })
	})
}

export interface DelegationActionError {
	ok: false
	code: DelegationError['code']
	error: string
	blocked?: boolean
	/** False means another identical attempt cannot help; fail immediately. */
	retryable?: boolean
}

export type OpenDelegationResult = { ok: true; childSessionId: string; handoff: Attachment } | DelegationActionError
export type ConfigureDelegationResult = { ok: true } | DelegationActionError
export type SendDelegationResult = { ok: true; sentRowid: number } | DelegationActionError
export type ReturnDelegationResult =
	| { ok: true; returnRowid: number }
	| { ok: true; pending: true; returnCursor: number; returnAttachment: Attachment; returnText: string }
	| DelegationActionError
export interface DelegationCompletion {
	outcome: DelegationOutcome
	completionRowid?: number
}

export interface DelegationQueueDeps {
	open: (job: PersistedDelegation) => Promise<OpenDelegationResult>
	configure: (job: PersistedDelegation) => Promise<ConfigureDelegationResult>
	send: (job: PersistedDelegation) => Promise<SendDelegationResult>
	/** Null means the child has not reached a terminal observation on this poll. */
	completion: (job: PersistedDelegation) => DelegationCompletion | null | Promise<DelegationCompletion | null>
	returnResult: (job: PersistedDelegation) => Promise<ReturnDelegationResult>
}

interface DelegationQueueOptions {
	now?: () => number
	retryDelayMs?: number
	maxAttempts?: number
	/** Lock/UI saturation is temporary queue pressure, not a failed attempt. */
	blockedError?: (error: unknown) => boolean
	onError?: (message: string) => void
}

function actionCode(status: DelegationStatus): DelegationError['code'] {
	if (status === 'opening') return 'opening_failed'
	if (status === 'configuring') return 'configuration_failed'
	if (status === 'sending') return 'send_failed'
	if (status === 'returning') return 'return_failed'
	return 'state_invalid'
}

/**
 * One producer for every worktree registered with this process. It performs at
 * most one side effect at a time and stops at `running`; the shared session poller
 * calls `wake()` on later ticks. That keeps waiting jobs out of the UI lock.
 */
export class DelegationQueue {
	private readonly deps: DelegationQueueDeps
	private readonly now: () => number
	private readonly retryDelayMs: number
	private readonly maxAttempts: number
	private readonly blockedError: (error: unknown) => boolean
	private readonly onError: (message: string) => void
	private readonly stores = new Set<DelegationStore>()
	private readonly completionCandidates = new Map<string, string>()
	private pumping: Promise<void> | null = null
	private rerun = false

	constructor(deps: DelegationQueueDeps, options: DelegationQueueOptions = {}) {
		this.deps = deps
		this.now = options.now ?? Date.now
		this.retryDelayMs = options.retryDelayMs ?? 5_000
		this.maxAttempts = options.maxAttempts ?? 3
		this.blockedError = options.blockedError ?? (() => false)
		this.onError = options.onError ?? (message => console.warn(`[relay] ${message}`))
	}

	/** Persist intake before returning, then let the queue finish independently. */
	enqueue(store: DelegationStore, raw: PersistedDelegation): PersistedDelegation {
		const roles = store.sessionRoles()
		if (roles.warning) throw new Error(`cannot enqueue beside malformed sessions.json: ${roles.warning}`)
		const job = store.put(raw)
		this.stores.add(store)
		void this.wake()
		return job
	}

	/** Register persisted work from startup without rewriting it. */
	resume(stores: Iterable<DelegationStore>): void {
		for (const store of stores) this.stores.add(store)
		void this.wake()
	}

	/** One shared-poller tick (or intake); concurrent calls join the same producer. */
	wake(): Promise<void> {
		this.rerun = true
		if (!this.pumping) {
			this.pumping = this.pump()
				.catch(err => this.onError(`delegation queue failed: ${err instanceof Error ? err.message : err}`))
				.finally(() => {
					this.pumping = null
					if (this.rerun) void this.wake()
				})
		}
		return this.pumping
	}

	private async invoke<T extends { ok: true }>(
		status: DelegationStatus,
		action: () => Promise<T | DelegationActionError>
	): Promise<T | DelegationActionError> {
		try {
			return await action()
		} catch (err) {
			return {
				ok: false,
				code: actionCode(status),
				error: err instanceof Error ? err.message : String(err),
				retryable: true,
				blocked: this.blockedError(err)
			}
		}
	}

	private async pump(): Promise<void> {
		do {
			this.rerun = false
			while (await this.stepOne()) {}
		} while (this.rerun)
	}

	/** Find one job able to make progress. Waiting/blocked jobs do not hold up others. */
	private async stepOne(): Promise<boolean> {
		const entries = [...this.stores]
			.flatMap(store => store.list().jobs.map(job => ({ store, job })))
			.sort((a, b) => a.job.createdAt - b.job.createdAt || a.job.id.localeCompare(b.job.id))
		for (const { store, job } of entries) {
			if (job.status === 'failed') continue
			if (job.status === 'returned') {
				store.remove(job.id)
				return true
			}
			if (job.status === 'queued') {
				store.put(transitionDelegation(job, 'opening', {}, this.now()))
				return true
			}
			if (this.retryPending(job)) continue

			if (job.status === 'opening') {
				const result = await this.invoke('opening', () => this.deps.open(job))
				if (!result.ok) {
					if (this.recordFailure(store, job, result)) return true
					continue
				}
				store.assign(result.childSessionId, {
					role: job.role,
					delegationId: job.id,
					parentSessionId: job.parentSessionId,
					assignedAt: this.now()
				})
				store.put(
					transitionDelegation(
						job,
						'configuring',
						{ childSessionId: result.childSessionId, handoff: result.handoff },
						this.now()
					)
				)
				return true
			}

			if (job.status === 'configuring') {
				const result = await this.invoke('configuring', () => this.deps.configure(job))
				if (!result.ok) {
					if (this.recordFailure(store, job, result)) return true
					continue
				}
				store.put(transitionDelegation(job, 'sending', {}, this.now()))
				return true
			}

			if (job.status === 'sending') {
				const result = await this.invoke('sending', () => this.deps.send(job))
				if (!result.ok) {
					if (this.recordFailure(store, job, result)) return true
					continue
				}
				store.put(transitionDelegation(job, 'running', { sentRowid: result.sentRowid }, this.now()))
				return true
			}

			if (job.status === 'running') {
				let completion: DelegationCompletion | null
				try {
					completion = await this.deps.completion(job)
				} catch (err) {
					console.warn(`[relay] delegation completion read failed: ${err instanceof Error ? err.message : err}`)
					continue
				}
				const key = `${job.workspaceId}\0${job.id}`
				if (!completion) {
					this.completionCandidates.delete(key)
					continue
				}
				const signature = JSON.stringify(completion)
				if (this.completionCandidates.get(key) !== signature) {
					this.completionCandidates.set(key, signature)
					continue
				}
				this.completionCandidates.delete(key)
				store.put(
					transitionDelegation(
						job,
						'returning',
						{ outcome: completion.outcome, completionRowid: completion.completionRowid },
						this.now()
					)
				)
				return true
			}

			if (job.status === 'returning') {
				const result = await this.invoke('returning', () => this.deps.returnResult(job))
				if (!result.ok) {
					if (this.recordFailure(store, job, result)) return true
					continue
				}
				if ('pending' in result) {
					// A queued Baton clears the composer before SQLite exposes any row.
					// Persist the pre-dispatch cursor once, then only poll for the exact
					// eventual row; repeating the UI action here would enqueue a duplicate.
					if (job.returnCursor === result.returnCursor) continue
					store.put(
						decodeDelegation({
							...job,
							returnCursor: result.returnCursor,
							returnAttachment: result.returnAttachment,
							returnText: result.returnText,
							updatedAt: this.now()
						})
					)
					return true
				}
				store.put(transitionDelegation(job, 'returned', { returnRowid: result.returnRowid }, this.now()))
				return true
			}
		}
		return false
	}

	private retryPending(job: PersistedDelegation): boolean {
		return job.attempts > 0 && job.lastAttemptAt !== undefined && this.now() - job.lastAttemptAt < this.retryDelayMs
	}

	/** True when persistence changed; false for a lock-blocked/no-cost attempt. */
	private recordFailure(store: DelegationStore, job: PersistedDelegation, result: DelegationActionError): boolean {
		if (result.blocked) return false
		const attempts = job.attempts + 1
		const now = this.now()
		if (attempts >= this.maxAttempts || result.retryable === false) {
			store.put(
				transitionDelegation(
					job,
					'failed',
					{
						attempts,
						lastAttemptAt: now,
						failure: {
							code: result.code ?? actionCode(job.status),
							message: result.error,
							retryable: result.retryable !== false
						}
					},
					now
				)
			)
			return true
		}
		store.put(decodeDelegation({ ...job, attempts, lastAttemptAt: now, updatedAt: now }))
		return true
	}
}
