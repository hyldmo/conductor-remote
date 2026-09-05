import { type WorkflowRunProjection, type WorkflowRunRecord, WorkflowTransitionError } from '../persistence/db.ts'
import { markReceiptLost, reconcileBlockedEffect } from './effect-recovery.ts'
import {
	cleanUnknown,
	effectSessionId,
	errorMessage,
	isDeliveryReceipt,
	receiptEventSuffix,
	sanitizeChildOutcome
} from './helpers.ts'
import { driveNextJob } from './job-dispatch.ts'
import { advanceDeliveredBarrier } from './job-results.ts'
import { drivePendingRoot, drivePhaseAuthorization, driveRootBinding, driveWorkspaceCreation } from './root.ts'
import { assertCompatible, blockRun, effectReadCall, heartbeat, projection, requireRun } from './state.ts'
import type { WorkflowContext } from './types.ts'

const MAX_WAKE_STEPS = 64

export function wake(context: WorkflowContext, runId: string): Promise<WorkflowRunProjection> {
	const existing = context.waking.get(runId)
	if (existing) return existing
	const running = wakeInternal(context, runId).finally(() => context.waking.delete(runId))
	context.waking.set(runId, running)
	return running
}

export async function wakeInternal(context: WorkflowContext, runId: string): Promise<WorkflowRunProjection> {
	heartbeat(context)
	for (let step = 0; step < MAX_WAKE_STEPS; step++) {
		const run = requireRun(context, runId)
		if (run.phase === 'cancelled') {
			await observeCancelledRun(context, run)
			break
		}
		if (run.phase === 'completed') break
		if (run.phase === 'blocked') {
			if (await reconcileBlockedEffect(context, run)) continue
			break
		}
		try {
			await assertCompatible(context)
		} catch (error) {
			blockRun(context, run, {
				actionId: `compatibility:${run.id}`,
				errorCode: 'workflow_incompatible_relay',
				message: errorMessage(error),
				retryClass: 'deterministic'
			})
			break
		}
		let changed = false
		try {
			changed = await driveOnce(context, run)
		} catch (error) {
			if (error instanceof WorkflowTransitionError) {
				const current = requireRun(context, runId)
				if (current.phase !== run.phase || current.cancellationGeneration !== run.cancellationGeneration) continue
			}
			throw error
		}
		if (!changed) break
	}
	return projection(context, runId)
}

export async function observeCancelledRun(context: WorkflowContext, run: WorkflowRunRecord): Promise<void> {
	const observedEffects = new Map(context.db.listWorkflowEffects(run.id).map(effect => [effect.id, effect]))
	for (const observed of observedEffects.values()) {
		let effect = observed
		const sessionId = effectSessionId(effect)
		if (sessionId && isDeliveryReceipt(effect.receipt) && effect.receipt.kind === 'outbox') {
			const resolution = await context.deps.resolveDeliveryReceipt({
				...effectReadCall(run, effect),
				sessionId,
				receipt: effect.receipt
			})
			if (resolution.status === 'lost') {
				markReceiptLost(context, run, effect, resolution.evidence)
				continue
			}
			if (resolution.status === 'delivered' && resolution.receipt.id === effect.receipt.id) {
				effect = context.db.recordLateWorkflowEffect({
					runId: run.id,
					actionId: effect.actionId,
					receipt: resolution.receipt,
					eventKey: `late-effect:${effect.actionId}:message:${resolution.receipt.id}`
				})
				observedEffects.set(effect.id, effect)
			}
		}
		if (effect.state !== 'dispatched' && effect.state !== 'ambiguous') continue
		const reconciliation = await context.deps.reconcileEffect?.(effectReadCall(run, effect))
		if (reconciliation?.status === 'committed') {
			const receipt = cleanUnknown(reconciliation.receipt)
			effect = context.db.recordLateWorkflowEffect({
				runId: run.id,
				actionId: effect.actionId,
				receipt,
				eventKey: `late-effect:${effect.actionId}:${receiptEventSuffix(receipt, `attempt:${effect.attemptCount}`)}`
			})
			observedEffects.set(effect.id, effect)
			continue
		}
		if (effect.state === 'dispatched' && effect.mayExecute) {
			const recovery = context.db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: effect.actionId,
				eventKey: `late-effect-recovery:${effect.actionId}:${effect.attemptCount}`
			})
			if (recovery.status !== 'ambiguous') continue
			const ambiguous = recovery.effect
			context.db.activateUiQuarantine({
				actionId: ambiguous.actionId,
				effectId: ambiguous.id,
				reason: ambiguous.errorMessage ?? 'A cancelled Workflow effect remains ambiguous.',
				owner: ambiguous.owner,
				externalProcess: ambiguous.externalProcess
			})
		}
	}

	for (const job of context.db.listWorkflowJobs(run.id)) {
		if (job.state !== 'cancelled' || !job.childSessionId || job.outcome !== undefined) continue
		const taskEffect = [...observedEffects.values()].find(
			effect => effect.jobId === job.id && effect.kind === 'send_task'
		)
		const taskReceipt =
			isDeliveryReceipt(job.taskReceipt) && job.taskReceipt.kind === 'message'
				? job.taskReceipt
				: isDeliveryReceipt(taskEffect?.receipt) && taskEffect.receipt.kind === 'message'
					? taskEffect.receipt
					: undefined
		if (!taskReceipt) continue
		const outcome = await context.deps.readChildOutcome({
			run,
			job: job.taskReceipt === taskReceipt ? job : { ...job, taskReceipt }
		})
		if (!outcome) continue
		context.db.recordLateWorkflowChildResult({
			runId: run.id,
			jobId: job.id,
			attemptNumber: job.attemptCount,
			outcome: sanitizeChildOutcome(outcome),
			eventKey: `late-child:${job.id}:${job.attemptCount}`
		})
	}
}

export async function driveOnce(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	if (run.phase === 'creating_workspace') return driveWorkspaceCreation(context, run)
	if (run.phase === 'binding_root') return driveRootBinding(context, run)
	if (run.phase === 'pending_root') return drivePendingRoot(context, run)
	if (
		run.phase === 'exploring' ||
		run.phase === 'planning' ||
		run.phase === 'implementing' ||
		run.phase === 'reviewing'
	) {
		if (await drivePhaseAuthorization(context, run)) return true
		if (advanceDeliveredBarrier(context, run)) return true
		if (run.phase === 'planning' || run.phase === 'reviewing') return false
		return driveNextJob(context, run)
	}
	return false
}
