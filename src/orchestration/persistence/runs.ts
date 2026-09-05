import { randomUUID } from 'node:crypto'
import type { WorkflowPhase } from '../../wire.ts'
import { isTerminalWorkflowPhase } from '../workflow/machine.ts'
import type { FrozenWorkflowRoles } from '../workflow/prompts.ts'
import type { PersistenceConnection } from './connection.ts'
import { insertEffect } from './effects.ts'
import { OrchestrationError, WorkflowTransitionError } from './errors.ts'
import { appendEvent } from './events.ts'
import { idempotentMutation } from './idempotency.ts'
import { insertJob } from './jobs.ts'
import { checkRunGuard, getWorkflowRun, requireRun } from './records.ts'
import type { WorkflowTarget } from './schema.ts'
import type { WorkflowBlockedState, WorkflowRunRecord } from './types.ts'
import { isConstraintError, json, nonEmpty, optionalJson } from './values.ts'

export function createWorkflowRun(
	context: PersistenceConnection,
	input: {
		id?: string
		clientId: string
		objective: string
		target: WorkflowTarget
		roles: FrozenWorkflowRoles
		workspaceId?: string
		rootSessionId?: string
		pristineEvidence?: unknown
		deliveryBaseline?: unknown
		bootstrapPrompt?: string
		initialEffects?: Array<{
			id?: string
			actionId: string
			kind: string
			target?: unknown
			inputs?: unknown
			baseline?: unknown
			cursor?: unknown
		}>
		/** Compatibility shorthand for callers preparing exactly one initial effect. */
		initialEffect?: {
			id?: string
			actionId: string
			kind: string
			target?: unknown
			inputs?: unknown
			baseline?: unknown
			cursor?: unknown
		}
	}
): { replayed: boolean; run: WorkflowRunRecord } {
	const initialEffects = input.initialEffects ?? (input.initialEffect ? [input.initialEffect] : [])
	if (new Set(initialEffects.map(effect => effect.actionId)).size !== initialEffects.length) {
		throw new OrchestrationError('initial Workflow effects must have unique action IDs')
	}
	// Idempotency belongs to the normalized UI request, not to derived preflight
	// evidence. Re-reading roles or the now-non-pristine root on a transport retry
	// must not turn the same tap into a conflict.
	const request = { objective: input.objective, target: input.target }
	let createdRunId: string | undefined
	const answer = idempotentMutation(
		context,
		'start_workflow',
		input.clientId,
		request,
		() => {
			const runId = input.id ?? randomUUID()
			createdRunId = runId
			const at = context.now()
			const phase: WorkflowPhase = input.target.kind === 'new_workspace' ? 'creating_workspace' : 'pending_root'
			if (input.target.kind === 'existing_session') {
				if (input.workspaceId && input.workspaceId !== input.target.workspaceId) {
					throw new OrchestrationError('workspace binding conflicts with the existing-session target')
				}
				if (input.rootSessionId && input.rootSessionId !== input.target.sessionId) {
					throw new OrchestrationError('root binding conflicts with the existing-session target')
				}
			}
			try {
				context.db
					.prepare(
						`INSERT INTO workflow_runs (
							id, objective, target_json, roles_json, phase, workspace_id, root_session_id,
							pristine_evidence_json, delivery_baseline_json, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						runId,
						nonEmpty(input.objective, 'objective'),
						json(input.target),
						json(input.roles),
						phase,
						input.target.kind === 'existing_session' ? input.target.workspaceId : (input.workspaceId ?? null),
						input.target.kind === 'existing_session' ? input.target.sessionId : (input.rootSessionId ?? null),
						optionalJson(input.pristineEvidence),
						optionalJson(input.deliveryBaseline),
						at,
						at
					)
			} catch (error) {
				if (isConstraintError(error)) {
					throw new WorkflowTransitionError('the root already belongs to an active Workflow')
				}
				throw error
			}

			insertJob(context, {
				id: `${runId}:explore:0`,
				runId,
				logicalKey: 'explore:0',
				role: 'exploration',
				cycle: 0,
				revision: 0,
				resolvedRole: input.roles.exploration,
				prompt: input.bootstrapPrompt ?? input.objective,
				state: 'dormant',
				cancellationGeneration: 0,
				at
			})
			for (const effect of initialEffects) {
				insertEffect(context, {
					...effect,
					id: effect.id ?? `${runId}:${effect.actionId}`,
					runId,
					at
				})
			}
			appendEvent(context, runId, 'workflow_started', 'workflow_started', {
				target: input.target,
				bootstrapJob: 'explore:0',
				initialActionIds: initialEffects.map(effect => effect.actionId)
			})
			return { runId }
		},
		{ runId: input.id, actionId: initialEffects[0]?.actionId }
	)
	const runId = answer.result.runId ?? createdRunId
	if (!runId) throw new OrchestrationError('idempotent Workflow result did not contain a run ID')
	const run = getWorkflowRun(context, runId)
	if (!run) throw new OrchestrationError(`Workflow ${runId} disappeared after creation`)
	return { replayed: answer.replayed, run }
}

export function transitionWorkflowRun(
	context: PersistenceConnection,
	input: {
		runId: string
		expectedPhase?: WorkflowPhase | WorkflowPhase[]
		expectedCancellationGeneration: number
		phase?: WorkflowPhase
		cycle?: number
		revision?: number
		workspaceId?: string | null
		rootSessionId?: string | null
		pristineEvidence?: unknown
		deliveryBaseline?: unknown
		planningInterpretation?: string | null
		implementationBatonsDelivered?: number
		blocked?: WorkflowBlockedState | null
		eventKey: string
		eventType: string
		eventData?: unknown
	}
): WorkflowRunRecord {
	return context.immediate(() => {
		const current = requireRun(context, input.runId)
		if (isTerminalWorkflowPhase(current.phase)) {
			throw new WorkflowTransitionError(`terminal Workflow ${current.id} cannot transition from ${current.phase}`)
		}
		checkRunGuard(current, input.expectedPhase, input.expectedCancellationGeneration)
		const phase = input.phase ?? current.phase
		const terminalAt = isTerminalWorkflowPhase(phase) ? (current.terminalAt ?? context.now()) : undefined
		const blocked = input.blocked === undefined ? current.blocked : (input.blocked ?? undefined)
		const at = context.now()
		try {
			context.db
				.prepare(
					`UPDATE workflow_runs SET
						phase = ?, cycle = ?, revision = ?, workspace_id = ?, root_session_id = ?,
						pristine_evidence_json = ?, delivery_baseline_json = ?, planning_interpretation = ?,
						blocked_action_id = ?, blocked_error_code = ?, blocked_message = ?, resume_phase = ?,
						retry_class = ?, blocked_candidates_json = ?, blocked_at = ?,
						implementation_batons_delivered = ?, updated_at = ?, terminal_at = ?
					 WHERE id = ? AND cancellation_generation = ?`
				)
				.run(
					phase,
					input.cycle ?? current.cycle,
					input.revision ?? current.revision,
					input.workspaceId === undefined ? (current.workspaceId ?? null) : input.workspaceId,
					input.rootSessionId === undefined ? (current.rootSessionId ?? null) : input.rootSessionId,
					input.pristineEvidence === undefined
						? optionalJson(current.pristineEvidence)
						: optionalJson(input.pristineEvidence),
					input.deliveryBaseline === undefined
						? optionalJson(current.deliveryBaseline)
						: optionalJson(input.deliveryBaseline),
					input.planningInterpretation === undefined
						? (current.planningInterpretation ?? null)
						: input.planningInterpretation,
					blocked?.actionId ?? null,
					blocked?.errorCode ?? null,
					blocked?.message ?? null,
					blocked?.resumePhase ?? null,
					blocked?.retryClass ?? null,
					optionalJson(blocked?.candidates),
					blocked ? (blocked.blockedAt ?? at) : null,
					input.implementationBatonsDelivered ?? current.implementationBatonsDelivered,
					at,
					terminalAt ?? null,
					input.runId,
					input.expectedCancellationGeneration
				)
		} catch (error) {
			if (isConstraintError(error)) {
				throw new WorkflowTransitionError('the requested root is already bound to another active Workflow')
			}
			throw error
		}
		appendEvent(context, input.runId, input.eventKey, input.eventType, input.eventData)
		return requireRun(context, input.runId)
	})
}

export function cancelWorkflowRun(
	context: PersistenceConnection,
	runId: string,
	eventKey: string,
	eventData?: unknown
): WorkflowRunRecord {
	return context.immediate(() => {
		const run = requireRun(context, runId)
		if (run.phase === 'cancelled') return run
		if (run.phase === 'completed') throw new WorkflowTransitionError('a completed Workflow cannot be cancelled')
		const at = context.now()
		const generation = run.cancellationGeneration + 1
		context.db
			.prepare(
				`UPDATE workflow_runs SET phase = 'cancelled', cancellation_generation = ?, updated_at = ?, terminal_at = ?,
					blocked_action_id = NULL, blocked_error_code = NULL, blocked_message = NULL, resume_phase = NULL,
					retry_class = NULL, blocked_candidates_json = NULL, blocked_at = NULL
				 WHERE id = ? AND cancellation_generation = ?`
			)
			.run(generation, at, at, runId, run.cancellationGeneration)
		context.db
			.prepare(
				`UPDATE workflow_jobs SET state = 'cancelled', cancellation_generation = ?, updated_at = ?, terminal_at = ?
				 WHERE run_id = ? AND state NOT IN ('returned', 'failed', 'cancelled')`
			)
			.run(generation, at, at, runId)
		context.db
			.prepare(
				`UPDATE workflow_job_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
				 WHERE job_id IN (SELECT id FROM workflow_jobs WHERE run_id = ?)
					AND state NOT IN ('returned', 'failed', 'cancelled')`
			)
			.run(at, at, runId)
		context.db
			.prepare(
				`UPDATE workflow_effects SET state = 'cancelled', updated_at = ?, terminal_at = ?
				 WHERE run_id = ? AND state IN ('prepared', 'failed')`
			)
			.run(at, at, runId)
		context.db
			.prepare(
				`UPDATE workflow_effect_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
				 WHERE effect_id IN (SELECT id FROM workflow_effects WHERE run_id = ?) AND state = 'prepared'`
			)
			.run(at, at, runId)
		appendEvent(context, runId, eventKey, 'workflow_cancelled', eventData)
		return requireRun(context, runId)
	})
}
