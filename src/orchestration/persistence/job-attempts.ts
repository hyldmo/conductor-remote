import { isTerminalWorkflowJobState } from '../workflow/machine.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { appendEvent, findEvent, touchRun } from './events.ts'
import { canonicalOptional } from './idempotency.ts'
import { requireJob, requireJobAttempt, requireRun } from './records.ts'
import type { WorkflowJobState } from './schema.ts'
import type { RelayIdentity, WorkflowJobAttemptRecord, WorkflowJobRecord } from './types.ts'
import { json, optionalJson, sameOwner, validateRelayIdentity } from './values.ts'

export function createWorkflowJobAttempt(
	context: PersistenceConnection,
	input: {
		jobId: string
		owner: RelayIdentity
		state?: WorkflowJobState
		childSessionId?: string
		effectIds?: { open?: string; configure?: string; task?: string; baton?: string }
	}
): WorkflowJobAttemptRecord {
	validateRelayIdentity(input.owner)
	return context.immediate(() => {
		const job = requireJob(context, input.jobId)
		const run = requireRun(context, job.runId)
		if (
			run.phase === 'completed' ||
			run.phase === 'cancelled' ||
			job.cancellationGeneration !== run.cancellationGeneration
		) {
			throw new WorkflowTransitionError(`cannot create an attempt for inactive job ${job.id}`)
		}
		if (job.state === 'cancelled' || job.state === 'returned') {
			throw new WorkflowTransitionError(`cannot attempt ${job.state} job ${job.id}`)
		}
		if (job.state !== 'owned' || !job.owner || !sameOwner(job.owner, input.owner)) {
			throw new WorkflowTransitionError(`job ${job.id} is not claimed by this relay`)
		}
		const attemptNumber = job.attemptCount + 1
		const id = `${job.id}:attempt:${attemptNumber}`
		const at = context.now()
		context.db
			.prepare(
				`INSERT INTO workflow_job_attempts (
					id, job_id, attempt_number, state, child_session_id, open_effect_id, configure_effect_id,
					task_effect_id, baton_effect_id, owner_instance_id, owner_pid, owner_process_started_at,
					owner_protocol_version, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				job.id,
				attemptNumber,
				input.state ?? job.state,
				input.childSessionId ?? null,
				input.effectIds?.open ?? null,
				input.effectIds?.configure ?? null,
				input.effectIds?.task ?? null,
				input.effectIds?.baton ?? null,
				input.owner.instanceId,
				input.owner.pid,
				input.owner.processStartedAt,
				input.owner.protocolVersion,
				at,
				at
			)
		context.db
			.prepare('UPDATE workflow_jobs SET attempt_count = ?, updated_at = ? WHERE id = ?')
			.run(attemptNumber, at, job.id)
		touchRun(context, job.runId, at)
		appendEvent(context, job.runId, `job_attempt:${job.id}:${attemptNumber}`, 'workflow_job_attempt_created', {
			jobId: job.id,
			attemptNumber
		})
		return requireJobAttempt(context, id)
	})
}

export function updateWorkflowJobAttempt(
	context: PersistenceConnection,
	input: {
		jobId: string
		attemptNumber: number
		expectedState: WorkflowJobState
		state: WorkflowJobState
		childSessionId?: string | null
		outcome?: unknown
		failureEvidence?: unknown
		eventKey: string
		eventType: string
	}
): WorkflowJobAttemptRecord {
	return context.immediate(() => {
		const job = requireJob(context, input.jobId)
		const run = requireRun(context, job.runId)
		if (
			run.phase === 'completed' ||
			run.phase === 'cancelled' ||
			job.state === 'cancelled' ||
			job.cancellationGeneration !== run.cancellationGeneration
		) {
			throw new WorkflowTransitionError(`cannot advance an attempt for inactive job ${job.id}`)
		}
		const id = `${job.id}:attempt:${input.attemptNumber}`
		const attempt = requireJobAttempt(context, id)
		if (attempt.state !== input.expectedState) {
			throw new WorkflowTransitionError(
				`job attempt ${input.attemptNumber} is ${attempt.state}, expected ${input.expectedState}`
			)
		}
		const at = context.now()
		const terminalAt = isTerminalWorkflowJobState(input.state) ? at : null
		const result = context.db
			.prepare(
				`UPDATE workflow_job_attempts SET state = ?, child_session_id = ?, outcome_json = ?,
					failure_evidence_json = ?, updated_at = ?, terminal_at = ?
				 WHERE id = ? AND state = ?`
			)
			.run(
				input.state,
				input.childSessionId === undefined ? (attempt.childSessionId ?? null) : input.childSessionId,
				input.outcome === undefined ? optionalJson(attempt.outcome) : optionalJson(input.outcome),
				input.failureEvidence === undefined
					? optionalJson(attempt.failureEvidence)
					: optionalJson(input.failureEvidence),
				at,
				terminalAt,
				id,
				input.expectedState
			)
		if (Number(result.changes) !== 1) throw new WorkflowTransitionError(`job attempt ${id} changed concurrently`)
		touchRun(context, job.runId, at)
		appendEvent(context, job.runId, input.eventKey, input.eventType, {
			jobId: job.id,
			attemptNumber: input.attemptNumber,
			state: input.state
		})
		return requireJobAttempt(context, id)
	})
}

/** Preserve an outcome observed after cancellation without reopening the job. */
export function recordLateWorkflowChildResult(
	context: PersistenceConnection,
	input: {
		runId: string
		jobId: string
		attemptNumber?: number
		outcome: unknown
		eventKey: string
	}
): WorkflowJobRecord {
	return context.immediate(() => {
		const job = requireJob(context, input.jobId)
		const run = requireRun(context, input.runId)
		if (job.runId !== run.id) throw new WorkflowTransitionError(`job ${job.id} does not belong to Workflow ${run.id}`)
		if (run.phase !== 'cancelled' || job.state !== 'cancelled') {
			throw new WorkflowTransitionError(`job ${job.id} is not a cancelled late-result target`)
		}
		const attemptNumber = input.attemptNumber ?? job.attemptCount
		const attempt = attemptNumber > 0 ? requireJobAttempt(context, `${job.id}:attempt:${attemptNumber}`) : undefined
		const prior = findEvent(context, run.id, input.eventKey)
		if (prior) {
			if (prior.type !== 'late_child_result' || canonicalOptional(job.outcome) !== canonicalOptional(input.outcome)) {
				throw new WorkflowTransitionError(`late child event ${input.eventKey} conflicts with existing evidence`)
			}
			return job
		}
		const at = context.now()
		context.db
			.prepare('UPDATE workflow_jobs SET outcome_json = ?, updated_at = ? WHERE id = ?')
			.run(json(input.outcome), at, job.id)
		if (attempt) {
			context.db
				.prepare('UPDATE workflow_job_attempts SET outcome_json = ?, updated_at = ? WHERE id = ?')
				.run(json(input.outcome), at, attempt.id)
		}
		appendEvent(context, run.id, input.eventKey, 'late_child_result', {
			jobId: job.id,
			attemptNumber,
			outcome: input.outcome
		})
		return requireJob(context, job.id)
	})
}
