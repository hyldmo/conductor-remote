import { createHash } from 'node:crypto'
import { scrubWorkflowSecrets, withoutWindowEvidence } from '../../shared.ts'
import type { WorkflowPhase } from '../../wire.ts'
import { OrchestrationError } from './errors.ts'
import type { StoredJson, WorkflowEffectState, WorkflowJobState } from './schema.ts'
import type { ProcessIdentity, ProcessProbe, RelayIdentity, UiLeaseOwner } from './types.ts'

export const ACTIVE_PHASES: WorkflowPhase[] = [
	'creating_workspace',
	'binding_root',
	'pending_root',
	'exploring',
	'planning',
	'implementing',
	'reviewing',
	'blocked'
]

export const RUNNABLE_PHASES: WorkflowPhase[] = ACTIVE_PHASES.filter(phase => phase !== 'blocked')

export const ALL_JOB_STATES: WorkflowJobState[] = [
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

export const TERMINAL_EFFECT_STATES: WorkflowEffectState[] = ['committed', 'failed', 'ambiguous', 'cancelled']

export const nonEmpty = (value: string, name: string): string => {
	if (!value.trim()) throw new OrchestrationError(`${name} must not be empty`)
	return value
}

export const validateProcessIdentity = (identity: ProcessIdentity, name: string): void => {
	if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new OrchestrationError(`${name} PID is invalid`)
	nonEmpty(identity.processStartedAt, `${name} process-start identity`)
}

export const validateRelayIdentity = (identity: RelayIdentity): void => {
	nonEmpty(identity.instanceId, 'relay instance ID')
	validateProcessIdentity(identity, 'relay')
	if (!Number.isSafeInteger(identity.protocolVersion) || identity.protocolVersion < 0) {
		throw new OrchestrationError('relay orchestration protocol is invalid')
	}
}

export const json = (value: unknown): string => {
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new OrchestrationError('value is not JSON serializable')
	return encoded
}

export const optionalJson = (value: unknown): string | null => (value === undefined ? null : json(value))

export const jsonProperty = <TKey extends string, TValue>(key: TKey, stored: StoredJson<TValue> | null) =>
	stored === null ? {} : ({ [key]: stored.value } as Record<TKey, TValue>)

export const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
	value !== null &&
	(typeof value === 'object' || typeof value === 'function') &&
	typeof (value as { then?: unknown }).then === 'function'

export const isConstraintError = (error: unknown): boolean =>
	error instanceof Error && /constraint failed|unique constraint/i.test(error.message)

export const ownerFromColumns = (row: {
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

export const externalFromColumns = (row: {
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

export const sameOwner = (left: RelayIdentity, right: RelayIdentity): boolean =>
	left.instanceId === right.instanceId && left.protocolVersion === right.protocolVersion && sameProcess(left, right)

export const processAuditKey = (identity: ProcessIdentity & { processGroup?: number }): string =>
	`${identity.pid}:${createHash('sha256')
		.update(`${identity.processStartedAt}\0${identity.processGroup ?? ''}`)
		.digest('hex')
		.slice(0, 16)}`

export const ownerAuditKey = (owner: RelayIdentity): string =>
	createHash('sha256')
		.update(`${owner.instanceId}\0${owner.pid}\0${owner.processStartedAt}\0${owner.protocolVersion}`)
		.digest('hex')
		.slice(0, 16)

export const defaultScrub = (text: string): string =>
	withoutWindowEvidence(scrubWorkflowSecrets(text))
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim()

export function probeAlive(identity: ProcessIdentity, probe: ProcessProbe): boolean {
	try {
		return probe(identity)
	} catch {
		// Failure to prove death must never authorize overlap.
		return true
	}
}

export const asObject = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const sameOptionalProcess = (
	left: (ProcessIdentity & { processGroup?: number }) | undefined,
	right: (ProcessIdentity & { processGroup?: number }) | undefined
): boolean =>
	left === undefined
		? right === undefined
		: right !== undefined && sameProcess(left, right) && left.processGroup === right.processGroup

export const sameLeaseSnapshot = (left: UiLeaseOwner, right: UiLeaseOwner): boolean =>
	sameOwner(left, right) &&
	left.nonce === right.nonce &&
	left.actionId === right.actionId &&
	left.effectId === right.effectId &&
	left.mayExecute === right.mayExecute &&
	left.deadlineAt === right.deadlineAt &&
	sameOptionalProcess(left.externalProcess, right.externalProcess)
