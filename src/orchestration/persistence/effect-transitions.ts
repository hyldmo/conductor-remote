import { isTerminalWorkflowPhase } from '../workflow/machine.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { appendEvent, findEvent, touchRun } from './events.ts'
import { requireEffect, requireEffectByAction, requireEffectOwner, requireRun } from './records.ts'
import type { WorkflowEffectState } from './schema.ts'
import type { ProcessIdentity, RelayIdentity, WorkflowEffectRecord } from './types.ts'
import {
	optionalJson,
	processAuditKey,
	RUNNABLE_PHASES,
	TERMINAL_EFFECT_STATES,
	validateProcessIdentity,
	validateRelayIdentity
} from './values.ts'

export function markWorkflowEffectDispatched(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		launchNonce: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
		mayExecute?: boolean
		eventKey?: string
	}
): WorkflowEffectRecord {
	validateRelayIdentity(input.owner)
	if (input.externalProcess) validateProcessIdentity(input.externalProcess, 'external effect process')
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		if (!RUNNABLE_PHASES.includes(run.phase)) {
			throw new WorkflowTransitionError(`Workflow ${run.id} cannot dispatch a UI effect while ${run.phase}`)
		}
		return transitionEffect(context, {
			...input,
			from: ['prepared'],
			to: 'dispatched',
			mayExecute: input.mayExecute ?? false,
			eventKey: input.eventKey ?? `effect_dispatched:${input.actionId}:${input.attemptNumber}`,
			eventType: 'workflow_effect_dispatched'
		})
	})
}

export function markWorkflowEffectMayExecute(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		launchNonce: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
	}
): WorkflowEffectRecord {
	validateRelayIdentity(input.owner)
	if (input.externalProcess) validateProcessIdentity(input.externalProcess, 'external effect process')
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		if (!RUNNABLE_PHASES.includes(run.phase)) {
			throw new WorkflowTransitionError(`Workflow ${run.id} cannot release a UI gate while ${run.phase}`)
		}
		const effect = requireEffectByAction(context, input.runId, input.actionId)
		requireEffectOwner(effect, input.owner, input.attemptNumber)
		if (effect.state !== 'dispatched' || effect.launchNonce !== input.launchNonce) {
			throw new WorkflowTransitionError(`effect ${input.actionId} is not the matching dispatched attempt`)
		}
		const identityKey = input.externalProcess ? processAuditKey(input.externalProcess) : 'in-process'
		const eventKey = `effect_may_execute:${input.actionId}:${input.attemptNumber}:${identityKey}`
		const prior = findEvent(context, input.runId, eventKey)
		if (prior) {
			if (prior.type !== 'workflow_effect_may_execute') {
				throw new WorkflowTransitionError(`effect execution event ${eventKey} conflicts with existing audit`)
			}
			return effect
		}
		const at = context.now()
		const externalProcess = input.externalProcess ?? effect.externalProcess
		context.db
			.prepare(
				`UPDATE workflow_effects SET may_execute = 1, external_pid = ?, external_process_started_at = ?,
					external_process_group = ?, updated_at = ? WHERE id = ?`
			)
			.run(
				externalProcess?.pid ?? null,
				externalProcess?.processStartedAt ?? null,
				externalProcess?.processGroup ?? null,
				at,
				effect.id
			)
		context.db
			.prepare(
				`UPDATE workflow_effect_attempts SET may_execute = 1, external_pid = ?,
					external_process_started_at = ?, external_process_group = ?, updated_at = ?
				 WHERE effect_id = ? AND attempt_number = ?`
			)
			.run(
				externalProcess?.pid ?? null,
				externalProcess?.processStartedAt ?? null,
				externalProcess?.processGroup ?? null,
				at,
				effect.id,
				input.attemptNumber
			)
		touchRun(context, input.runId, at)
		appendEvent(context, input.runId, eventKey, 'workflow_effect_may_execute', {
			effectId: effect.id,
			actionId: input.actionId,
			attemptNumber: input.attemptNumber,
			...(input.externalProcess ? { externalProcess: input.externalProcess } : {})
		})
		return requireEffect(context, effect.id)
	})
}

export function markWorkflowEffectCommitted(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner?: RelayIdentity
		attemptNumber?: number
		receipt: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return transitionEffect(context, {
		...input,
		from: ['dispatched', 'ambiguous'],
		to: 'committed',
		eventKey: input.eventKey ?? `effect_committed:${input.actionId}`,
		eventType: 'workflow_effect_committed'
	})
}

export function markWorkflowEffectFailed(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return transitionEffect(context, {
		...input,
		from: ['prepared'],
		to: 'failed',
		eventKey: input.eventKey ?? `effect_failed:${input.actionId}:${input.attemptNumber}`,
		eventType: 'workflow_effect_failed'
	})
}

export function markWorkflowEffectFailedBeforeMayExecute(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		attemptNumber: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return transitionEffect(context, {
		...input,
		from: ['dispatched'],
		to: 'failed',
		requireMayExecute: false,
		mayExecute: false,
		eventKey: input.eventKey ?? `effect_failed_before_execute:${input.actionId}:${input.attemptNumber}`,
		eventType: 'workflow_effect_failed_before_may_execute'
	})
}

/** A finished configuration write with a known, mismatching readback is safe to retry. */
export function markWorkflowConfigurationRejected(
	context: PersistenceConnection,
	input: Parameters<typeof markWorkflowEffectFailed>[1]
): WorkflowEffectRecord {
	return context.immediate(() => {
		const effect = requireEffectByAction(context, input.runId, input.actionId)
		if (effect.kind !== 'configure_root' && effect.kind !== 'configure_child') {
			throw new WorkflowTransitionError('only a configuration effect can have a verified rejection')
		}
		return transitionEffect(context, {
			...input,
			from: ['dispatched'],
			to: 'failed',
			requireMayExecute: true,
			eventKey: input.eventKey ?? `configuration_rejected:${input.actionId}:${input.attemptNumber}`,
			eventType: 'workflow_configuration_rejected'
		})
	})
}

export function markWorkflowEffectAmbiguous(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner?: RelayIdentity
		attemptNumber?: number
		errorCode: string
		errorMessage: string
		evidence?: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return transitionEffect(context, {
		...input,
		from: ['dispatched'],
		to: 'ambiguous',
		eventKey: input.eventKey ?? `effect_ambiguous:${input.actionId}`,
		eventType: 'workflow_effect_ambiguous'
	})
}

export function markWorkflowEffectCancelled(
	context: PersistenceConnection,
	input: { runId: string; actionId: string; eventKey?: string }
): WorkflowEffectRecord {
	return transitionEffect(context, {
		...input,
		from: ['prepared', 'failed'],
		to: 'cancelled',
		eventKey: input.eventKey ?? `effect_cancelled:${input.actionId}`,
		eventType: 'workflow_effect_cancelled'
	})
}

export function transitionEffect(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		from: WorkflowEffectState[]
		to: WorkflowEffectState
		owner?: RelayIdentity
		attemptNumber?: number
		launchNonce?: string
		externalProcess?: ProcessIdentity & { processGroup?: number }
		mayExecute?: boolean
		requireMayExecute?: boolean
		receipt?: unknown
		errorCode?: string
		errorMessage?: string
		evidence?: unknown
		eventKey: string
		eventType: string
	}
): WorkflowEffectRecord {
	return context.immediate(() => {
		const effect = requireEffectByAction(context, input.runId, input.actionId)
		const run = requireRun(context, input.runId)
		if (!input.from.includes(effect.state)) {
			throw new WorkflowTransitionError(
				`effect ${input.actionId} is ${effect.state}, expected ${input.from.join(' or ')}`
			)
		}
		if (input.requireMayExecute !== undefined && effect.mayExecute !== input.requireMayExecute) {
			throw new WorkflowTransitionError(`effect ${input.actionId} mayExecute evidence changed`)
		}
		const attemptNumber = input.attemptNumber ?? (effect.attemptCount > 0 ? effect.attemptCount : undefined)
		if (input.owner && attemptNumber !== undefined) {
			requireEffectOwner(effect, input.owner, attemptNumber)
		}
		const at = context.now()
		const terminalAt = TERMINAL_EFFECT_STATES.includes(input.to) ? at : null
		const externalProcess = input.externalProcess ?? effect.externalProcess
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = ?, launch_nonce = ?, external_pid = ?,
					external_process_started_at = ?, external_process_group = ?, may_execute = ?, receipt_json = ?,
					error_code = ?, error_message = ?, updated_at = ?, terminal_at = ? WHERE id = ?`
			)
			.run(
				input.to,
				input.launchNonce ?? effect.launchNonce ?? null,
				externalProcess?.pid ?? null,
				externalProcess?.processStartedAt ?? null,
				externalProcess?.processGroup ?? null,
				input.mayExecute === undefined ? (effect.mayExecute ? 1 : 0) : input.mayExecute ? 1 : 0,
				input.receipt === undefined ? optionalJson(effect.receipt) : optionalJson(input.receipt),
				input.errorCode ?? effect.errorCode ?? null,
				input.errorMessage ?? effect.errorMessage ?? null,
				at,
				terminalAt,
				effect.id
			)
		if (attemptNumber !== undefined) {
			context.db
				.prepare(
					`UPDATE workflow_effect_attempts SET state = ?, launch_nonce = ?, external_pid = ?,
						external_process_started_at = ?, external_process_group = ?, may_execute = ?, receipt_json = ?,
						evidence_json = ?, error_code = ?, error_message = ?, updated_at = ?, terminal_at = ?
					 WHERE effect_id = ? AND attempt_number = ?`
				)
				.run(
					input.to,
					input.launchNonce ?? effect.launchNonce ?? null,
					externalProcess?.pid ?? null,
					externalProcess?.processStartedAt ?? null,
					externalProcess?.processGroup ?? null,
					input.mayExecute === undefined ? (effect.mayExecute ? 1 : 0) : input.mayExecute ? 1 : 0,
					input.receipt === undefined ? optionalJson(effect.receipt) : optionalJson(input.receipt),
					optionalJson(input.evidence),
					input.errorCode ?? null,
					input.errorMessage ?? null,
					at,
					terminalAt,
					effect.id,
					attemptNumber
				)
		}
		touchRun(context, input.runId, at)
		const late = input.to === 'committed' && isTerminalWorkflowPhase(run.phase)
		appendEvent(context, input.runId, input.eventKey, late ? 'late_effect' : input.eventType, {
			effectId: effect.id,
			actionId: input.actionId,
			attemptNumber,
			errorCode: input.errorCode,
			...(late ? { intendedEventType: input.eventType } : {})
		})
		return requireEffect(context, effect.id)
	})
}
