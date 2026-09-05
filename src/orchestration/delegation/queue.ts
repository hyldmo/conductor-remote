/**
 * Advances persisted ordinary-chat delegations through UI delivery and return.
 * One queue owns retries and the two-observation completion barrier for its stores.
 */

import type { DelegationError, DelegationStatus } from '../../wire.ts'
import { decodeDelegation } from './codec.ts'
import type { DelegationStore } from './store.ts'
import type {
	DelegationActionError,
	DelegationCompletion,
	DelegationQueueDeps,
	DelegationQueueOptions,
	DelegationTransitionPatch,
	PersistedDelegation
} from './types.ts'

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
