import { randomUUID } from 'node:crypto'
import { WorkflowCoordinatorError } from './errors.ts'
import { cleanUnknown, privateCorrelationBlock, workflowEffectCorrelationMarker } from './helpers.ts'
import { prepareWorkflowRun, workflowBootstrapPrompt } from './prompts.ts'
import { assertCompatible, heartbeat, projection } from './state.ts'
import type {
	WorkflowContext,
	WorkflowCoordinatorStartInput,
	WorkflowRootInspection,
	WorkflowStartResult
} from './types.ts'

export async function start(
	context: WorkflowContext,
	input: WorkflowCoordinatorStartInput
): Promise<WorkflowStartResult> {
	const replay = context.db.getIdempotentMutation<{ runId: string }>('start_workflow', input.clientId, {
		objective: input.objective,
		target: input.target
	})
	if (replay) return { replayed: true, workflow: projection(context, replay.result.runId) }
	heartbeat(context)
	await assertCompatible(context)
	const prepared = prepareWorkflowRun(input.roles, input.modelGroups, input.objective)
	if (!prepared.ok) {
		throw new WorkflowCoordinatorError(prepared.error.code, prepared.error.message, { status: 409 })
	}
	const runId = randomUUID()
	const objective = prepared.prepared.objective
	const bootstrapPrompt = [
		workflowBootstrapPrompt({
			objective,
			role: prepared.prepared.roles.exploration
		}),
		privateCorrelationBlock(runId, `job:${runId}:explore:0`)
	].join('\n\n')
	let inspection: WorkflowRootInspection | null = null
	let baseline: unknown
	if (input.target.kind === 'existing_session') {
		inspection = await context.deps.inspectExistingRoot(input.target)
		if (!inspection) {
			throw new WorkflowCoordinatorError('workflow_not_found', 'The selected Workflow root no longer exists.', {
				status: 404
			})
		}
		if (inspection.workspaceId !== input.target.workspaceId || inspection.rootSessionId !== input.target.sessionId) {
			throw new WorkflowCoordinatorError('workflow_not_found', 'The root inspection did not match the selected chat.', {
				status: 404
			})
		}
		if (!inspection.pristine) {
			throw new WorkflowCoordinatorError(
				'workflow_root_not_pristine',
				inspection.reason ?? 'Workflow requires a pristine root chat.',
				{ status: 409 }
			)
		}
	} else {
		baseline = cleanUnknown(await context.deps.captureWorkspaceBaseline(input.target.repo))
	}

	const accepted = context.db.createWorkflowRun({
		id: runId,
		clientId: input.clientId,
		objective,
		target: input.target,
		roles: prepared.prepared.roles,
		...(inspection
			? {
					workspaceId: inspection.workspaceId,
					rootSessionId: inspection.rootSessionId,
					pristineEvidence: cleanUnknown(inspection.pristineEvidence),
					deliveryBaseline: inspection.deliveryCursor
				}
			: {}),
		bootstrapPrompt,
		initialEffects:
			input.target.kind === 'new_workspace'
				? [
						{
							actionId: 'create-workspace',
							kind: 'create_workspace',
							target: input.target,
							inputs: { correlationMarker: workflowEffectCorrelationMarker(runId, 'create-workspace') },
							baseline
						}
					]
				: [
						{
							actionId: 'configure-root',
							kind: 'configure_root',
							target: { workspaceId: input.target.workspaceId, sessionId: input.target.sessionId },
							inputs: {
								role: prepared.prepared.roles.planning,
								correlationMarker: workflowEffectCorrelationMarker(runId, 'configure-root')
							}
						},
						{
							actionId: 'send-root',
							kind: 'send_root',
							target: { workspaceId: input.target.workspaceId, sessionId: input.target.sessionId },
							cursor: inspection?.deliveryCursor,
							inputs: {
								cycle: 0,
								revision: 0,
								allowedRoles: ['exploration'],
								correlationMarker: workflowEffectCorrelationMarker(runId, 'send-root')
							}
						}
					]
	})
	return { replayed: accepted.replayed, workflow: projection(context, accepted.run.id) }
}
