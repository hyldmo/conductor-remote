import type { WorkflowAdoptionCandidate, WorkflowEffectRecord, WorkflowRunRecord } from '../persistence/db.ts'
import { WorkflowCoordinatorError } from './errors.ts'
import { cleanUnknown, isDeliveryReceipt, receiptEventSuffix } from './helpers.ts'
import { blockRun, effectReadCall, requireBlockedAction, requireEffect, requireRun } from './state.ts'
import type { WorkflowContext } from './types.ts'

/** A later positive receipt resolves ambiguity safely; a newly visible candidate only refreshes the phone choice. */
export async function reconcileBlockedEffect(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	if (run.phase !== 'blocked' || run.blocked?.retryClass !== 'ambiguous') return false
	const effect = context.db.getWorkflowEffect(run.id, run.blocked.actionId)
	if (effect?.state !== 'ambiguous') return false
	const reconciliation = await context.deps.reconcileEffect?.(effectReadCall(run, effect))
	if (!reconciliation || reconciliation.status === 'pending') return false
	if (reconciliation.status === 'committed') {
		const receipt = cleanUnknown(reconciliation.receipt)
		context.db.idempotentMutation(
			'reconcile_blocked_workflow_effect',
			`${run.id}:${effect.actionId}:${receiptEventSuffix(receipt, `attempt:${effect.attemptCount}`)}`,
			{ actionId: effect.actionId, receipt },
			() => {
				const current = requireBlockedAction(context, run.id, effect.actionId)
				const currentEffect = requireSameAmbiguousEffect(context, current.id, effect.actionId, effect)
				context.db.markWorkflowEffectCommitted({
					runId: current.id,
					actionId: effect.actionId,
					receipt,
					eventKey: `effect-positive-while-blocked:${effect.actionId}:${effect.attemptCount}`
				})
				context.db.transitionWorkflowRun({
					runId: current.id,
					expectedPhase: 'blocked',
					expectedCancellationGeneration: current.cancellationGeneration,
					phase: current.blocked?.resumePhase,
					blocked: null,
					eventKey: `workflow-positive-while-blocked:${effect.actionId}:${effect.attemptCount}`,
					eventType: 'workflow_ambiguous_effect_reconciled'
				})
				clearMatchingQuarantine(context, currentEffect, `positive-receipt:${effect.id}`)
				return { runId: current.id }
			},
			{ runId: run.id, actionId: effect.actionId }
		)
		return true
	}

	const candidates = (reconciliation.candidates ?? [])
		.slice(0, 20)
		.map(candidate => cleanUnknown(candidate) as WorkflowAdoptionCandidate)
	const prior = run.blocked.candidates ?? []
	if (JSON.stringify(prior) === JSON.stringify(candidates)) return false
	context.db.transitionWorkflowRun({
		runId: run.id,
		expectedPhase: 'blocked',
		expectedCancellationGeneration: run.cancellationGeneration,
		phase: 'blocked',
		blocked: { ...run.blocked, candidates },
		eventKey: `workflow-candidates-refreshed:${effect.actionId}:${effect.attemptCount}:${candidates.map(item => item.id).join(',') || 'none'}`,
		eventType: 'workflow_adoption_candidates_refreshed',
		eventData: { actionId: effect.actionId, candidateCount: candidates.length }
	})
	return true
}

export function markReceiptLost(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord,
	evidence?: unknown
): void {
	if (!isDeliveryReceipt(effect.receipt) || effect.receipt.kind !== 'outbox') {
		throw new WorkflowCoordinatorError(
			'workflow_adapter_invalid',
			`Delivery resolver reported a non-outbox receipt lost for ${effect.actionId}.`
		)
	}
	const errorMessage =
		'Conductor accepted the queued message, but it disappeared before a durable message row was found.'
	const ambiguous =
		effect.state === 'dispatched'
			? context.db.markWorkflowEffectAmbiguous({
					runId: run.id,
					actionId: effect.actionId,
					errorCode: 'outbox_receipt_lost',
					errorMessage,
					...(evidence === undefined ? {} : { evidence: cleanUnknown(evidence) }),
					eventKey: `effect-receipt-lost:${effect.actionId}:${effect.receipt.id}`
				})
			: context.db.markWorkflowEffectReceiptLost({
					runId: run.id,
					actionId: effect.actionId,
					expectedReceipt: effect.receipt,
					errorCode: 'outbox_receipt_lost',
					errorMessage,
					...(evidence === undefined ? {} : { evidence: cleanUnknown(evidence) }),
					eventKey: `effect-receipt-lost:${effect.actionId}:${effect.receipt.id}`
				})
	const current = requireRun(context, run.id)
	if (current.phase === 'cancelled') {
		context.db.activateUiQuarantine({
			actionId: ambiguous.actionId,
			effectId: ambiguous.id,
			reason: ambiguous.errorMessage ?? 'A cancelled Workflow has a lost accepted outbox receipt.',
			owner: ambiguous.owner,
			externalProcess: ambiguous.externalProcess
		})
		return
	}
	quarantineAndBlock(context, current, ambiguous)
}

export function quarantineAndBlock(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord,
	candidates?: WorkflowAdoptionCandidate[]
): void {
	context.db.activateUiQuarantine({
		actionId: effect.actionId,
		effectId: effect.id,
		reason: effect.errorMessage ?? 'Workflow UI effect has no positive receipt.',
		owner: effect.owner,
		externalProcess: effect.externalProcess
	})
	blockRun(context, requireRun(context, run.id), {
		actionId: effect.actionId,
		errorCode: effect.errorCode ?? 'workflow_effect_ambiguous',
		message: effect.errorMessage ?? 'The UI action may have executed; automatic replay is disabled.',
		retryClass: 'ambiguous',
		candidates
	})
}

/** Call only inside the surrounding durable mutation so a newer hold cannot be cleared between read and write. */
export function clearMatchingQuarantine(
	context: WorkflowContext,
	effect: WorkflowEffectRecord,
	clearedBy: string
): void {
	const quarantine = context.db.getUiQuarantine()
	const matches = quarantine.effectId
		? quarantine.effectId === effect.id
		: quarantine.actionId === effect.id || quarantine.actionId === effect.actionId
	if (quarantine.active && matches) {
		context.db.clearUiQuarantine(clearedBy)
	}
}

export function requireSameAmbiguousEffect(
	context: WorkflowContext,
	runId: string,
	actionId: string,
	expected: WorkflowEffectRecord
): WorkflowEffectRecord {
	const current = requireEffect(context, runId, actionId)
	if (current.state !== 'ambiguous' || current.attemptCount !== expected.attemptCount) {
		throw new WorkflowCoordinatorError(
			'workflow_recovery_invalid',
			'The ambiguous action changed while it was being validated; inspect its current state and try again.'
		)
	}
	return current
}
