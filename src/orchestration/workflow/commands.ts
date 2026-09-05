import { randomUUID } from 'node:crypto'
import { hashCapabilityToken, WorkflowTransitionError } from '../persistence/db.ts'
import { clearMatchingQuarantine, reconcileBlockedEffect, requireSameAmbiguousEffect } from './effect-recovery.ts'
import { WorkflowCoordinatorError } from './errors.ts'
import {
	actionOrdinal,
	cleanUnknown,
	guardJobs,
	isDeliveryReceipt,
	privateCorrelationBlock,
	promptRole,
	workflowEffectCorrelationMarker
} from './helpers.ts'
import { assertWorkflowDelegation, type WorkflowCapabilityClaims, workflowDelegationTransition } from './machine.ts'
import { workflowChildPrompt } from './prompts.ts'
import {
	assertCompatible,
	heartbeat,
	projection,
	requireBlockedAction,
	requireBlockedRun,
	requireEffect,
	requireRun
} from './state.ts'
import type {
	WorkflowAdoptInput,
	WorkflowContext,
	WorkflowDelegateInput,
	WorkflowDelegationResult,
	WorkflowMutationResult,
	WorkflowReplayInput,
	WorkflowRetryInput,
	WorkflowRunMutationInput
} from './types.ts'

export async function delegate(
	context: WorkflowContext,
	input: WorkflowDelegateInput
): Promise<WorkflowDelegationResult> {
	const tokenHash = hashCapabilityToken(input.phaseCapability)
	const request = {
		workflowId: input.workflowId,
		sessionId: input.sessionId,
		tokenHash,
		role: input.role,
		task: input.task,
		planningInterpretation: input.planningInterpretation
	}
	const replay = context.db.getIdempotentMutation<{ runId: string; jobId: string }>(
		'workflow_delegate',
		input.clientId,
		request
	)
	if (replay) {
		const job = context.db.getWorkflowJob(replay.result.jobId)
		if (!job) throw new WorkflowTransitionError('accepted Workflow job disappeared')
		return { replayed: true, job, workflow: projection(context, replay.result.runId) }
	}
	heartbeat(context)
	if (!input.task.trim())
		throw new WorkflowCoordinatorError('invalid_request', 'Delegation needs a focused task.', { status: 400 })
	const initial = context.db.getWorkflowRun(input.workflowId)
	if (!initial) throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
	const jobId = randomUUID()
	const transcriptCursor = await context.deps.captureTranscriptCursor?.(input.sessionId)
	const deliveryCursor = await context.deps.captureDeliveryCursor(input.sessionId)
	const role = initial.roles[input.role]
	const prompt = [
		workflowChildPrompt({
			roleName: input.role,
			objective: initial.objective,
			role: promptRole(role),
			task: input.task
		}),
		privateCorrelationBlock(initial.id, `job:${jobId}`)
	].join('\n\n')
	const mutation = context.db.idempotentMutation(
		'workflow_delegate',
		input.clientId,
		request,
		() => {
			const run = requireRun(context, input.workflowId)
			const jobs = context.db.listWorkflowJobs(run.id)
			const capability = context.db.getWorkflowCapability(tokenHash)
			const claims: WorkflowCapabilityClaims | null =
				capability &&
				(capability.phase === 'exploring' || capability.phase === 'planning' || capability.phase === 'reviewing')
					? {
							runId: capability.runId,
							rootSessionId: capability.rootSessionId,
							cycle: capability.cycle,
							revision: capability.revision,
							phase: capability.phase,
							allowedRoles: capability.allowedRoles,
							consumed: capability.consumedAt !== undefined,
							revoked: capability.revokedAt !== undefined
						}
					: null
			const guardRun = {
				id: run.id,
				rootSessionId: run.rootSessionId ?? null,
				phase: run.phase,
				cycle: run.cycle,
				revision: run.revision
			}
			assertWorkflowDelegation(guardRun, claims, { sessionId: input.sessionId, role: input.role }, guardJobs(jobs))
			const transition = workflowDelegationTransition(guardRun, input.role)
			const ordinal = actionOrdinal(jobs, input.role, transition.cycle)
			const logicalKey = `${transition.logicalPrefix}:${transition.cycle}:${ordinal}`
			context.db.consumeWorkflowCapability({
				tokenHash,
				runId: run.id,
				rootSessionId: input.sessionId,
				role: input.role,
				expectedPhase: run.phase,
				expectedCycle: run.cycle,
				expectedRevision: run.revision,
				eventKey: `capability-consumed:${logicalKey}`
			})
			const created = context.db.createWorkflowJob({
				id: jobId,
				runId: run.id,
				logicalKey,
				role: input.role,
				cycle: transition.cycle,
				revision: transition.revision,
				resolvedRole: role,
				prompt,
				state: 'queued',
				transcriptCursor,
				expectedCancellationGeneration: run.cancellationGeneration,
				eventKey: `delegated:${logicalKey}`
			})
			const advanced = context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: run.phase,
				expectedCancellationGeneration: run.cancellationGeneration,
				phase: transition.phase,
				cycle: transition.cycle,
				revision: transition.revision,
				...(input.role === 'implementation'
					? { planningInterpretation: input.planningInterpretation ?? input.task }
					: {}),
				eventKey: `delegation-transition:${logicalKey}`,
				eventType: 'workflow_delegation_accepted',
				eventData: { jobId: created.job.id, logicalKey, role: input.role }
			})
			context.db.revokeWorkflowCapabilities(run.id, `revoke-after-delegation:${logicalKey}`, run.phase)
			if (input.role === 'exploration') {
				const actionId = `authorize:exploring:${advanced.cycle}:${advanced.revision}`
				context.db.prepareWorkflowEffect({
					runId: run.id,
					actionId,
					kind: 'authorize_phase',
					target: { sessionId: input.sessionId },
					inputs: {
						grant: {
							phase: 'exploring',
							cycle: advanced.cycle,
							revision: advanced.revision,
							allowedRoles: ['exploration']
						},
						correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
					},
					cursor: deliveryCursor,
					expectedCancellationGeneration: run.cancellationGeneration,
					eventKey: `prepare:${actionId}`
				})
			}
			return { runId: run.id, jobId: created.job.id }
		},
		{ runId: input.workflowId }
	)
	const job = context.db.getWorkflowJob(mutation.result.jobId)
	if (!job) throw new WorkflowTransitionError('accepted Workflow job disappeared')
	return { replayed: mutation.replayed, job, workflow: projection(context, input.workflowId) }
}

export async function retry(context: WorkflowContext, input: WorkflowRetryInput): Promise<WorkflowMutationResult> {
	const replay = context.db.getIdempotentMutation<{ runId: string }>('workflow_retry', input.clientId, input)
	if (replay) return { replayed: true, workflow: projection(context, replay.result.runId) }
	heartbeat(context)
	await assertCompatible(context)
	const mutation = context.db.idempotentMutation(
		'workflow_retry',
		input.clientId,
		input,
		() => {
			const run = requireBlockedRun(context, input.workflowId)
			const actionId = run.blocked?.actionId as string
			if (run.blocked?.retryClass !== 'deterministic') {
				throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'This blocked action is not safely retryable.')
			}
			if (actionId.startsWith('job:')) {
				const jobId = actionId.slice(4)
				context.db.updateWorkflowJob({
					jobId,
					expectedStates: ['failed'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'queued',
					childSessionId: null,
					outcome: null,
					taskReceipt: null,
					batonReceipt: null,
					clearOwner: true,
					eventKey: `job-retry:${jobId}:${input.clientId}`,
					eventType: 'workflow_job_retry_queued'
				})
			} else if (actionId.startsWith('compatibility:') || actionId === 'bind-root') {
				// No external intent exists for these read-only gates; unblocking is the retry.
			} else {
				context.db.retryWorkflowEffect(run.id, actionId, `effect-retry:${actionId}:${input.clientId}`)
			}
			context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'blocked',
				expectedCancellationGeneration: run.cancellationGeneration,
				phase: run.blocked?.resumePhase,
				blocked: null,
				eventKey: `workflow-retry:${actionId}:${input.clientId}`,
				eventType: 'workflow_retry_accepted'
			})
			return { runId: run.id }
		},
		{ runId: input.workflowId }
	)
	return { replayed: mutation.replayed, workflow: projection(context, input.workflowId) }
}

export async function adopt(context: WorkflowContext, input: WorkflowAdoptInput): Promise<WorkflowMutationResult> {
	const replay = context.db.getIdempotentMutation<{ runId: string }>('workflow_adopt', input.clientId, input)
	if (replay) return { replayed: true, workflow: projection(context, replay.result.runId) }
	heartbeat(context)
	const run = requireBlockedAction(context, input.workflowId, input.actionId)
	const candidate = run.blocked?.candidates?.find(item => item.id === input.candidateId)
	if (!candidate)
		throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'That saved adoption candidate is unavailable.')
	const effect = requireEffect(context, run.id, input.actionId)
	if (effect.state !== 'ambiguous' || !context.deps.validateAdoption) {
		throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'This action cannot be adopted.')
	}
	const receipt = await context.deps.validateAdoption({ run, effect, candidate })
	if (receipt === null)
		throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'The candidate no longer validates.')
	const mutation = context.db.idempotentMutation(
		'workflow_adopt',
		input.clientId,
		input,
		() => {
			const current = requireBlockedAction(context, input.workflowId, input.actionId)
			const currentEffect = requireSameAmbiguousEffect(context, current.id, input.actionId, effect)
			context.db.markWorkflowEffectCommitted({
				runId: current.id,
				actionId: input.actionId,
				receipt: cleanUnknown(receipt),
				eventKey: `effect-adopted:${input.actionId}:${input.clientId}`
			})
			context.db.transitionWorkflowRun({
				runId: current.id,
				expectedPhase: 'blocked',
				expectedCancellationGeneration: current.cancellationGeneration,
				phase: current.blocked?.resumePhase,
				blocked: null,
				eventKey: `workflow-adopted:${input.actionId}:${input.clientId}`,
				eventType: 'workflow_effect_adopted',
				eventData: { candidateId: candidate.id }
			})
			clearMatchingQuarantine(context, currentEffect, `adopt:${input.clientId}`)
			return { runId: current.id }
		},
		{ runId: input.workflowId, actionId: input.actionId }
	)
	return { replayed: mutation.replayed, workflow: projection(context, input.workflowId) }
}

export async function replay(context: WorkflowContext, input: WorkflowReplayInput): Promise<WorkflowMutationResult> {
	const prior = context.db.getIdempotentMutation<{ runId: string }>('workflow_replay_ambiguous', input.clientId, input)
	if (prior) return { replayed: true, workflow: projection(context, prior.result.runId) }
	heartbeat(context)
	if (input.confirmDuplicateRisk !== true) {
		throw new WorkflowCoordinatorError(
			'workflow_recovery_invalid',
			'Risky replay requires explicit duplicate-risk confirmation.'
		)
	}
	const blocked = requireBlockedAction(context, input.workflowId, input.actionId)
	const effect = requireEffect(context, blocked.id, input.actionId)
	await reconcileBlockedEffect(context, blocked)
	if (requireRun(context, input.workflowId).phase !== 'blocked') {
		const reconciled = context.db.idempotentMutation(
			'workflow_replay_ambiguous',
			input.clientId,
			input,
			() => ({ runId: input.workflowId }),
			{ runId: input.workflowId, actionId: input.actionId }
		)
		return { replayed: reconciled.replayed, workflow: projection(context, input.workflowId) }
	}
	const mutation = context.db.idempotentMutation(
		'workflow_replay_ambiguous',
		input.clientId,
		input,
		() => {
			const run = requireBlockedAction(context, input.workflowId, input.actionId)
			if (run.blocked?.retryClass !== 'ambiguous') {
				throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'This action is not an ambiguous effect.')
			}
			if (run.blocked.candidates?.length) {
				throw new WorkflowCoordinatorError(
					'workflow_recovery_invalid',
					'Validate and adopt a saved candidate instead of risking a duplicate replay.'
				)
			}
			const currentEffect = requireSameAmbiguousEffect(context, run.id, input.actionId, effect)
			context.db.replayAmbiguousWorkflowEffect(
				run.id,
				input.actionId,
				`effect-replay:${input.actionId}:${input.clientId}`
			)
			context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'blocked',
				expectedCancellationGeneration: run.cancellationGeneration,
				phase: run.blocked?.resumePhase,
				blocked: null,
				eventKey: `workflow-replay:${input.actionId}:${input.clientId}`,
				eventType: 'workflow_ambiguous_replay_confirmed'
			})
			clearMatchingQuarantine(context, currentEffect, `replay:${input.clientId}`)
			return { runId: run.id }
		},
		{ runId: input.workflowId, actionId: input.actionId }
	)
	return { replayed: mutation.replayed, workflow: projection(context, input.workflowId) }
}

export async function complete(
	context: WorkflowContext,
	input: WorkflowRunMutationInput
): Promise<WorkflowMutationResult> {
	const replay = context.db.getIdempotentMutation<{ runId: string }>('workflow_complete', input.clientId, input)
	if (replay) return { replayed: true, workflow: projection(context, replay.result.runId) }
	heartbeat(context)
	const mutation = context.db.idempotentMutation(
		'workflow_complete',
		input.clientId,
		input,
		() => {
			const run = requireRun(context, input.workflowId)
			const jobs = context.db.listWorkflowJobs(run.id)
			const resultsDelivered =
				jobs.length > 0 &&
				jobs.every(
					job => job.state === 'returned' && isDeliveryReceipt(job.batonReceipt) && job.batonReceipt.kind === 'message'
				)
			if ((run.phase !== 'planning' && run.phase !== 'reviewing') || !resultsDelivered) {
				throw new WorkflowCoordinatorError(
					'workflow_recovery_invalid',
					'Workflow can complete only from planning or reviewing after every helper result is delivered.'
				)
			}
			context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: run.phase,
				expectedCancellationGeneration: run.cancellationGeneration,
				phase: 'completed',
				eventKey: `workflow-completed:${input.clientId}`,
				eventType: 'workflow_completed'
			})
			context.db.revokeWorkflowCapabilities(run.id, `revoke-on-complete:${input.clientId}`)
			return { runId: run.id }
		},
		{ runId: input.workflowId }
	)
	return { replayed: mutation.replayed, workflow: projection(context, input.workflowId) }
}

export async function cancel(
	context: WorkflowContext,
	input: WorkflowRunMutationInput
): Promise<WorkflowMutationResult> {
	const replay = context.db.getIdempotentMutation<{ runId: string }>('workflow_cancel', input.clientId, input)
	if (replay) return { replayed: true, workflow: projection(context, replay.result.runId) }
	heartbeat(context)
	const mutation = context.db.idempotentMutation(
		'workflow_cancel',
		input.clientId,
		input,
		() => {
			context.db.cancelWorkflowRun(input.workflowId, `workflow-cancelled:${input.clientId}`)
			context.db.revokeWorkflowCapabilities(input.workflowId, `revoke-on-cancel:${input.clientId}`)
			return { runId: input.workflowId }
		},
		{ runId: input.workflowId }
	)
	return { replayed: mutation.replayed, workflow: projection(context, input.workflowId) }
}
