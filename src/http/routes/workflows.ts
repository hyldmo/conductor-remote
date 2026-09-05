import crypto from 'node:crypto'
import { stagedAttachments } from '../../files/staged-attachments.ts'
import type { PersistedDelegation } from '../../orchestration/delegation/types.ts'
import { WorkflowCoordinatorError } from '../../orchestration/workflow/errors.ts'
import {
	parseConfirmUiStableRequest,
	parseStartWorkflowRequest,
	parseWorkflowAdoptRequest,
	parseWorkflowCompleteRequest,
	parseWorkflowDelegateRequest,
	parseWorkflowReplayRequest,
	parseWorkflowRetryRequest,
	WorkflowRequestError,
	workflowClientIsMcp
} from '../../orchestration/workflow/http.ts'
import { isRoute, routeParam, routes } from '../../routes.ts'
import type { DelegationError, WorkflowDelegateResult } from '../../wire.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createWorkflowsRoutes(
	services: Pick<
		RelayServices,
		| 'orchestration'
		| 'orchestrationUnavailableReason'
		| 'workflowRequestBody'
		| 'json'
		| 'workflowCoordinator'
		| 'stagedAttachmentIdsInObjective'
		| 'STAGED_ATTACHMENTS_DIR'
		| 'roleStore'
		| 'modelCache'
		| 'requirePhoneWorkflowCoordinator'
		| 'WORKFLOW_RECOVERY_PHONE_ONLY'
		| 'reads'
		| 'delegationStore'
		| 'projectDelegation'
		| 'projectWorkflowDelegation'
	>
): RouteHandler {
	const {
		orchestration,
		orchestrationUnavailableReason,
		workflowRequestBody,
		json,
		workflowCoordinator,
		stagedAttachmentIdsInObjective,
		STAGED_ATTACHMENTS_DIR,
		roleStore,
		modelCache,
		requirePhoneWorkflowCoordinator,
		WORKFLOW_RECOVERY_PHONE_ONLY,
		reads,
		delegationStore,
		projectDelegation,
		projectWorkflowDelegation
	} = services
	return async (req, res, url) => {
		const { pathname } = url

		// This is deliberately independent of a Workflow run: cancellation cannot
		// make an ambiguous shared-window effect safe. Only a phone acknowledgement
		// after inspecting Conductor clears the relay-wide hold.
		if (isRoute(routes.confirmUiStable, req.method, pathname)) {
			if (workflowClientIsMcp(req.headers)) {
				throw new WorkflowRequestError('Only the phone UI can confirm that Conductor is stable.', 403)
			}
			if (!orchestration.writable) {
				throw new WorkflowCoordinatorError(
					'workflow_incompatible_relay',
					`UI stability confirmation is disabled because ${orchestrationUnavailableReason()}.`,
					{ status: 409 }
				)
			}
			const request = parseConfirmUiStableRequest(await workflowRequestBody(req))
			const confirmed = orchestration.idempotentMutation(
				'confirm_ui_stable',
				request.clientId,
				{
					confirmStable: true,
					createdAt: request.createdAt,
					...(request.actionId ? { actionId: request.actionId } : {}),
					...(request.effectId ? { effectId: request.effectId } : {})
				},
				() => {
					const current = orchestration.getUiQuarantine()
					if (
						current.active &&
						(current.createdAt !== request.createdAt ||
							current.actionId !== request.actionId ||
							current.effectId !== request.effectId)
					) {
						throw new WorkflowCoordinatorError(
							'workflow_recovery_invalid',
							'The Conductor UI safety hold changed; inspect the current hold before confirming it.',
							{ status: 409 }
						)
					}
					orchestration.clearUiQuarantine(`phone:${request.clientId}`)
					return { ok: true as const }
				}
			)
			return json(req, res, 200, confirmed.result)
		}

		// POST /api/workflows — the only operation that authorizes a managed
		// Workflow. Acceptance is durable and intentionally precedes every UI effect.
		if (isRoute(routes.workflows, req.method, pathname)) {
			if (workflowClientIsMcp(req.headers)) {
				throw new WorkflowRequestError('MCP cannot start a Workflow; start it from the Conductor Remote UI.', 403)
			}
			if (!workflowCoordinator) {
				throw new WorkflowCoordinatorError(
					'workflow_incompatible_relay',
					`Workflow is disabled because ${orchestrationUnavailableReason()}.`,
					{ status: 409 }
				)
			}
			const request = parseStartWorkflowRequest(await workflowRequestBody(req))
			const replay = orchestration.getIdempotentMutation<{ runId: string }>('start_workflow', request.clientId, {
				objective: request.objective,
				target: request.target
			})
			if (!replay && request.target.kind === 'new_workspace') {
				const stageIds = stagedAttachmentIdsInObjective(request.objective)
				if (stageIds.length && !stagedAttachments(STAGED_ATTACHMENTS_DIR, stageIds)) {
					throw new WorkflowCoordinatorError(
						'invalid_request',
						'One or more Workflow attachments are no longer staged; add them again.',
						{ status: 409 }
					)
				}
			}
			const accepted = await workflowCoordinator.start({
				clientId: request.clientId,
				objective: request.objective,
				target: request.target,
				roles: roleStore.read(),
				modelGroups: modelCache.list()
			})
			queueMicrotask(() => {
				void workflowCoordinator.wake(accepted.workflow.id).catch(error => {
					console.error(`[workflow ${accepted.workflow.id}] initial wake failed:`, error)
				})
			})
			return json(req, res, 202, { workflow: accepted.workflow })
		}

		// POST /api/workflows/:id/delegations — managed delegation. The
		// capability, exact root, frozen role, and phase barrier are checked together.
		const workflowDelegation = routeParam(routes.workflowDelegation, req.method, pathname)

		if (workflowDelegation) {
			if (!workflowCoordinator) {
				throw new WorkflowCoordinatorError('workflow_incompatible_relay', 'Workflow is unavailable.', {
					status: 409
				})
			}
			const request = parseWorkflowDelegateRequest(await workflowRequestBody(req), workflowDelegation)
			// The capability rotates after every accepted choice. Its hash therefore
			// doubles as a stable retry identity without adding a field to the exact tool schema.
			const clientId = crypto
				.createHash('sha256')
				.update(
					JSON.stringify([
						request.workflow_id,
						request.phase_capability,
						request.session_id,
						request.role,
						request.prompt
					])
				)
				.digest('hex')
			const accepted = await workflowCoordinator.delegate({
				clientId,
				workflowId: request.workflow_id,
				sessionId: request.session_id,
				phaseCapability: request.phase_capability,
				role: request.role,
				task: request.prompt,
				...(request.role === 'implementation' ? { planningInterpretation: request.prompt } : {})
			})
			queueMicrotask(() => {
				void workflowCoordinator.wake(accepted.workflow.id).catch(error => {
					console.error(`[workflow ${accepted.workflow.id}] delegated wake failed:`, error)
				})
			})
			return json(req, res, 202, {
				ok: true,
				workflowId: accepted.workflow.id,
				delegationId: accepted.job.id,
				role: accepted.job.role,
				model: accepted.job.resolvedRole.model
			} satisfies WorkflowDelegateResult)
		}

		const retryWorkflow = routeParam(routes.workflowRetry, req.method, pathname)

		if (retryWorkflow) {
			const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
			const request = parseWorkflowRetryRequest(await workflowRequestBody(req))
			const result = await coordinator.retry({
				clientId: request.clientId,
				workflowId: retryWorkflow
			})
			queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
			return json(req, res, 200, { workflow: result.workflow })
		}

		const adoptWorkflow = routeParam(routes.workflowAdopt, req.method, pathname)

		if (adoptWorkflow) {
			const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
			const request = parseWorkflowAdoptRequest(await workflowRequestBody(req))
			const result = await coordinator.adopt({
				clientId: request.clientId,
				workflowId: adoptWorkflow,
				actionId: request.actionId,
				candidateId: request.workspaceId ?? request.sessionId
			})
			queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
			return json(req, res, 200, { workflow: result.workflow })
		}

		const replayWorkflow = routeParam(routes.workflowReplay, req.method, pathname)

		if (replayWorkflow) {
			const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
			const request = parseWorkflowReplayRequest(await workflowRequestBody(req))
			const result = await coordinator.replay({
				clientId: request.clientId,
				workflowId: replayWorkflow,
				actionId: request.actionId,
				confirmDuplicateRisk: request.confirmDuplicateRisk
			})
			queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
			return json(req, res, 200, { workflow: result.workflow })
		}

		const completeWorkflow = routeParam(routes.workflowComplete, req.method, pathname)

		if (completeWorkflow) {
			const coordinator = requirePhoneWorkflowCoordinator(req, 'Only the phone UI can mark a Workflow complete.')
			const request = parseWorkflowCompleteRequest(await workflowRequestBody(req))
			const result = await coordinator.complete({
				clientId: request.clientId,
				workflowId: completeWorkflow
			})
			return json(req, res, 200, { workflow: result.workflow })
		}

		const cancelWorkflow = routeParam(routes.workflow, req.method, pathname)

		if (cancelWorkflow) {
			const coordinator = requirePhoneWorkflowCoordinator(req, 'Only the phone UI can cancel a Workflow.')
			const clientId = url.searchParams.get('clientId')
			if (!clientId?.trim()) throw new WorkflowRequestError('clientId is required.')
			const result = await coordinator.cancel({ clientId: clientId.trim(), workflowId: cancelWorkflow })
			return json(req, res, 200, { workflow: result.workflow })
		}

		if (isRoute(routes.delegations, req.method, pathname)) {
			const workspaceId = url.searchParams.get('workspaceId')
			const workspaces = reads.listWorkspaces().filter(ws => !workspaceId || ws.id === workspaceId)
			if (workspaceId && !workspaces.length) return json(req, res, 404, { error: 'workspace not found' })
			const legacy = workspaces.flatMap(ws => {
				const store = delegationStore(ws)
				return store
					? store
							.list()
							.jobs.filter(job => job.status !== 'returned')
							.map(projectDelegation)
					: []
			})
			const allowedWorkspaces = new Set(workspaces.map(workspace => workspace.id))
			const workflows = orchestration.writable
				? orchestration.listWorkflowProjections().flatMap(workflow => {
						if (!workflow.workspaceId || !allowedWorkspaces.has(workflow.workspaceId)) return []
						return orchestration
							.listWorkflowJobs(workflow.id)
							.filter(job => job.state !== 'returned')
							.flatMap(job => projectWorkflowDelegation(workflow, job) ?? [])
					})
				: []
			return json(req, res, 200, { delegations: [...legacy, ...workflows] })
		}

		const dismissDelegation = routeParam(routes.dismissDelegation, req.method, pathname)

		if (dismissDelegation) {
			for (const ws of reads.listWorkspaces()) {
				const store = delegationStore(ws)
				if (!store) continue
				let job: PersistedDelegation | null
				try {
					job = store.get(dismissDelegation)
				} catch (err) {
					const error: DelegationError = {
						code: 'state_invalid',
						message: `Cannot dismiss unreadable delegation: ${err instanceof Error ? err.message : err}`,
						retryable: false
					}
					return json(req, res, 409, {
						ok: false,
						error
					})
				}
				if (!job) continue
				if (job.status !== 'failed') {
					return json(req, res, 409, {
						ok: false,
						error: {
							code: 'invalid_request',
							message: 'Only a failed delegation can be dismissed.',
							retryable: false
						} satisfies DelegationError
					})
				}
				store.remove(job.id)
				return json(req, res, 200, { ok: true, delegationId: job.id })
			}
			return json(req, res, 404, {
				ok: false,
				error: {
					code: 'delegation_not_found',
					message: 'Delegation not found.',
					retryable: false
				} satisfies DelegationError
			})
		}
		return NOT_HANDLED
	}
}
