import { isTerminalWorkflowPhase } from '../workflow/machine.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { appendEvent, findEvent, touchRun } from './events.ts'
import { canonicalOptional } from './idempotency.ts'
import { requireEffect, requireEffectByAction, requireRun } from './records.ts'
import type { AbandonedEffectRecovery, ProcessProbe, RelayIdentity, WorkflowEffectRecord } from './types.ts'
import {
	asObject,
	json,
	optionalJson,
	probeAlive,
	sameOptionalProcess,
	sameOwner,
	TERMINAL_EFFECT_STATES
} from './values.ts'

export function markWorkflowEffectReceiptLost(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		expectedReceipt: unknown
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return context.immediate(() => {
		const effect = requireEffectByAction(context, input.runId, input.actionId)
		const receipt = asObject(input.expectedReceipt)
		if (receipt.kind !== 'outbox' || typeof receipt.id !== 'string') {
			throw new WorkflowTransitionError('only a tagged outbox receipt can become lost')
		}
		if (canonicalOptional(effect.receipt) !== canonicalOptional(input.expectedReceipt)) {
			throw new WorkflowTransitionError(`effect ${input.actionId} receipt changed before loss reconciliation`)
		}
		if (effect.state === 'ambiguous' && effect.errorCode === input.errorCode) return effect
		if (effect.state !== 'committed') {
			throw new WorkflowTransitionError(`effect ${input.actionId} is ${effect.state}, expected committed`)
		}
		const at = context.now()
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'ambiguous', error_code = ?, error_message = ?,
					updated_at = ?, terminal_at = ? WHERE id = ? AND state = 'committed'`
			)
			.run(input.errorCode, input.errorMessage, at, at, effect.id)
		if (effect.attemptCount > 0) {
			context.db
				.prepare(
					`UPDATE workflow_effect_attempts SET state = 'ambiguous', evidence_json = ?, error_code = ?,
						error_message = ?, updated_at = ?, terminal_at = ? WHERE effect_id = ? AND attempt_number = ?`
				)
				.run(optionalJson(input.evidence), input.errorCode, input.errorMessage, at, at, effect.id, effect.attemptCount)
		}
		touchRun(context, input.runId, at)
		appendEvent(
			context,
			input.runId,
			input.eventKey ?? `effect_receipt_lost:${input.actionId}:${String(receipt.id)}`,
			'workflow_effect_receipt_lost',
			{ effectId: effect.id, actionId: input.actionId, errorCode: input.errorCode }
		)
		return requireEffect(context, effect.id)
	})
}

/** Record a post-cancellation receipt without reopening the run or effect. */
export function recordLateWorkflowEffect(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		receipt: unknown
		eventKey: string
	}
): WorkflowEffectRecord {
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		if (run.phase !== 'cancelled') {
			throw new WorkflowTransitionError(`Workflow ${run.id} is not cancelled`)
		}
		const effect = requireEffectByAction(context, run.id, input.actionId)
		const prior = findEvent(context, run.id, input.eventKey)
		if (prior) {
			if (prior.type !== 'late_effect' || canonicalOptional(effect.receipt) !== canonicalOptional(input.receipt)) {
				throw new WorkflowTransitionError(`late effect event ${input.eventKey} conflicts with existing evidence`)
			}
			return effect
		}
		const at = context.now()
		const settled = effect.state === 'dispatched' || effect.state === 'ambiguous'
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = ?, receipt_json = ?, error_code = ?, error_message = ?,
					updated_at = ?, terminal_at = COALESCE(terminal_at, ?) WHERE id = ?`
			)
			.run(
				settled ? 'committed' : effect.state,
				json(input.receipt),
				settled ? null : (effect.errorCode ?? null),
				settled ? null : (effect.errorMessage ?? null),
				at,
				settled ? at : (effect.terminalAt ?? null),
				effect.id
			)
		if (effect.attemptCount > 0) {
			context.db
				.prepare(
					`UPDATE workflow_effect_attempts SET state = CASE WHEN state IN ('dispatched', 'ambiguous') THEN 'committed' ELSE state END,
						receipt_json = ?, error_code = CASE WHEN state IN ('dispatched', 'ambiguous') THEN NULL ELSE error_code END,
						error_message = CASE WHEN state IN ('dispatched', 'ambiguous') THEN NULL ELSE error_message END,
						updated_at = ?, terminal_at = CASE WHEN state IN ('dispatched', 'ambiguous') THEN COALESCE(terminal_at, ?) ELSE terminal_at END
					 WHERE effect_id = ? AND attempt_number = ?`
				)
				.run(json(input.receipt), at, at, effect.id, effect.attemptCount)
		}
		const receipt = asObject(input.receipt)
		const deliveredMessage =
			receipt.kind === 'message' &&
			typeof receipt.id === 'string' &&
			Number.isSafeInteger(receipt.rowid) &&
			(receipt.turnId === null || typeof receipt.turnId === 'string')
		if (effect.jobId && deliveredMessage && (effect.kind === 'send_task' || effect.kind === 'return_baton')) {
			const receiptColumn = effect.kind === 'send_task' ? 'task_receipt_json' : 'baton_receipt_json'
			context.db
				.prepare(`UPDATE workflow_jobs SET ${receiptColumn} = ?, updated_at = ? WHERE id = ? AND run_id = ?`)
				.run(json(input.receipt), at, effect.jobId, run.id)
		}
		// A positive receipt is stronger than an earlier ambiguity. Clear only the
		// hold for this exact effect inside the same transaction; a newer unrelated
		// quarantine can never be erased by a late callback.
		context.db
			.prepare(
				`UPDATE ui_quarantine SET active = 0, cleared_at = ?, cleared_by = ?
				 WHERE id = 1 AND active = 1 AND (
					effect_id = ? OR (effect_id IS NULL AND action_id IN (?, ?))
				 )`
			)
			.run(at, `late-effect:${input.eventKey}`, effect.id, effect.id, effect.actionId)
		touchRun(context, run.id, at)
		appendEvent(context, run.id, input.eventKey, 'late_effect', {
			effectId: effect.id,
			actionId: effect.actionId,
			receipt: input.receipt
		})
		return requireEffect(context, effect.id)
	})
}

/**
 * Reconcile an orphan only after the caller checked for a positive receipt.
 * A dead owner before `mayExecute` is safely reset; every later boundary is ambiguous.
 */
export function reconcileAbandonedWorkflowEffect(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		eventKey: string
		processProbe?: ProcessProbe
	}
): AbandonedEffectRecovery {
	const observed = requireEffectByAction(context, input.runId, input.actionId)
	if (!observed.owner) return { status: 'unowned', effect: observed }
	if (TERMINAL_EFFECT_STATES.includes(observed.state)) return { status: 'terminal', effect: observed }
	const probe = input.processProbe ?? context.processProbe
	if (probeAlive(observed.owner, probe)) return { status: 'owner_alive', effect: observed }
	if (observed.externalProcess && probeAlive(observed.externalProcess, probe)) {
		return { status: 'external_process_alive', effect: observed }
	}

	return context.immediate(() => {
		const current = requireEffectByAction(context, input.runId, input.actionId)
		const run = requireRun(context, input.runId)
		if (
			!current.owner ||
			!sameOwner(current.owner, observed.owner as RelayIdentity) ||
			current.state !== observed.state ||
			current.attemptCount !== observed.attemptCount ||
			current.mayExecute !== observed.mayExecute ||
			!sameOptionalProcess(current.externalProcess, observed.externalProcess)
		) {
			return { status: 'changed', effect: current }
		}
		const safelyPrepared = current.state === 'prepared' || (current.state === 'dispatched' && !current.mayExecute)
		const terminalRun = isTerminalWorkflowPhase(run.phase)
		const at = context.now()
		if (safelyPrepared) {
			context.db
				.prepare(
					`UPDATE workflow_effects SET state = ?, owner_instance_id = NULL, owner_pid = NULL,
						owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
						external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
						may_execute = 0, error_code = NULL, error_message = NULL, updated_at = ?, terminal_at = ?
					 WHERE id = ?`
				)
				.run(terminalRun ? 'cancelled' : 'prepared', at, terminalRun ? at : null, current.id)
			if (current.attemptCount > 0) {
				context.db
					.prepare(
						`UPDATE workflow_effect_attempts SET state = 'cancelled', evidence_json = ?, updated_at = ?, terminal_at = ?
						 WHERE effect_id = ? AND attempt_number = ?`
					)
					.run(json({ reason: 'owner_died_before_may_execute' }), at, at, current.id, current.attemptCount)
			}
			touchRun(context, current.runId, at)
			appendEvent(
				context,
				current.runId,
				input.eventKey,
				terminalRun ? 'workflow_effect_cancelled_after_owner_exit' : 'workflow_effect_safely_recovered',
				{
					effectId: current.id,
					actionId: current.actionId,
					attemptNumber: current.attemptCount
				}
			)
			return {
				status: terminalRun ? 'terminal' : 'safely_prepared',
				effect: requireEffect(context, current.id)
			}
		}

		context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'ambiguous', error_code = 'ambiguous_effect',
					error_message = 'The UI action may have executed before its relay owner exited.',
					updated_at = ?, terminal_at = ? WHERE id = ?`
			)
			.run(at, at, current.id)
		if (current.attemptCount > 0) {
			context.db
				.prepare(
					`UPDATE workflow_effect_attempts SET state = 'ambiguous', error_code = 'ambiguous_effect',
						error_message = 'The UI action may have executed before its relay owner exited.',
						updated_at = ?, terminal_at = ? WHERE effect_id = ? AND attempt_number = ?`
				)
				.run(at, at, current.id, current.attemptCount)
		}
		touchRun(context, current.runId, at)
		appendEvent(context, current.runId, input.eventKey, 'workflow_effect_abandoned_ambiguous', {
			effectId: current.id,
			actionId: current.actionId,
			attemptNumber: current.attemptCount
		})
		return { status: 'ambiguous', effect: requireEffect(context, current.id) }
	})
}

export function retryWorkflowEffect(
	context: PersistenceConnection,
	runId: string,
	actionId: string,
	eventKey: string
): WorkflowEffectRecord {
	return context.immediate(() => {
		const run = requireRun(context, runId)
		if (isTerminalWorkflowPhase(run.phase)) {
			throw new WorkflowTransitionError(`terminal Workflow ${run.id} cannot retry effects`)
		}
		const effect = requireEffectByAction(context, runId, actionId)
		if (effect.state !== 'failed')
			throw new WorkflowTransitionError(`effect ${actionId} is not deterministically failed`)
		const at = context.now()
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'prepared', owner_instance_id = NULL, owner_pid = NULL,
					owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
					external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
					may_execute = 0, error_code = NULL, error_message = NULL, updated_at = ?, terminal_at = NULL
				 WHERE id = ?`
			)
			.run(at, effect.id)
		touchRun(context, runId, at)
		appendEvent(context, runId, eventKey, 'workflow_effect_retry_prepared', {
			effectId: effect.id,
			actionId,
			nextAttempt: effect.attemptCount + 1
		})
		return requireEffect(context, effect.id)
	})
}

/** Used only behind the explicit, idempotent phone confirmation for duplicate risk. */
export function replayAmbiguousWorkflowEffect(
	context: PersistenceConnection,
	runId: string,
	actionId: string,
	eventKey: string
): WorkflowEffectRecord {
	return context.immediate(() => {
		const run = requireRun(context, runId)
		if (isTerminalWorkflowPhase(run.phase)) {
			throw new WorkflowTransitionError(`terminal Workflow ${run.id} cannot replay effects`)
		}
		const effect = requireEffectByAction(context, runId, actionId)
		if (effect.state !== 'ambiguous') {
			throw new WorkflowTransitionError(`effect ${actionId} is not ambiguous`)
		}
		const at = context.now()
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'prepared', owner_instance_id = NULL, owner_pid = NULL,
					owner_process_started_at = NULL, owner_protocol_version = NULL, launch_nonce = NULL,
					external_pid = NULL, external_process_started_at = NULL, external_process_group = NULL,
					may_execute = 0, receipt_json = NULL, error_code = NULL, error_message = NULL,
					updated_at = ?, terminal_at = NULL WHERE id = ?`
			)
			.run(at, effect.id)
		touchRun(context, runId, at)
		appendEvent(context, runId, eventKey, 'workflow_effect_risky_replay_prepared', {
			effectId: effect.id,
			actionId,
			previousAttempt: effect.attemptCount,
			nextAttempt: effect.attemptCount + 1
		})
		return requireEffect(context, effect.id)
	})
}
