/**
 * Validate the exact persisted delegation envelope and stage-specific evidence.
 * Decoder failures remain public warnings; callers keep the original bytes intact.
 */

import { decodeRoles } from '../../agents/roles.ts'
import type {
	Attachment,
	DelegationError,
	DelegationOutcome,
	DelegationStatus,
	ResolvedDelegatedRole,
	SessionRoleAssignment
} from '../../wire.ts'
import type { DelegationDelivery, PersistedDelegation } from './types.ts'

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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
	'delivery_altered',
	'completion_failed',
	'return_failed'
])

function object(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

export function text(value: unknown, field: string, maximum = 256): string {
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

function decodeDelivery(raw: unknown, field: string): DelegationDelivery {
	const value = object(raw)
	if (!value || !Array.isArray(value.outboxIds)) throw new Error(`${field} is invalid`)
	if (value.accepted !== undefined && value.accepted !== true) throw new Error(`${field}.accepted is invalid`)
	return {
		rowid: integer(value.rowid, `${field}.rowid`),
		outboxIds: value.outboxIds.map(id => text(id, `${field}.outboxIds`)),
		...(value.messageId === undefined ? {} : { messageId: text(value.messageId, `${field}.messageId`) }),
		...(value.accepted === true ? { accepted: true } : {})
	}
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
	if (job.returnDelivery && job.returnCursor !== job.returnDelivery.rowid) {
		throw new Error('returnDelivery requires its original returnCursor')
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
		...(value.sendDelivery === undefined ? {} : { sendDelivery: decodeDelivery(value.sendDelivery, 'sendDelivery') }),
		...(value.sentRowid === undefined ? {} : { sentRowid: integer(value.sentRowid, 'sentRowid', 1) }),
		...(value.completionRowid === undefined
			? {}
			: { completionRowid: integer(value.completionRowid, 'completionRowid', 1) }),
		...(value.returnCursor === undefined ? {} : { returnCursor: integer(value.returnCursor, 'returnCursor') }),
		...(value.returnAttachment === undefined ? {} : { returnAttachment: decodeAttachment(value.returnAttachment) }),
		...(value.returnText === undefined ? {} : { returnText: text(value.returnText, 'returnText', MAX_TEXT) }),
		...(value.returnDelivery === undefined
			? {}
			: { returnDelivery: decodeDelivery(value.returnDelivery, 'returnDelivery') }),
		...(value.returnRowid === undefined ? {} : { returnRowid: integer(value.returnRowid, 'returnRowid', 1) }),
		...(value.outcome === undefined ? {} : { outcome: decodeOutcome(value.outcome) }),
		...(value.failure === undefined ? {} : { failure: decodeError(value.failure, 'failure') }),
		...(value.lastAttemptAt === undefined ? {} : { lastAttemptAt: integer(value.lastAttemptAt, 'lastAttemptAt') })
	}
	requireStageFields(job)
	return job
}

export function decodeSessionRoles(raw: unknown): Record<string, SessionRoleAssignment> {
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
