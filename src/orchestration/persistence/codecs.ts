import { OrchestrationError } from './errors.ts'
import {
	type WorkflowEffectAttemptRow,
	type WorkflowEffectRow,
	type WorkflowEventRow,
	type WorkflowJobAttemptRow,
	type WorkflowJobRow,
	type WorkflowRunRow,
	workflowEffectAttemptSelectSchema,
	workflowEffectSelectSchema,
	workflowEventSelectSchema,
	workflowJobAttemptSelectSchema,
	workflowJobSelectSchema,
	workflowRunSelectSchema
} from './schema.ts'
import type {
	WorkflowEffectAttemptRecord,
	WorkflowEffectRecord,
	WorkflowEventRecord,
	WorkflowJobAttemptRecord,
	WorkflowJobRecord,
	WorkflowRunRecord
} from './types.ts'
import { externalFromColumns, jsonProperty, ownerFromColumns } from './values.ts'

export function decodeRun(candidate: WorkflowRunRow): WorkflowRunRecord {
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

export function decodeJob(candidate: WorkflowJobRow): WorkflowJobRecord {
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

export function decodeJobAttempt(candidate: WorkflowJobAttemptRow): WorkflowJobAttemptRecord {
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

export function decodeEffect(candidate: WorkflowEffectRow): WorkflowEffectRecord {
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

export function decodeEffectAttempt(candidate: WorkflowEffectAttemptRow): WorkflowEffectAttemptRecord {
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

export function decodeEvent(candidate: WorkflowEventRow): WorkflowEventRecord {
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
