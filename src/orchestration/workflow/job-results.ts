import { workflowPrivateEnvelope } from '../../shared.ts'
import type { WorkflowChildRoleName } from '../../wire.ts'
import { type WorkflowJobRecord, type WorkflowRunRecord, WorkflowTransitionError } from '../persistence/db.ts'
import { markReceiptLost } from './effect-recovery.ts'
import { runDurableEffect } from './effects.ts'
import {
	assertDeliveryReceipt,
	effectGrant,
	guardJobs,
	isDeliveryReceipt,
	messageReceipt,
	privateCorrelationBlock,
	sanitizeChildOutcome,
	workflowEffectCorrelationMarker
} from './helpers.ts'
import { phaseAfterDeliveredBaton } from './machine.ts'
import { blockRun, effectCall, effectReadCall, requireEffect, requireRun } from './state.ts'
import type { CapabilityGrant, WorkflowChildOutcome, WorkflowContext } from './types.ts'

export async function driveJobOutcome(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	const outcome = await context.deps.readChildOutcome({ run, job })
	if (!outcome) return false
	const sanitized = sanitizeChildOutcome(outcome)
	const freshRun = requireRun(context, run.id)
	if (freshRun.phase === 'cancelled') {
		context.db.recordLateWorkflowChildResult({
			runId: freshRun.id,
			jobId: job.id,
			attemptNumber: job.attemptCount,
			outcome: sanitized,
			eventKey: `late-child:${job.id}:${job.attemptCount}`
		})
		return true
	}
	if (sanitized.kind === 'failure') {
		context.db.idempotentMutation(
			'workflow_job_failed',
			`${job.id}:${job.attemptCount}`,
			sanitized,
			() => {
				context.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'running',
					state: 'failed',
					outcome: sanitized,
					failureEvidence: sanitized.evidence,
					eventKey: `attempt-failed:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_failed'
				})
				context.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['running'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'failed',
					outcome: sanitized,
					clearOwner: true,
					eventKey: `job-failed:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_failed'
				})
				blockRun(context, requireRun(context, run.id), {
					actionId: `job:${job.id}`,
					errorCode: sanitized.code,
					message: sanitized.message,
					retryClass: sanitized.retryClass ?? 'deterministic'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId: `job:${job.id}` }
		)
		return true
	}
	context.db.idempotentMutation(
		'workflow_job_outcome',
		`${job.id}:${job.attemptCount}`,
		sanitized,
		() => {
			context.db.updateWorkflowJobAttempt({
				jobId: job.id,
				attemptNumber: job.attemptCount,
				expectedState: 'running',
				state: 'returning',
				outcome: sanitized,
				eventKey: `attempt-returning:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_attempt_returning'
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['running'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'returning',
				outcome: sanitized,
				eventKey: `job-returning:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_returning'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId: `job:${job.id}:outcome` }
	)
	return true
}

export function potentialBatonGrant(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): CapabilityGrant | undefined {
	const peers = context.db
		.listWorkflowJobs(run.id)
		.filter(peer => peer.cycle === job.cycle && peer.role === job.role && peer.id !== job.id)
	const peersDelivered = peers.every(
		peer => peer.state === 'returned' && isDeliveryReceipt(peer.batonReceipt) && peer.batonReceipt.kind === 'message'
	)
	if (!peersDelivered) return undefined
	return {
		phase: job.role === 'exploration' ? 'planning' : 'reviewing',
		cycle: run.cycle,
		revision: run.revision + 1,
		allowedRoles: ['exploration', 'implementation']
	}
}

export async function driveJobBaton(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	if (!run.rootSessionId) throw new WorkflowTransitionError(`Workflow ${run.id} has no root for Baton return`)
	const outcome = job.outcome as WorkflowChildOutcome | undefined
	if (outcome?.kind !== 'success') throw new WorkflowTransitionError(`job ${job.id} has no successful outcome`)
	const actionId = `${job.id}:baton:${job.attemptCount}`
	let effect = context.db.getWorkflowEffect(run.id, actionId)
	if (!effect) {
		const roleJobs = context.db
			.listWorkflowJobs(run.id)
			.filter(peer => peer.cycle === job.cycle && peer.role === job.role)
		const designatedFinal = roleJobs.at(-1)?.id === job.id
		const grant = designatedFinal ? potentialBatonGrant(context, run, job) : undefined
		// Exactly one current-cycle Baton carries the next phase capability. Hold
		// that deterministic final job until every earlier sibling Baton is a
		// durable root message; accepted outbox rows do not satisfy the barrier.
		if (designatedFinal && !grant) return false
		effect = context.db.prepareWorkflowEffect({
			id: `${run.id}:${actionId}`,
			runId: run.id,
			actionId,
			kind: 'return_baton',
			jobId: job.id,
			target: { sessionId: run.rootSessionId },
			inputs: {
				...(grant ? { grant } : {}),
				correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
			},
			cursor: await context.deps.captureDeliveryCursor(run.rootSessionId),
			expectedCancellationGeneration: run.cancellationGeneration,
			eventKey: `prepare:${actionId}`
		}).effect
	}
	const grant = effectGrant(effect) ?? undefined
	let current = effect
	let changed = false
	if (effect.state !== 'committed') {
		const result = await runDurableEffect(context, {
			run,
			effect,
			job,
			...(grant ? { capabilityGrant: grant } : {}),
			execute: (token, dispatch) => {
				const envelope =
					grant && token
						? workflowPrivateEnvelope({
								workflowId: run.id,
								phaseCapability: token,
								cycle: grant.cycle,
								revision: grant.revision,
								allowedRoles: grant.allowedRoles
							})
						: ''
				return context.deps.returnBaton({
					...effectCall(run, effect, dispatch, job),
					job,
					sessionId: run.rootSessionId as string,
					text: [outcome.baton, envelope, privateCorrelationBlock(run.id, effect.actionId)].filter(Boolean).join('\n\n')
				})
			},
			validate: assertDeliveryReceipt
		})
		current = result.effect
		changed = result.changed
	}
	if (current.state !== 'committed' || !isDeliveryReceipt(current.receipt)) return changed
	const latestJob = context.db.getWorkflowJob(job.id)
	if (latestJob?.state !== 'returning') return true
	const resolution = await context.deps.resolveDeliveryReceipt({
		...effectReadCall(run, current, job),
		sessionId: run.rootSessionId,
		receipt: current.receipt
	})
	if (resolution.status === 'lost') {
		markReceiptLost(context, run, current, resolution.evidence)
		return true
	}
	const resolved = messageReceipt(resolution, current.receipt.id)
	if (!resolved) {
		if (!isDeliveryReceipt(latestJob.batonReceipt)) {
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['returning'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'returning',
				batonReceipt: current.receipt,
				eventKey: `baton-accepted:${job.id}:${current.receipt.id}`,
				eventType: 'workflow_baton_accepted'
			})
			return true
		}
		return changed
	}
	context.db.idempotentMutation(
		'workflow_baton_delivered',
		`${job.id}:${resolved.id}`,
		resolved,
		() => {
			context.db.updateWorkflowJobAttempt({
				jobId: job.id,
				attemptNumber: job.attemptCount,
				expectedState: 'returning',
				state: 'returned',
				outcome: outcome,
				eventKey: `attempt-returned:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_attempt_returned'
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['returning'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'returned',
				batonReceipt: resolved,
				clearOwner: true,
				eventKey: `job-returned:${job.id}:${resolved.id}`,
				eventType: 'workflow_job_returned'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId }
	)
	advanceDeliveredBarrier(context, requireRun(context, run.id))
	return true
}

export function advanceDeliveredBarrier(context: WorkflowContext, run: WorkflowRunRecord): boolean {
	if (run.phase !== 'exploring' && run.phase !== 'implementing') return false
	const role: WorkflowChildRoleName = run.phase === 'exploring' ? 'exploration' : 'implementation'
	const jobs = context.db.listWorkflowJobs(run.id)
	const next = phaseAfterDeliveredBaton(role, guardJobs(jobs), run.cycle)
	if (!next) return false
	const grantJob = [...jobs].reverse().find(job => {
		if (job.role !== role || job.cycle !== run.cycle || job.state !== 'returned') return false
		const effect = context.db.getWorkflowEffect(run.id, `${job.id}:baton:${job.attemptCount}`)
		return effect ? effectGrant(effect)?.phase === next : false
	})
	if (!grantJob) {
		blockRun(context, run, {
			actionId: `barrier:${role}:${run.cycle}`,
			errorCode: 'workflow_barrier_capability_missing',
			message: 'The final delivered Baton had no matching phase authorization.',
			retryClass: 'terminal'
		})
		return true
	}
	const effect = requireEffect(context, run.id, `${grantJob.id}:baton:${grantJob.attemptCount}`)
	const receipt =
		isDeliveryReceipt(grantJob.batonReceipt) && grantJob.batonReceipt.kind === 'message' ? grantJob.batonReceipt : null
	const grant = effectGrant(effect)
	if (!receipt || !grant || !effect.launchNonce) return false
	context.db.idempotentMutation(
		'advance_workflow_baton_barrier',
		`${run.id}:${role}:${run.cycle}:${receipt.id}`,
		{ role, receipt, grant, tokenHash: effect.launchNonce },
		() => {
			const current = requireRun(context, run.id)
			if (current.phase !== run.phase || current.cycle !== run.cycle || current.revision !== run.revision) {
				return { runId: run.id }
			}
			const implementationDelivered = context.db
				.listWorkflowJobs(run.id)
				.filter(
					job =>
						job.role === 'implementation' &&
						job.state === 'returned' &&
						isDeliveryReceipt(job.batonReceipt) &&
						job.batonReceipt.kind === 'message'
				).length
			const advanced = context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: run.phase,
				expectedCancellationGeneration: current.cancellationGeneration,
				phase: next,
				cycle: grant.cycle,
				revision: grant.revision,
				implementationBatonsDelivered: implementationDelivered,
				eventKey: `barrier-advanced:${role}:${receipt.id}`,
				eventType: 'workflow_baton_barrier_satisfied',
				eventData: { role, receipt }
			})
			context.db.revokeWorkflowCapabilities(run.id, `revoke-after-barrier:${receipt.id}`, run.phase)
			context.db.issueWorkflowCapability({
				tokenHash: effect.launchNonce as string,
				runId: run.id,
				rootSessionId: advanced.rootSessionId as string,
				cycle: advanced.cycle,
				phase: next,
				revision: advanced.revision,
				allowedRoles: grant.allowedRoles,
				issuedWith: { rowid: receipt.rowid, ...(receipt.turnId ? { turnId: receipt.turnId } : {}) },
				eventKey: `capability-after-baton:${receipt.id}`
			})
			return { runId: run.id }
		},
		{ runId: run.id, actionId: effect.actionId }
	)
	return true
}
