import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { WorkflowPhase } from '../../wire.ts'
import type { PersistenceConnection } from './connection.ts'
import { OrchestrationError, WorkflowTransitionError } from './errors.ts'
import { appendEvent } from './events.ts'
import { requireRun } from './records.ts'
import { type WorkflowJobRole, workflowCapabilities, workflowCapabilitySelectSchema } from './schema.ts'
import type { WorkflowCapabilityRecord } from './types.ts'
import { json } from './values.ts'

export function getWorkflowCapability(
	context: PersistenceConnection,
	tokenHash: string
): WorkflowCapabilityRecord | undefined {
	const candidate = context.orm
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

export function issueWorkflowCapability(
	context: PersistenceConnection,
	input: {
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
	}
): string {
	if (!/^[a-f\d]{64}$/i.test(input.tokenHash)) throw new OrchestrationError('capability token hash must be SHA-256 hex')
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		if (run.rootSessionId !== input.rootSessionId)
			throw new WorkflowTransitionError('capability root does not match Workflow')
		if (run.phase !== input.phase || run.cycle !== input.cycle || run.revision !== input.revision) {
			throw new WorkflowTransitionError('capability coordinates do not match Workflow')
		}
		const id = input.id ?? randomUUID()
		const at = context.now()
		context.db
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
		appendEvent(context, input.runId, input.eventKey, 'workflow_capability_issued', {
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

export function consumeWorkflowCapability(
	context: PersistenceConnection,
	input: {
		tokenHash: string
		runId: string
		rootSessionId: string
		role: WorkflowJobRole
		expectedPhase: WorkflowPhase
		expectedCycle: number
		expectedRevision: number
		eventKey: string
	}
): string {
	return context.immediate(() => {
		const capability = getWorkflowCapability(context, input.tokenHash)
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
		const run = requireRun(context, input.runId)
		if (
			run.rootSessionId !== input.rootSessionId ||
			run.phase !== input.expectedPhase ||
			run.cycle !== input.expectedCycle ||
			run.revision !== input.expectedRevision
		) {
			throw new WorkflowTransitionError('Workflow advanced past this capability')
		}
		const at = context.now()
		context.db.prepare('UPDATE workflow_capabilities SET consumed_at = ? WHERE id = ?').run(at, capability.id)
		appendEvent(context, input.runId, input.eventKey, 'workflow_capability_consumed', {
			capabilityId: capability.id,
			role: input.role
		})
		return capability.id
	})
}

export function revokeWorkflowCapabilities(
	context: PersistenceConnection,
	runId: string,
	eventKey: string,
	phase?: WorkflowPhase
): number {
	return context.immediate(() => {
		const at = context.now()
		const result = context.db
			.prepare(
				`UPDATE workflow_capabilities SET revoked_at = ?
				 WHERE run_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND (? IS NULL OR phase = ?)`
			)
			.run(at, runId, phase ?? null, phase ?? null)
		const count = Number(result.changes)
		appendEvent(context, runId, eventKey, 'workflow_capabilities_revoked', { phase, count })
		return count
	})
}
