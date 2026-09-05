import { and, asc, eq, notInArray } from 'drizzle-orm'
import type { WorkflowPhase } from '../../wire.ts'
import { decodeEffect, decodeEffectAttempt, decodeJob, decodeJobAttempt, decodeRun } from './codecs.ts'
import type { PersistenceConnection } from './connection.ts'
import { WorkflowTransitionError } from './errors.ts'
import { workflowEffectAttempts, workflowEffects, workflowJobAttempts, workflowJobs, workflowRuns } from './schema.ts'
import type {
	RelayIdentity,
	WorkflowEffectAttemptRecord,
	WorkflowEffectRecord,
	WorkflowJobAttemptRecord,
	WorkflowJobRecord,
	WorkflowRunRecord
} from './types.ts'
import { sameOwner } from './values.ts'

export function getWorkflowRun(context: PersistenceConnection, id: string): WorkflowRunRecord | undefined {
	const row = context.orm.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get()
	return row ? decodeRun(row) : undefined
}

export function findActiveWorkflowByRoot(
	context: PersistenceConnection,
	rootSessionId: string
): WorkflowRunRecord | undefined {
	const row = context.orm
		.select()
		.from(workflowRuns)
		.where(
			and(eq(workflowRuns.rootSessionId, rootSessionId), notInArray(workflowRuns.phase, ['completed', 'cancelled']))
		)
		.get()
	return row ? decodeRun(row) : undefined
}

export function requireRun(context: PersistenceConnection, id: string): WorkflowRunRecord {
	const run = getWorkflowRun(context, id)
	if (!run) throw new WorkflowTransitionError(`Workflow ${id} does not exist`)
	return run
}

export function checkRunGuard(
	run: WorkflowRunRecord,
	expectedPhase: WorkflowPhase | WorkflowPhase[] | undefined,
	expectedCancellationGeneration: number
): void {
	const phases = Array.isArray(expectedPhase) ? expectedPhase : expectedPhase ? [expectedPhase] : undefined
	if (phases && !phases.includes(run.phase)) {
		throw new WorkflowTransitionError(`Workflow ${run.id} is ${run.phase}, expected ${phases.join(' or ')}`)
	}
	if (run.cancellationGeneration !== expectedCancellationGeneration) {
		throw new WorkflowTransitionError(`Workflow ${run.id} cancellation generation changed`)
	}
}

export function getWorkflowJob(context: PersistenceConnection, id: string): WorkflowJobRecord | undefined {
	const row = context.orm.select().from(workflowJobs).where(eq(workflowJobs.id, id)).get()
	return row ? decodeJob(row) : undefined
}

export function listWorkflowJobs(context: PersistenceConnection, runId: string): WorkflowJobRecord[] {
	return context.orm
		.select()
		.from(workflowJobs)
		.where(eq(workflowJobs.runId, runId))
		.orderBy(asc(workflowJobs.createdAt), asc(workflowJobs.id))
		.all()
		.map(row => decodeJob(row))
}

export function listWorkflowJobAttempts(context: PersistenceConnection, jobId: string): WorkflowJobAttemptRecord[] {
	return context.orm
		.select()
		.from(workflowJobAttempts)
		.where(eq(workflowJobAttempts.jobId, jobId))
		.orderBy(asc(workflowJobAttempts.attemptNumber))
		.all()
		.map(row => decodeJobAttempt(row))
}

export function requireJob(context: PersistenceConnection, id: string): WorkflowJobRecord {
	const job = getWorkflowJob(context, id)
	if (!job) throw new WorkflowTransitionError(`Workflow job ${id} does not exist`)
	return job
}

export function requireJobAttempt(context: PersistenceConnection, id: string): WorkflowJobAttemptRecord {
	const row = context.orm.select().from(workflowJobAttempts).where(eq(workflowJobAttempts.id, id)).get()
	if (!row) throw new WorkflowTransitionError(`Workflow job attempt ${id} does not exist`)
	return decodeJobAttempt(row)
}

export function getWorkflowEffect(
	context: PersistenceConnection,
	runId: string,
	actionId: string
): WorkflowEffectRecord | undefined {
	const row = context.orm
		.select()
		.from(workflowEffects)
		.where(and(eq(workflowEffects.runId, runId), eq(workflowEffects.actionId, actionId)))
		.get()
	return row ? decodeEffect(row) : undefined
}

export function listWorkflowEffects(context: PersistenceConnection, runId: string): WorkflowEffectRecord[] {
	return context.orm
		.select()
		.from(workflowEffects)
		.where(eq(workflowEffects.runId, runId))
		.orderBy(asc(workflowEffects.createdAt), asc(workflowEffects.id))
		.all()
		.map(row => decodeEffect(row))
}

export function requireEffectByAction(
	context: PersistenceConnection,
	runId: string,
	actionId: string
): WorkflowEffectRecord {
	const effect = getWorkflowEffect(context, runId, actionId)
	if (!effect) throw new WorkflowTransitionError(`Workflow effect ${actionId} does not exist`)
	return effect
}

export function requireEffect(context: PersistenceConnection, id: string): WorkflowEffectRecord {
	const row = context.orm.select().from(workflowEffects).where(eq(workflowEffects.id, id)).get()
	if (!row) throw new WorkflowTransitionError(`Workflow effect ${id} does not exist`)
	return decodeEffect(row)
}

export function requireEffectAttempt(context: PersistenceConnection, id: string): WorkflowEffectAttemptRecord {
	const row = context.orm.select().from(workflowEffectAttempts).where(eq(workflowEffectAttempts.id, id)).get()
	if (!row) throw new WorkflowTransitionError(`Workflow effect attempt ${id} does not exist`)
	return decodeEffectAttempt(row)
}

export function listWorkflowEffectAttempts(
	context: PersistenceConnection,
	effectId: string
): WorkflowEffectAttemptRecord[] {
	return context.orm
		.select()
		.from(workflowEffectAttempts)
		.where(eq(workflowEffectAttempts.effectId, effectId))
		.orderBy(asc(workflowEffectAttempts.attemptNumber))
		.all()
		.map(row => decodeEffectAttempt(row))
}

export function requireEffectOwner(effect: WorkflowEffectRecord, owner: RelayIdentity, attemptNumber: number): void {
	if (!effect.owner || !sameOwner(effect.owner, owner) || effect.attemptCount !== attemptNumber) {
		throw new WorkflowTransitionError(`effect ${effect.actionId} is not owned by this relay attempt`)
	}
}
