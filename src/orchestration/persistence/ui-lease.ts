import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { PersistenceConnection } from './connection.ts'
import { OrchestrationError, UiLeaseUnavailableError } from './errors.ts'
import { activateUiQuarantine, getUiQuarantine } from './quarantine.ts'
import { assertRelayRegistered } from './relays.ts'
import { uiMutex, uiMutexSelectSchema } from './schema.ts'
import type {
	AcquireUiLeaseResult,
	OrchestrationSharedUiLeaseProvider,
	ProcessIdentity,
	ProcessProbe,
	RelayIdentity,
	UiLease,
	UiLeaseOwner
} from './types.ts'
import {
	externalFromColumns,
	nonEmpty,
	ownerFromColumns,
	probeAlive,
	sameLeaseSnapshot,
	validateProcessIdentity,
	validateRelayIdentity
} from './values.ts'

export function acquireUiLease(
	context: PersistenceConnection,
	input: {
		owner: RelayIdentity
		actionId: string
		effectId?: string
		deadlineAt: number
		priority: 'interactive' | 'background'
		nonce?: string
		processProbe?: ProcessProbe
	}
): AcquireUiLeaseResult {
	validateRelayIdentity(input.owner)
	const probe = input.processProbe ?? context.processProbe
	const observed = readUiLeaseOwner(context)
	const ownerAlive = observed ? probeAlive(observed, probe) : false
	const externalAlive = observed?.externalProcess ? probeAlive(observed.externalProcess, probe) : false
	return context.immediate(() => {
		assertRelayRegistered(context, input.owner)
		const quarantine = getUiQuarantine(context)
		if (quarantine.active && input.priority === 'background') return { status: 'quarantined', quarantine }

		const current = readUiLeaseOwner(context)
		if (observed && (!current || !sameLeaseSnapshot(observed, current))) {
			return current ? { status: 'busy', owner: current, reason: 'changed' } : assignUiLease(context, input)
		}
		if (!observed && current) return { status: 'busy', owner: current, reason: 'changed' }
		if (current) {
			if (ownerAlive) return { status: 'busy', owner: current, reason: 'owner_alive' }
			if (current.externalProcess && externalAlive) {
				return { status: 'busy', owner: current, reason: 'external_process_alive' }
			}
			if (current.mayExecute) {
				clearUiMutex(context, current)
				const hold = activateUiQuarantine(context, {
					actionId: current.actionId,
					effectId: current.effectId,
					reason: 'a dead UI lease owner may have emitted an external action',
					owner: current,
					externalProcess: current.externalProcess
				})
				if (input.priority === 'background') return { status: 'quarantined', quarantine: hold }
				return assignUiLease(context, input, current)
			}
			clearUiMutex(context, current)
			return assignUiLease(context, input, current)
		}
		return assignUiLease(context, input)
	})
}

export function assignUiLease(
	context: PersistenceConnection,
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
	const at = context.now()
	const result = context.db
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
		const owner = readUiLeaseOwner(context)
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

export function markUiLeaseMayExecute(
	context: PersistenceConnection,
	lease: UiLease,
	externalProcess?: ProcessIdentity & { processGroup?: number },
	deadlineAt?: number
): boolean {
	if (externalProcess) validateProcessIdentity(externalProcess, 'external UI process')
	return context.immediate(() => {
		const result = context.db
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
				context.now(),
				lease.instanceId,
				lease.pid,
				lease.processStartedAt,
				lease.nonce,
				lease.actionId
			)
		return Number(result.changes) === 1
	})
}

export function renewUiLease(context: PersistenceConnection, lease: UiLease, deadlineAt: number): boolean {
	return context.immediate(() => {
		const result = context.db
			.prepare(
				`UPDATE ui_mutex SET deadline_at = ?, updated_at = ?
				 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ?
					AND nonce = ? AND action_id = ?`
			)
			.run(deadlineAt, context.now(), lease.instanceId, lease.pid, lease.processStartedAt, lease.nonce, lease.actionId)
		return Number(result.changes) === 1
	})
}

export function releaseUiLease(context: PersistenceConnection, lease: UiLease): boolean {
	const observed = readUiLeaseOwner(context)
	if (
		observed &&
		observed.instanceId === lease.instanceId &&
		observed.pid === lease.pid &&
		observed.processStartedAt === lease.processStartedAt &&
		observed.nonce === lease.nonce &&
		observed.actionId === lease.actionId &&
		observed.externalProcess &&
		probeAlive(observed.externalProcess, context.processProbe)
	) {
		// A returned/failed caller is not proof that a detached helper (or one of
		// its process-group children) is gone. Retain the durable owner so the
		// watchdog can terminate and prove the exact group dead before reclaim.
		return false
	}
	return context.immediate(() => {
		const result = context.db
			.prepare(
				`UPDATE ui_mutex SET owner_instance_id = NULL, owner_pid = NULL, owner_process_started_at = NULL,
					owner_protocol_version = NULL, nonce = NULL, action_id = NULL, effect_id = NULL,
					external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
					may_execute = 0, deadline_at = NULL, acquired_at = NULL, updated_at = ?
				 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ?
					AND nonce = ? AND action_id = ?`
			)
			.run(context.now(), lease.instanceId, lease.pid, lease.processStartedAt, lease.nonce, lease.actionId)
		return Number(result.changes) === 1
	})
}

export function getUiLeaseOwner(context: PersistenceConnection): UiLeaseOwner | undefined {
	return readUiLeaseOwner(context)
}

/** Adapter installed with `configureSharedUiLeaseProvider` in `src/writes/ui-lock.ts`. */
export function createSharedUiLeaseProvider(
	context: PersistenceConnection,
	owner: RelayIdentity,
	options: { leaseMs?: number } = {}
): OrchestrationSharedUiLeaseProvider {
	const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000)
	return {
		acquire: async request => {
			const result = acquireUiLease(context, {
				owner,
				actionId: request.actionId ?? `ui:${owner.instanceId}:${randomUUID()}`,
				deadlineAt: context.now() + leaseMs,
				priority: request.priority
			})
			if (result.status !== 'acquired') throw new UiLeaseUnavailableError(result)
			return {
				markMayExecute: externalProcess => {
					if (!markUiLeaseMayExecute(context, result.lease, externalProcess)) {
						throw new OrchestrationError('lost the shared UI lease before dispatch')
					}
				},
				release: () => {
					if (!releaseUiLease(context, result.lease)) {
						throw new OrchestrationError(
							'shared UI lease release did not match its durable owner or its external process is still live'
						)
					}
				}
			}
		}
	}
}

export function readUiLeaseOwner(context: PersistenceConnection): UiLeaseOwner | undefined {
	const candidate = context.orm.select().from(uiMutex).where(eq(uiMutex.id, 1)).get()
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

export function clearUiMutex(context: PersistenceConnection, expected: UiLeaseOwner): void {
	context.db
		.prepare(
			`UPDATE ui_mutex SET owner_instance_id = NULL, owner_pid = NULL, owner_process_started_at = NULL,
				owner_protocol_version = NULL, nonce = NULL, action_id = NULL, effect_id = NULL,
				external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
				may_execute = 0, deadline_at = NULL, acquired_at = NULL, updated_at = ?
			 WHERE id = 1 AND owner_instance_id = ? AND owner_pid = ? AND owner_process_started_at = ? AND nonce = ?`
		)
		.run(context.now(), expected.instanceId, expected.pid, expected.processStartedAt, expected.nonce)
}
