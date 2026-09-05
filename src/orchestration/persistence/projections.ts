import { desc, inArray, notInArray } from 'drizzle-orm'
import type { WorkflowRoleName, WorkflowRunWire } from '../../wire.ts'
import { isTerminalWorkflowJobState, isTerminalWorkflowPhase } from '../workflow/machine.ts'
import type { FrozenWorkflowRole } from '../workflow/prompts.ts'
import { decodeRun } from './codecs.ts'
import type { PersistenceConnection } from './connection.ts'
import { appendEvent } from './events.ts'
import { getWorkflowEffect, getWorkflowRun, listWorkflowJobs } from './records.ts'
import { type WorkflowJobRole, workflowRuns } from './schema.ts'
import type { WorkflowRunProjection, WorkflowRunRecord } from './types.ts'
import { ALL_JOB_STATES } from './values.ts'

export function getWorkflowProjection(
	context: PersistenceConnection,
	runId: string
): WorkflowRunProjection | undefined {
	const run = getWorkflowRun(context, runId)
	return run ? projectRun(context, run) : undefined
}

export function listWorkflowProjections(
	context: PersistenceConnection,
	options: { includeTerminal?: boolean } = {}
): WorkflowRunProjection[] {
	return context.orm
		.select()
		.from(workflowRuns)
		.where(options.includeTerminal ? undefined : notInArray(workflowRuns.phase, ['completed', 'cancelled']))
		.orderBy(desc(workflowRuns.updatedAt))
		.all()
		.map(row => projectRun(context, decodeRun(row)))
}

/**
 * The sidebar keeps the identity of the newest Workflow that touched each live
 * workspace after that run reaches a terminal phase. Limit the query to the
 * workspaces on screen and project only one run per workspace: terminal history
 * is unbounded, while `/api/state` is polled every few seconds.
 */
export function listLatestWorkflowProjectionsForWorkspaces(
	context: PersistenceConnection,
	workspaceIds: readonly string[]
): WorkflowRunProjection[] {
	const ids = [...new Set(workspaceIds.filter(Boolean))]
	if (!ids.length) return []
	const placeholders = ids.map(() => '?').join(', ')
	const newest = context.db
		.prepare(
			`SELECT id FROM (
				SELECT id, created_at, updated_at,
					ROW_NUMBER() OVER (
						PARTITION BY workspace_id
						ORDER BY created_at DESC, updated_at DESC, id DESC
					) AS ordinal
				FROM workflow_runs
				WHERE workspace_id IN (${placeholders})
			) WHERE ordinal = 1
			ORDER BY created_at DESC, updated_at DESC, id DESC`
		)
		.all(...ids) as unknown as Array<{ id: string }>
	if (!newest.length) return []
	const rows = context.orm
		.select()
		.from(workflowRuns)
		.where(
			inArray(
				workflowRuns.id,
				newest.map(row => row.id)
			)
		)
		.all()
	const byId = new Map(rows.map(row => [row.id, row]))
	return newest.flatMap(({ id }) => {
		const row = byId.get(id)
		return row ? [projectRun(context, decodeRun(row))] : []
	})
}

/**
 * Active runs always need driving. A cancelled run remains wakeable only while
 * it has durable evidence that can still settle: an external effect whose
 * outcome is unknown, an accepted outbox receipt awaiting promotion, or a
 * delivered child turn whose final outcome has not appeared yet.
 */
export function listWorkflowRunIdsNeedingWake(context: PersistenceConnection): string[] {
	return (
		context.db
			.prepare(
				`SELECT r.id FROM workflow_runs r
				 WHERE r.phase NOT IN ('completed', 'cancelled')
					OR (
						r.phase = 'cancelled' AND (
							EXISTS (
								SELECT 1 FROM workflow_effects e
								WHERE e.run_id = r.id AND (
									e.state IN ('dispatched', 'ambiguous') OR
									(e.state = 'committed' AND json_extract(e.receipt_json, '$.kind') = 'outbox')
								)
							) OR EXISTS (
								SELECT 1 FROM workflow_jobs j
								WHERE j.run_id = r.id AND j.state = 'cancelled'
									AND j.child_session_id IS NOT NULL AND j.outcome_json IS NULL
									AND (
										json_extract(j.task_receipt_json, '$.kind') = 'message' OR EXISTS (
											SELECT 1 FROM workflow_effects task
											WHERE task.job_id = j.id AND task.kind = 'send_task'
												AND task.state = 'committed'
												AND json_extract(task.receipt_json, '$.kind') = 'message'
										)
									)
							)
						)
					)
				 ORDER BY r.updated_at DESC, r.id`
			)
			.all() as unknown as Array<{ id: string }>
	).map(row => row.id)
}

export function projectRun(context: PersistenceConnection, run: WorkflowRunRecord): WorkflowRunProjection {
	const jobs = listWorkflowJobs(context, run.id)
	const summary = (role: WorkflowJobRole) => {
		const selected = jobs.filter(job => job.role === role && job.state !== 'cancelled')
		return {
			requested: selected.length,
			running: selected.filter(job => !isTerminalWorkflowJobState(job.state) && job.state !== 'dormant').length,
			returned: selected.filter(job => job.state === 'returned').length,
			failed: selected.filter(job => job.state === 'failed').length
		}
	}
	const publicRole = (role: FrozenWorkflowRole): WorkflowRunWire['roles'][WorkflowRoleName] => ({
		agentType: role.agentType,
		model: role.model,
		...(role.effort === undefined ? {} : { effort: role.effort }),
		...(role.fast === undefined ? {} : { fast: role.fast })
	})
	const blocked = run.blocked
	const candidates = (blocked?.candidates ?? []).slice(0, 20).map(candidate => ({
		id: candidate.id,
		title: context.scrubPublicText(candidate.title).slice(0, 200),
		repo: context.scrubPublicText(candidate.repo).slice(0, 200),
		createdAt: candidate.createdAt
	}))
	const blockedEffect = blocked ? getWorkflowEffect(context, run.id, blocked.actionId) : undefined
	const adoptionKind =
		blocked?.candidates?.[0]?.kind ?? (blockedEffect?.kind === 'create_workspace' ? 'workspace' : 'session')
	// Risky replay still needs the stable action id when reconciliation found no
	// candidate. The fixed wire deliberately has no second public effect-id field,
	// so retain the recovery envelope with an empty candidates array.
	const exposeRecoveryAction =
		!!blocked &&
		(candidates.length > 0 || blocked.retryClass === 'ambiguous') &&
		(adoptionKind === 'workspace' || adoptionKind === 'session')
	const outstanding = jobs.some(job => !isTerminalWorkflowJobState(job.state))
	const implementationReturned = jobs.some(job => job.role === 'implementation' && job.state === 'returned')
	return {
		id: run.id,
		...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
		...(run.rootSessionId ? { rootSessionId: run.rootSessionId } : {}),
		phase: run.phase,
		objectiveExcerpt: context.scrubPublicText(run.objective).slice(0, 240),
		roles: {
			planning: publicRole(run.roles.planning),
			exploration: publicRole(run.roles.exploration),
			implementation: publicRole(run.roles.implementation)
		},
		jobs: { exploration: summary('exploration'), implementation: summary('implementation') },
		...(blocked
			? {
					error: {
						code: blocked.errorCode,
						message: context.scrubPublicText(blocked.message).slice(0, 500),
						retryable: blocked.retryClass === 'deterministic'
					}
				}
			: {}),
		...(exposeRecoveryAction ? { adoption: { actionId: blocked.actionId, kind: adoptionKind, candidates } } : {}),
		actions: {
			canRetry: run.phase === 'blocked' && run.blocked?.retryClass === 'deterministic',
			canAdopt: run.phase === 'blocked' && candidates.length > 0,
			canReplayAmbiguous: run.phase === 'blocked' && run.blocked?.retryClass === 'ambiguous',
			canCancel: !isTerminalWorkflowPhase(run.phase),
			canComplete: run.phase === 'reviewing' && implementationReturned && !outstanding
		},
		createdAt: run.createdAt,
		updatedAt: run.updatedAt
	}
}

export function compactTerminalRuns(
	context: PersistenceConnection,
	options: { olderThan: number; limit?: number }
): number {
	return context.immediate(() => {
		const rows = context.db
			.prepare(
				`SELECT id FROM workflow_runs
				 WHERE phase IN ('completed', 'cancelled') AND terminal_at IS NOT NULL AND terminal_at < ?
					AND NOT EXISTS (
						SELECT 1 FROM workflow_events e
						WHERE e.run_id = workflow_runs.id AND e.type = 'terminal_compacted'
					)
				 ORDER BY terminal_at LIMIT ?`
			)
			.all(options.olderThan, Math.max(1, Math.min(options.limit ?? 20, 100))) as Array<{ id: string }>
		for (const row of rows) {
			const jobs = listWorkflowJobs(context, row.id)
			const effects = context.db
				.prepare('SELECT state, COUNT(*) count FROM workflow_effects WHERE run_id = ? GROUP BY state')
				.all(row.id) as Array<{ state: string; count: number }>
			context.db.prepare('DELETE FROM workflow_capabilities WHERE run_id = ?').run(row.id)
			context.db.prepare('DELETE FROM workflow_jobs WHERE run_id = ?').run(row.id)
			context.db.prepare('DELETE FROM workflow_effects WHERE run_id = ?').run(row.id)
			context.db.prepare('DELETE FROM workflow_events WHERE run_id = ?').run(row.id)
			appendEvent(context, row.id, 'terminal_compacted', 'terminal_compacted', {
				jobs: Object.fromEntries(
					(['exploration', 'implementation'] as const).map(role => [
						role,
						Object.fromEntries(
							ALL_JOB_STATES.map(state => [state, jobs.filter(job => job.role === role && job.state === state).length])
						)
					])
				),
				effects: Object.fromEntries(effects.map(effect => [effect.state, effect.count]))
			})
		}
		return rows.length
	})
}
