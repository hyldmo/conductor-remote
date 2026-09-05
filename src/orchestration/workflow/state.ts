import { scrubWorkflowSecrets } from '../../shared.ts'
import {
	type WorkflowAdoptionCandidate,
	type WorkflowEffectRecord,
	type WorkflowJobRecord,
	type WorkflowRetryClass,
	type WorkflowRunProjection,
	type WorkflowRunRecord,
	WorkflowTransitionError
} from '../persistence/db.ts'
import { WorkflowCoordinatorError } from './errors.ts'
import { activeResumePhase, cleanUnknown, workflowEffectCorrelationMarker } from './helpers.ts'
import { isTerminalWorkflowPhase } from './machine.ts'
import type { WorkflowContext, WorkflowEffectCall, WorkflowEffectDispatch, WorkflowEffectReadCall } from './types.ts'

export function projection(context: WorkflowContext, runId: string): WorkflowRunProjection {
	const projection = context.db.getWorkflowProjection(runId)
	if (!projection) throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
	return projection
}

export function projections(context: WorkflowContext, includeTerminal = false): WorkflowRunProjection[] {
	return context.db.listWorkflowProjections({ includeTerminal })
}

export function runIdsNeedingWake(context: WorkflowContext): string[] {
	return context.db.listWorkflowRunIdsNeedingWake()
}

export function workflowForSession(context: WorkflowContext, sessionId: string): WorkflowRunProjection | undefined {
	for (const projection of context.db.listWorkflowProjections()) {
		if (projection.rootSessionId === sessionId) return projection
		if (context.db.listWorkflowJobs(projection.id).some(job => job.childSessionId === sessionId)) return projection
	}
	return undefined
}

export function ownsSession(context: WorkflowContext, sessionId: string): boolean {
	return workflowForSession(context, sessionId) !== undefined
}

export function blockRun(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	blocked: {
		actionId: string
		errorCode: string
		message: string
		retryClass: WorkflowRetryClass
		candidates?: WorkflowAdoptionCandidate[]
	}
): void {
	if (run.phase === 'blocked' || isTerminalWorkflowPhase(run.phase)) return
	const blockOrdinal = context.db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_blocked').length
	context.db.transitionWorkflowRun({
		runId: run.id,
		expectedPhase: run.phase,
		expectedCancellationGeneration: run.cancellationGeneration,
		phase: 'blocked',
		blocked: {
			actionId: blocked.actionId,
			errorCode: scrubWorkflowSecrets(blocked.errorCode),
			message: scrubWorkflowSecrets(blocked.message).slice(0, 500),
			resumePhase: activeResumePhase(run),
			retryClass: blocked.retryClass,
			...(blocked.candidates
				? {
						candidates: blocked.candidates
							.slice(0, 20)
							.map(candidate => cleanUnknown(candidate) as WorkflowAdoptionCandidate)
					}
				: {})
		},
		eventKey: `workflow-blocked:${blocked.actionId}:${blockOrdinal}`,
		eventType: 'workflow_blocked',
		eventData: { actionId: blocked.actionId, retryClass: blocked.retryClass }
	})
}

export function requireBlockedAction(context: WorkflowContext, runId: string, actionId: string): WorkflowRunRecord {
	const run = requireBlockedRun(context, runId)
	if (run.blocked?.actionId !== actionId) {
		throw new WorkflowCoordinatorError(
			'workflow_recovery_invalid',
			'Recovery does not match the current blocked action.'
		)
	}
	return run
}

export function requireBlockedRun(context: WorkflowContext, runId: string): WorkflowRunRecord {
	const run = requireRun(context, runId)
	if (run.phase !== 'blocked' || !run.blocked) {
		throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'Workflow has no current blocked action.')
	}
	return run
}

export function requireRun(context: WorkflowContext, runId: string): WorkflowRunRecord {
	const run = context.db.getWorkflowRun(runId)
	if (!run) throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
	return run
}

export function requireEffect(context: WorkflowContext, runId: string, actionId: string): WorkflowEffectRecord {
	const effect = context.db.getWorkflowEffect(runId, actionId)
	if (!effect) throw new WorkflowTransitionError(`Workflow effect ${actionId} does not exist`)
	return effect
}

export function effectCall(
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord,
	dispatch: WorkflowEffectDispatch,
	job?: WorkflowJobRecord
): WorkflowEffectCall {
	return {
		...effectReadCall(run, effect, job),
		dispatch
	}
}

export function effectReadCall(
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord,
	job?: WorkflowJobRecord
): WorkflowEffectReadCall {
	return {
		run,
		effect,
		...(job ? { job } : {}),
		correlationMarker: workflowEffectCorrelationMarker(run.id, effect.actionId)
	}
}

export async function assertCompatible(context: WorkflowContext): Promise<void> {
	await context.deps.assertCompatibleRelays?.()
}

export function heartbeat(context: WorkflowContext): void {
	if (!context.db.heartbeatRelayInstance(context.relay)) {
		context.db.registerRelayInstance({ ...context.relay, canDriveUi: true })
	}
}
