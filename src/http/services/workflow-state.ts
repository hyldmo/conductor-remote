import type http from 'node:http'

import { IdempotencyConflictError, WorkflowTransitionError } from '../../orchestration/persistence/errors.ts'
import { WorkflowCoordinatorError } from '../../orchestration/workflow/errors.ts'
import { WorkflowRequestError } from '../../orchestration/workflow/http.ts'
import { WorkflowGuardError } from '../../orchestration/workflow/machine.ts'
import type { Workspace } from '../../reads/types.ts'
import { scrubWorkflowSecrets, withoutWindowEvidence } from '../../shared.ts'
import type { DelegationProjection, UiQuarantineWire, Workspace as WireWorkspace, WorkflowRunWire } from '../../wire.ts'
import type { BaseServices } from './base.ts'
import type { ResponsesServices } from './responses.ts'

/** Attach only bounded, scrubbed navigation state; capabilities and internal effect evidence stay in SQLite. */
export type WorkflowAttachedWorkspace = Workspace &
	Pick<WireWorkspace, 'delegations' | 'session_roles' | 'workflow' | 'workflow_identity' | 'delegation_warning'>
export function createWorkflowStateServices(
	services: Pick<BaseServices, 'orchestration'> & Pick<ResponsesServices, 'readBody'>
) {
	const { orchestration, readBody } = services

	/** Keep process identity and raw recovery evidence private; the phone only needs the hold and its cause. */
	function wireUiQuarantine(): UiQuarantineWire | undefined {
		if (!orchestration.writable) return undefined
		const quarantine = orchestration.getUiQuarantine()
		if (!quarantine.active) return undefined
		const bounded = (value: string, maximum: number) =>
			withoutWindowEvidence(scrubWorkflowSecrets(value)).slice(0, maximum)
		return {
			active: true,
			reason: bounded(
				quarantine.reason ??
					'A previous automated Conductor UI action may have completed without a confirmed receipt. Inspect Conductor before continuing.',
				500
			),
			createdAt: quarantine.createdAt ?? 0,
			...(quarantine.actionId ? { actionId: bounded(quarantine.actionId, 256) } : {}),
			...(quarantine.effectId ? { effectId: bounded(quarantine.effectId, 256) } : {})
		}
	}

	function workflowJobStatus(state: ReturnType<typeof orchestration.listWorkflowJobs>[number]['state']) {
		if (state === 'owned') return 'opening' as const
		if (state === 'dormant') return 'queued' as const
		if (state === 'cancelled') return 'failed' as const
		return state
	}

	function projectWorkflowDelegation(
		workflow: WorkflowRunWire,
		job: ReturnType<typeof orchestration.listWorkflowJobs>[number]
	): DelegationProjection | null {
		if (!workflow.workspaceId || job.state === 'cancelled') return null
		return {
			id: job.id,
			workflowId: workflow.id,
			logicalKey: job.logicalKey,
			bootstrap: job.logicalKey === 'explore:0',
			workspaceId: workflow.workspaceId,
			parentSessionId: workflow.rootSessionId ?? '',
			...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
			role: job.role,
			// The immutable preamble remains coordinator-private. Only the public picker
			// settings are useful for role chips and list_delegations.
			resolvedRole: {
				agentType: job.resolvedRole.agentType,
				model: job.resolvedRole.model,
				...(job.resolvedRole.effort ? { effort: job.resolvedRole.effort } : {}),
				...(job.resolvedRole.fast === undefined ? {} : { fast: job.resolvedRole.fast })
			},
			prompt: scrubWorkflowSecrets(job.prompt).slice(0, 500),
			returnMode: 'queue',
			status: workflowJobStatus(job.state),
			attempts: job.attemptCount,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			...(job.state === 'failed'
				? {
						failure: {
							code: 'workflow_blocked' as const,
							message: workflow.error?.message ?? 'Workflow job failed.',
							retryable: workflow.actions.canRetry
						}
					}
				: {})
		}
	}

	function attachWorkflowState(workspaces: WorkflowAttachedWorkspace[]): WorkflowRunWire[] {
		if (!orchestration.writable) return []
		const projections = orchestration.listWorkflowProjections()
		const byWorkspace = new Map(workspaces.map(workspace => [workspace.id, workspace]))
		for (const workflow of projections) {
			if (!workflow.workspaceId) continue
			const workspace = byWorkspace.get(workflow.workspaceId)
			if (!workspace) continue
			const run = orchestration.getWorkflowRun(workflow.id)
			if (!run) continue
			const jobs = orchestration
				.listWorkflowJobs(workflow.id)
				.flatMap(job => projectWorkflowDelegation(workflow, job) ?? [])
			workspace.delegations = [...(workspace.delegations ?? []), ...jobs]
			workspace.session_roles = { ...(workspace.session_roles ?? {}) }
			if (workflow.rootSessionId) {
				workspace.session_roles[workflow.rootSessionId] = {
					role: 'planning',
					workflowId: workflow.id,
					assignedAt: workflow.createdAt
				}
			}
			for (const job of orchestration.listWorkflowJobs(workflow.id)) {
				if (!job.childSessionId) continue
				workspace.session_roles[job.childSessionId] = {
					role: job.role,
					delegationId: job.id,
					workflowId: workflow.id,
					assignedAt: job.createdAt
				}
			}
			// Compatibility for cached clients that only understand one workspace-level run.
			if (!workspace.workflow || workflow.rootSessionId === workspace.active_session_id) workspace.workflow = workflow
		}
		// A terminal run leaves the active Workflow list but not the workspace's identity.
		// Attach only the newest historical projection when no live run already won above;
		// its frozen public roles let the sidebar remain truthful after role settings change.
		const historicalWorkspaceIds = [...byWorkspace.values()]
			.filter(workspace => !workspace.workflow)
			.map(workspace => workspace.id)
		for (const workflow of orchestration.listLatestWorkflowProjectionsForWorkspaces(historicalWorkspaceIds)) {
			if (!workflow.workspaceId) continue
			const workspace = byWorkspace.get(workflow.workspaceId)
			if (workspace && !workspace.workflow) {
				workspace.workflow_identity = {
					id: workflow.id,
					phase: workflow.phase,
					roles: workflow.roles
				}
			}
		}
		return projections
	}

	function workflowOwningSession(sessionId: string) {
		if (!orchestration.writable) return null
		for (const projection of orchestration.listWorkflowProjections()) {
			if (projection.rootSessionId === sessionId) return projection
			if (orchestration.listWorkflowJobs(projection.id).some(job => job.childSessionId === sessionId)) return projection
		}
		return null
	}

	function workflowFrozenError(
		sessionId: string
	): { error: { code: string; message: string; retryable: false } } | null {
		const workflow = workflowOwningSession(sessionId)
		if (!workflow) return null
		return {
			error: {
				code: 'workflow_role_frozen',
				message: `Workflow ${workflow.id} froze this chat's model, effort, and Fast setting at Start.`,
				retryable: false
			}
		}
	}

	function workflowHttpError(
		error: unknown
	): { status: number; error: { code: string; message: string; retryable: boolean } } | null {
		if (error instanceof WorkflowRequestError || error instanceof WorkflowGuardError) {
			return { status: error.status, error: { code: error.code, message: error.message, retryable: false } }
		}
		if (error instanceof WorkflowCoordinatorError) {
			return {
				status: error.status,
				error: { code: error.code, message: error.message, retryable: error.retryable }
			}
		}
		if (error instanceof IdempotencyConflictError) {
			return {
				status: 409,
				error: { code: 'idempotency_conflict', message: error.message, retryable: false }
			}
		}
		if (error instanceof WorkflowTransitionError) {
			return {
				status: 409,
				error: { code: 'workflow_phase_invalid', message: error.message, retryable: false }
			}
		}
		return null
	}

	async function workflowRequestBody(req: http.IncomingMessage): Promise<unknown> {
		try {
			return JSON.parse((await readBody(req)) || '{}') as unknown
		} catch {
			throw new WorkflowRequestError('Workflow request body must be valid JSON.')
		}
	}
	return {
		attachWorkflowState,
		wireUiQuarantine,
		workflowRequestBody,
		projectWorkflowDelegation,
		workflowFrozenError,
		workflowOwningSession,
		workflowHttpError
	}
}
export type WorkflowStateServices = ReturnType<typeof createWorkflowStateServices>
