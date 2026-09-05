import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { decodeEffect } from './codecs.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { appendEvent, touchRun } from './events.ts'
import { canonicalOptional } from './idempotency.ts'
import {
	checkRunGuard,
	getWorkflowEffect,
	requireEffect,
	requireEffectAttempt,
	requireEffectByAction,
	requireRun
} from './records.ts'
import { workflowEffects } from './schema.ts'
import type { RelayIdentity, WorkflowEffectAttemptRecord, WorkflowEffectRecord } from './types.ts'
import { ACTIVE_PHASES, json, nonEmpty, optionalJson, RUNNABLE_PHASES, validateRelayIdentity } from './values.ts'

export function insertEffect(
	context: PersistenceConnection,
	input: {
		id: string
		runId: string
		actionId: string
		kind: string
		jobId?: string
		target?: unknown
		inputs?: unknown
		baseline?: unknown
		cursor?: unknown
		at: number
	}
): void {
	context.db
		.prepare(
			`INSERT INTO workflow_effects (
				id, run_id, action_id, job_id, kind, state, target_json, inputs_json, baseline_json,
				cursor_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.id,
			input.runId,
			input.actionId,
			input.jobId ?? null,
			nonEmpty(input.kind, 'effect kind'),
			optionalJson(input.target),
			optionalJson(input.inputs),
			optionalJson(input.baseline),
			optionalJson(input.cursor),
			input.at,
			input.at
		)
}

export function prepareWorkflowEffect(
	context: PersistenceConnection,
	input: {
		id?: string
		runId: string
		actionId: string
		kind: string
		jobId?: string
		target?: unknown
		inputs?: unknown
		baseline?: unknown
		cursor?: unknown
		expectedCancellationGeneration: number
		eventKey: string
	}
): { created: boolean; effect: WorkflowEffectRecord } {
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		checkRunGuard(run, ACTIVE_PHASES, input.expectedCancellationGeneration)
		const existing = context.orm
			.select()
			.from(workflowEffects)
			.where(and(eq(workflowEffects.runId, input.runId), eq(workflowEffects.actionId, input.actionId)))
			.get()
		if (existing) {
			const effect = decodeEffect(existing)
			const same =
				effect.kind === input.kind &&
				effect.jobId === input.jobId &&
				canonicalOptional(effect.target) === canonicalOptional(input.target) &&
				canonicalOptional(effect.inputs) === canonicalOptional(input.inputs) &&
				canonicalOptional(effect.baseline) === canonicalOptional(input.baseline) &&
				canonicalOptional(effect.cursor) === canonicalOptional(input.cursor)
			if (!same) throw new WorkflowTransitionError(`action ${input.actionId} already has different frozen inputs`)
			return { created: false, effect }
		}
		const id = input.id ?? randomUUID()
		const at = context.now()
		insertEffect(context, { ...input, id, at })
		touchRun(context, input.runId, at)
		appendEvent(context, input.runId, input.eventKey, 'workflow_effect_prepared', {
			effectId: id,
			actionId: input.actionId,
			kind: input.kind,
			jobId: input.jobId
		})
		return { created: true, effect: requireEffect(context, id) }
	})
}

/** Commit a positively reconciled settings match without entering the UI dispatch boundary. */
export function markWorkflowEffectSatisfiedWithoutDispatch(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		expectedCancellationGeneration: number
		receipt: unknown
		eventKey?: string
	}
): WorkflowEffectRecord {
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
		const effect = requireEffectByAction(context, input.runId, input.actionId)
		if (effect.kind !== 'configure_root' && effect.kind !== 'configure_child') {
			throw new WorkflowTransitionError(`effect ${input.actionId} is not a configuration effect`)
		}
		if (effect.state !== 'prepared' || effect.owner || effect.mayExecute) {
			throw new WorkflowTransitionError(`effect ${input.actionId} is not an unowned prepared configuration`)
		}
		const at = context.now()
		const result = context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'committed', receipt_json = ?, updated_at = ?, terminal_at = ?
				 WHERE id = ? AND state = 'prepared' AND owner_instance_id IS NULL AND may_execute = 0`
			)
			.run(json(input.receipt), at, at, effect.id)
		if (Number(result.changes) !== 1) {
			throw new WorkflowTransitionError(`configuration effect ${input.actionId} changed concurrently`)
		}
		touchRun(context, input.runId, at)
		appendEvent(
			context,
			input.runId,
			input.eventKey ?? `effect_satisfied_without_dispatch:${input.actionId}`,
			'workflow_effect_satisfied_without_dispatch',
			{ effectId: effect.id, actionId: effect.actionId, receipt: input.receipt }
		)
		return requireEffect(context, effect.id)
	})
}

export function claimPreparedWorkflowEffect(
	context: PersistenceConnection,
	input: {
		runId: string
		actionId: string
		owner: RelayIdentity
		expectedCancellationGeneration: number
	}
): { effect: WorkflowEffectRecord; attempt: WorkflowEffectAttemptRecord } | undefined {
	validateRelayIdentity(input.owner)
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
		const effect = getWorkflowEffect(context, input.runId, input.actionId)
		if (effect?.state !== 'prepared' || effect.owner) return undefined
		const attemptNumber = effect.attemptCount + 1
		const attemptId = `${effect.id}:attempt:${attemptNumber}`
		const at = context.now()
		const result = context.db
			.prepare(
				`UPDATE workflow_effects SET owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?,
					owner_protocol_version = ?, attempt_count = ?, updated_at = ?
				 WHERE id = ? AND state = 'prepared' AND owner_instance_id IS NULL`
			)
			.run(
				input.owner.instanceId,
				input.owner.pid,
				input.owner.processStartedAt,
				input.owner.protocolVersion,
				attemptNumber,
				at,
				effect.id
			)
		if (Number(result.changes) !== 1) return undefined
		context.db
			.prepare(
				`INSERT INTO workflow_effect_attempts (
					id, effect_id, attempt_number, state, owner_instance_id, owner_pid,
					owner_process_started_at, owner_protocol_version, created_at, updated_at
				) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`
			)
			.run(
				attemptId,
				effect.id,
				attemptNumber,
				input.owner.instanceId,
				input.owner.pid,
				input.owner.processStartedAt,
				input.owner.protocolVersion,
				at,
				at
			)
		touchRun(context, input.runId, at)
		appendEvent(context, input.runId, `effect_claimed:${input.actionId}:${attemptNumber}`, 'workflow_effect_claimed', {
			effectId: effect.id,
			actionId: input.actionId,
			attemptNumber
		})
		return { effect: requireEffect(context, effect.id), attempt: requireEffectAttempt(context, attemptId) }
	})
}
