import { randomUUID } from 'node:crypto'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { isTerminalWorkflowJobState, isTerminalWorkflowPhase } from '../workflow/machine.ts'
import type { FrozenWorkflowRole } from '../workflow/prompts.ts'
import { decodeJob } from './codecs.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { appendEvent, touchRun } from './events.ts'
import { canonicalRequestJson } from './idempotency.ts'
import { checkRunGuard, requireJob, requireRun } from './records.ts'
import { type WorkflowJobRole, type WorkflowJobState, workflowJobs, workflowRuns } from './schema.ts'
import type { AbandonedJobRecovery, ProcessProbe, RelayIdentity, WorkflowJobRecord } from './types.ts'
import {
	asObject,
	json,
	optionalJson,
	ownerAuditKey,
	probeAlive,
	RUNNABLE_PHASES,
	sameOwner,
	validateRelayIdentity
} from './values.ts'

export function insertJob(
	context: PersistenceConnection,
	input: {
		id: string
		runId: string
		logicalKey: string
		role: WorkflowJobRole
		cycle: number
		revision: number
		resolvedRole: FrozenWorkflowRole
		prompt: string
		state: WorkflowJobState
		cancellationGeneration: number
		transcriptCursor?: unknown
		at: number
	}
): void {
	context.db
		.prepare(
			`INSERT INTO workflow_jobs (
				id, run_id, logical_key, role, cycle, revision, resolved_role_json, prompt, state, cancellation_generation,
				transcript_cursor_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.id,
			input.runId,
			input.logicalKey,
			input.role,
			input.cycle,
			input.revision,
			json(input.resolvedRole),
			input.prompt,
			input.state,
			input.cancellationGeneration,
			optionalJson(input.transcriptCursor),
			input.at,
			input.at
		)
}

export function createWorkflowJob(
	context: PersistenceConnection,
	input: {
		id?: string
		runId: string
		logicalKey: string
		role: WorkflowJobRole
		cycle?: number
		revision?: number
		resolvedRole: FrozenWorkflowRole
		prompt: string
		state?: 'dormant' | 'queued'
		transcriptCursor?: unknown
		expectedCancellationGeneration: number
		eventKey: string
	}
): { created: boolean; job: WorkflowJobRecord } {
	return context.immediate(() => {
		const run = requireRun(context, input.runId)
		checkRunGuard(run, RUNNABLE_PHASES, input.expectedCancellationGeneration)
		const existing = context.orm
			.select()
			.from(workflowJobs)
			.where(and(eq(workflowJobs.runId, input.runId), eq(workflowJobs.logicalKey, input.logicalKey)))
			.get()
		if (existing) {
			const decoded = decodeJob(existing)
			if (
				decoded.role !== input.role ||
				decoded.cycle !== (input.cycle ?? run.cycle) ||
				decoded.revision !== (input.revision ?? run.revision) ||
				canonicalRequestJson(decoded.resolvedRole) !== canonicalRequestJson(input.resolvedRole) ||
				decoded.prompt !== input.prompt
			) {
				throw new WorkflowTransitionError(`logical job ${input.logicalKey} already has different frozen inputs`)
			}
			return { created: false, job: decoded }
		}
		const id = input.id ?? randomUUID()
		const at = context.now()
		insertJob(context, {
			...input,
			id,
			cycle: input.cycle ?? run.cycle,
			revision: input.revision ?? run.revision,
			state: input.state ?? 'queued',
			cancellationGeneration: run.cancellationGeneration,
			at
		})
		touchRun(context, input.runId, at)
		appendEvent(context, input.runId, input.eventKey, 'workflow_job_created', {
			jobId: id,
			logicalKey: input.logicalKey,
			role: input.role,
			cycle: input.cycle ?? run.cycle,
			revision: input.revision ?? run.revision,
			state: input.state ?? 'queued'
		})
		return { created: true, job: requireJob(context, id) }
	})
}

export function activateWorkflowJob(
	context: PersistenceConnection,
	jobId: string,
	expectedCancellationGeneration: number,
	eventKey: string,
	transcriptCursor?: unknown
): WorkflowJobRecord {
	return updateWorkflowJob(context, {
		jobId,
		expectedStates: ['dormant'],
		expectedCancellationGeneration,
		state: 'queued',
		...(transcriptCursor === undefined ? {} : { transcriptCursor }),
		eventKey,
		eventType: 'workflow_job_activated'
	})
}

export function claimNextWorkflowJob(
	context: PersistenceConnection,
	owner: RelayIdentity,
	runId?: string
): WorkflowJobRecord | undefined {
	validateRelayIdentity(owner)
	return context.immediate(() => {
		const row = context.orm
			.select({ job: workflowJobs })
			.from(workflowJobs)
			.innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
			.where(
				and(
					eq(workflowJobs.state, 'queued'),
					eq(workflowJobs.cancellationGeneration, workflowRuns.cancellationGeneration),
					notInArray(workflowRuns.phase, ['blocked', 'completed', 'cancelled']),
					runId === undefined ? undefined : eq(workflowJobs.runId, runId)
				)
			)
			.orderBy(asc(workflowJobs.createdAt), asc(workflowJobs.id))
			.limit(1)
			.get()?.job
		if (!row) return undefined
		const at = context.now()
		const result = context.db
			.prepare(
				`UPDATE workflow_jobs SET state = 'owned', owner_instance_id = ?, owner_pid = ?,
					owner_process_started_at = ?, owner_protocol_version = ?, updated_at = ?
				 WHERE id = ? AND state = 'queued'`
			)
			.run(owner.instanceId, owner.pid, owner.processStartedAt, owner.protocolVersion, at, row.id)
		if (Number(result.changes) !== 1) return undefined
		touchRun(context, row.runId, at)
		appendEvent(
			context,
			row.runId,
			`job_claimed:${row.id}:${row.attemptCount + 1}:${ownerAuditKey(owner)}`,
			'workflow_job_claimed',
			{
				jobId: row.id,
				ownerInstanceId: owner.instanceId
			}
		)
		return requireJob(context, row.id)
	})
}

/** Requeue only the pre-effect `owned` state after exact process death is proven. */
export function reconcileAbandonedWorkflowJobClaim(
	context: PersistenceConnection,
	input: {
		jobId: string
		eventKey: string
		processProbe?: ProcessProbe
	}
): AbandonedJobRecovery {
	const observed = requireJob(context, input.jobId)
	if (!observed.owner || observed.state !== 'owned') return { status: 'unsafe', job: observed }
	const observedOwner = observed.owner
	const probe = input.processProbe ?? context.processProbe
	if (probeAlive(observedOwner, probe)) return { status: 'owner_alive', job: observed }
	return context.immediate(() => {
		const current = requireJob(context, input.jobId)
		if (
			current.state !== 'owned' ||
			!current.owner ||
			!sameOwner(current.owner, observedOwner) ||
			current.attemptCount !== observed.attemptCount
		) {
			return { status: 'changed', job: current }
		}
		const at = context.now()
		context.db
			.prepare(
				`UPDATE workflow_jobs SET state = 'queued', owner_instance_id = NULL, owner_pid = NULL,
					owner_process_started_at = NULL, owner_protocol_version = NULL, updated_at = ? WHERE id = ?`
			)
			.run(at, current.id)
		touchRun(context, current.runId, at)
		appendEvent(
			context,
			current.runId,
			`${input.eventKey}:${ownerAuditKey(observedOwner)}`,
			'workflow_job_claim_recovered',
			{
				jobId: current.id,
				abandonedInstanceId: observedOwner.instanceId
			}
		)
		return { status: 'requeued', job: requireJob(context, current.id) }
	})
}

export function updateWorkflowJob(
	context: PersistenceConnection,
	input: {
		jobId: string
		expectedStates: WorkflowJobState[]
		expectedCancellationGeneration: number
		state: WorkflowJobState
		transcriptCursor?: unknown
		childSessionId?: string | null
		outcome?: unknown
		taskReceipt?: unknown
		batonReceipt?: unknown
		clearOwner?: boolean
		eventKey: string
		eventType: string
		eventData?: unknown
	}
): WorkflowJobRecord {
	return context.immediate(() => {
		const job = requireJob(context, input.jobId)
		const run = requireRun(context, job.runId)
		if (isTerminalWorkflowPhase(run.phase) || job.state === 'cancelled') {
			throw new WorkflowTransitionError(`cannot advance terminal job ${job.id}`)
		}
		checkRunGuard(run, undefined, input.expectedCancellationGeneration)
		if (!input.expectedStates.includes(job.state)) {
			throw new WorkflowTransitionError(`job ${job.id} is ${job.state}, expected ${input.expectedStates.join(' or ')}`)
		}
		const at = context.now()
		const terminalAt = isTerminalWorkflowJobState(input.state) ? (job.terminalAt ?? at) : null
		const result = context.db
			.prepare(
				`UPDATE workflow_jobs SET state = ?, transcript_cursor_json = ?, child_session_id = ?, outcome_json = ?, task_receipt_json = ?,
					baton_receipt_json = ?, owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?,
					owner_protocol_version = ?, updated_at = ?, terminal_at = ?
				 WHERE id = ? AND state = ? AND cancellation_generation = ?`
			)
			.run(
				input.state,
				input.transcriptCursor === undefined
					? optionalJson(job.transcriptCursor)
					: optionalJson(input.transcriptCursor),
				input.childSessionId === undefined ? (job.childSessionId ?? null) : input.childSessionId,
				input.outcome === undefined ? optionalJson(job.outcome) : optionalJson(input.outcome),
				input.taskReceipt === undefined ? optionalJson(job.taskReceipt) : optionalJson(input.taskReceipt),
				input.batonReceipt === undefined ? optionalJson(job.batonReceipt) : optionalJson(input.batonReceipt),
				input.clearOwner ? null : (job.owner?.instanceId ?? null),
				input.clearOwner ? null : (job.owner?.pid ?? null),
				input.clearOwner ? null : (job.owner?.processStartedAt ?? null),
				input.clearOwner ? null : (job.owner?.protocolVersion ?? null),
				at,
				terminalAt,
				job.id,
				job.state,
				input.expectedCancellationGeneration
			)
		if (Number(result.changes) !== 1) throw new WorkflowTransitionError(`job ${job.id} changed concurrently`)
		touchRun(context, job.runId, at)
		appendEvent(context, job.runId, input.eventKey, input.eventType, { jobId: job.id, ...asObject(input.eventData) })
		return requireJob(context, job.id)
	})
}
