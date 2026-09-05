import { workflowPrivateEnvelope } from '../../shared.ts'
import {
	type WorkflowEffectRecord,
	type WorkflowRunRecord,
	type WorkflowTarget,
	WorkflowTransitionError
} from '../persistence/db.ts'
import { markReceiptLost } from './effect-recovery.ts'
import { runDurableEffect } from './effects.ts'
import {
	assertDeliveryReceipt,
	assertWorkspaceReceipt,
	cleanUnknown,
	effectGrant,
	isDeliveryReceipt,
	messageReceipt,
	privateCorrelationBlock,
	workflowEffectCorrelationMarker
} from './helpers.ts'
import { workflowRootPrompt } from './prompts.ts'
import { blockRun, effectCall, effectReadCall, requireEffect, requireRun } from './state.ts'
import type { CapabilityGrant, WorkflowContext, WorkflowDeliveryCursor } from './types.ts'

export async function driveWorkspaceCreation(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	const effect = requireEffect(context, run.id, 'create-workspace')
	const result = await runDurableEffect(context, {
		run,
		effect,
		execute: (_token, dispatch) =>
			context.deps.createWorkspace({
				...effectCall(run, effect, dispatch),
				target: run.target as Extract<WorkflowTarget, { kind: 'new_workspace' }>
			}),
		validate: assertWorkspaceReceipt
	})
	const committed =
		result.effect.state === 'committed' ? result.effect : requireEffect(context, run.id, effect.actionId)
	if (committed.state !== 'committed') return result.changed
	const receipt = assertWorkspaceReceipt(committed.receipt)
	const fresh = requireRun(context, run.id)
	if (fresh.phase !== 'creating_workspace') return true
	context.db.transitionWorkflowRun({
		runId: fresh.id,
		expectedPhase: 'creating_workspace',
		expectedCancellationGeneration: fresh.cancellationGeneration,
		phase: 'binding_root',
		workspaceId: receipt.workspaceId,
		eventKey: `workspace-created:${receipt.workspaceId}`,
		eventType: 'workflow_workspace_created',
		eventData: receipt
	})
	return true
}

export async function driveRootBinding(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	if (!run.workspaceId) throw new WorkflowTransitionError(`Workflow ${run.id} has no created workspace binding`)
	const inspection = await context.deps.bindCreatedRoot({ run, workspaceId: run.workspaceId })
	if (!inspection) return false
	if (inspection.workspaceId !== run.workspaceId) {
		blockRun(context, run, {
			actionId: 'bind-root',
			errorCode: 'workflow_root_mismatch',
			message: 'The discovered root did not belong to the exact created workspace.',
			retryClass: 'terminal'
		})
		return true
	}
	if (!inspection.pristine) {
		blockRun(context, run, {
			actionId: 'bind-root',
			errorCode: 'workflow_root_not_pristine',
			message: inspection.reason ?? 'The created root chat is no longer pristine.',
			retryClass: 'terminal'
		})
		return true
	}
	context.db.idempotentMutation(
		'bind_workflow_root',
		`${run.id}:${inspection.workspaceId}:${inspection.rootSessionId}`,
		{
			workspaceId: inspection.workspaceId,
			rootSessionId: inspection.rootSessionId,
			pristineEvidence: cleanUnknown(inspection.pristineEvidence),
			deliveryCursor: inspection.deliveryCursor
		},
		() => {
			context.db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'binding_root',
				expectedCancellationGeneration: run.cancellationGeneration,
				phase: 'pending_root',
				rootSessionId: inspection.rootSessionId,
				pristineEvidence: cleanUnknown(inspection.pristineEvidence),
				deliveryBaseline: inspection.deliveryCursor,
				eventKey: `root-bound:${inspection.rootSessionId}`,
				eventType: 'workflow_root_bound'
			})
			prepareRootEffects(context, requireRun(context, run.id), inspection.deliveryCursor)
			return { runId: run.id }
		},
		{ runId: run.id }
	)
	return true
}

export function prepareRootEffects(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	cursor: WorkflowDeliveryCursor
): void {
	if (!run.workspaceId || !run.rootSessionId) throw new WorkflowTransitionError('Workflow root is not fully bound')
	context.db.prepareWorkflowEffect({
		runId: run.id,
		actionId: 'configure-root',
		kind: 'configure_root',
		target: { workspaceId: run.workspaceId, sessionId: run.rootSessionId },
		inputs: {
			role: run.roles.planning,
			correlationMarker: workflowEffectCorrelationMarker(run.id, 'configure-root')
		},
		expectedCancellationGeneration: run.cancellationGeneration,
		eventKey: 'prepare:configure-root'
	})
	context.db.prepareWorkflowEffect({
		runId: run.id,
		actionId: 'send-root',
		kind: 'send_root',
		target: { workspaceId: run.workspaceId, sessionId: run.rootSessionId },
		inputs: {
			cycle: 0,
			revision: 0,
			allowedRoles: ['exploration'],
			correlationMarker: workflowEffectCorrelationMarker(run.id, 'send-root')
		},
		cursor,
		expectedCancellationGeneration: run.cancellationGeneration,
		eventKey: 'prepare:send-root'
	})
}

export async function drivePendingRoot(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	if (!run.rootSessionId || !run.workspaceId) throw new WorkflowTransitionError('pending root is not bound')
	let configure = context.db.getWorkflowEffect(run.id, 'configure-root')
	let send = context.db.getWorkflowEffect(run.id, 'send-root')
	if (!configure || !send) {
		prepareRootEffects(context, run, run.deliveryBaseline as WorkflowDeliveryCursor)
		configure = requireEffect(context, run.id, 'configure-root')
		send = requireEffect(context, run.id, 'send-root')
	}
	if (configure.state !== 'committed') {
		const result = await runDurableEffect(context, {
			run,
			effect: configure,
			execute: (_token, dispatch) =>
				context.deps.configureSession({
					...effectCall(run, configure as WorkflowEffectRecord, dispatch),
					sessionId: run.rootSessionId as string,
					role: run.roles.planning
				}),
			validate: result => cleanUnknown(result ?? { matched: true })
		})
		return result.changed
	}
	if (send.state !== 'committed') {
		const grant: CapabilityGrant = {
			phase: 'exploring',
			cycle: 0,
			revision: 0,
			allowedRoles: ['exploration']
		}
		const result = await runDurableEffect(context, {
			run,
			effect: send,
			capabilityGrant: grant,
			execute: (token, dispatch) =>
				context.deps.sendPrompt({
					...effectCall(run, send as WorkflowEffectRecord, dispatch),
					sessionId: run.rootSessionId as string,
					text: [
						workflowRootPrompt({
							workflowId: run.id,
							objective: run.objective,
							roles: run.roles,
							phaseCapability: token as string,
							cycle: 0,
							revision: 0
						}),
						privateCorrelationBlock(run.id, send.actionId)
					].join('\n\n')
				}),
			validate: assertDeliveryReceipt
		})
		if (result.effect.state !== 'committed') return result.changed
		return (await activateRootFromReceipt(context, run, result.effect)) || result.changed
	}
	return activateRootFromReceipt(context, run, send)
}

export async function activateRootFromReceipt(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord
): Promise<boolean> {
	if (!run.rootSessionId || !isDeliveryReceipt(effect.receipt)) return false
	const resolution = await context.deps.resolveDeliveryReceipt({
		...effectReadCall(run, effect),
		sessionId: run.rootSessionId,
		receipt: effect.receipt
	})
	if (resolution.status === 'lost') {
		markReceiptLost(context, run, effect, resolution.evidence)
		return true
	}
	const resolved = messageReceipt(resolution, effect.receipt.id)
	if (!resolved) return false
	if (!effect.launchNonce || !/^[a-f\d]{64}$/i.test(effect.launchNonce)) {
		throw new WorkflowTransitionError('delivered root effect has no capability hash')
	}
	context.db.idempotentMutation(
		'activate_workflow_root',
		`${run.id}:${resolved.id}`,
		{ receipt: resolved, tokenHash: effect.launchNonce },
		() => {
			const current = requireRun(context, run.id)
			if (current.phase !== 'pending_root') return { runId: run.id }
			const exploring = context.db.transitionWorkflowRun({
				runId: current.id,
				expectedPhase: 'pending_root',
				expectedCancellationGeneration: current.cancellationGeneration,
				phase: 'exploring',
				cycle: 0,
				revision: 0,
				eventKey: `root-delivered:${resolved.id}`,
				eventType: 'workflow_root_delivered',
				eventData: resolved
			})
			context.db.issueWorkflowCapability({
				tokenHash: effect.launchNonce as string,
				runId: exploring.id,
				rootSessionId: exploring.rootSessionId as string,
				cycle: exploring.cycle,
				phase: 'exploring',
				revision: exploring.revision,
				allowedRoles: ['exploration'],
				issuedWith: { rowid: resolved.rowid, ...(resolved.turnId ? { turnId: resolved.turnId } : {}) },
				eventKey: `root-capability:${resolved.id}`
			})
			context.db.activateWorkflowJob(
				`${run.id}:explore:0`,
				exploring.cancellationGeneration,
				`bootstrap-activated:${resolved.id}`,
				{ rowid: resolved.rowid }
			)
			return { runId: run.id }
		},
		{ runId: run.id, actionId: effect.actionId }
	)
	return true
}

export async function drivePhaseAuthorization(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	if (run.phase !== 'exploring' || !run.rootSessionId) return false
	const actionId = `authorize:exploring:${run.cycle}:${run.revision}`
	const effect = context.db.getWorkflowEffect(run.id, actionId)
	if (!effect) return false
	const grant = effectGrant(effect)
	if (!grant) throw new WorkflowTransitionError(`authorization effect ${actionId} has invalid grant inputs`)
	let current = effect
	let changed = false
	if (effect.state !== 'committed') {
		const result = await runDurableEffect(context, {
			run,
			effect,
			capabilityGrant: grant,
			execute: (token, dispatch) =>
				context.deps.sendPrompt({
					...effectCall(run, effect, dispatch),
					sessionId: run.rootSessionId as string,
					text: [
						'Workflow exploration authorization rotated after accepting a tracked explorer.',
						'Do not repeat or quote the private block. Use it only for another delegate_task call.',
						workflowPrivateEnvelope({
							workflowId: run.id,
							phaseCapability: token as string,
							cycle: grant.cycle,
							revision: grant.revision,
							allowedRoles: grant.allowedRoles
						}),
						privateCorrelationBlock(run.id, effect.actionId)
					].join('\n\n')
				}),
			validate: assertDeliveryReceipt
		})
		current = result.effect
		changed = result.changed
	}
	if (current.state !== 'committed' || !isDeliveryReceipt(current.receipt)) return changed
	const resolution = await context.deps.resolveDeliveryReceipt({
		...effectReadCall(run, current),
		sessionId: run.rootSessionId,
		receipt: current.receipt
	})
	if (resolution.status === 'lost') {
		markReceiptLost(context, run, current, resolution.evidence)
		return true
	}
	const receipt = messageReceipt(resolution, current.receipt.id)
	if (!receipt) return changed
	if (!current.launchNonce) throw new WorkflowTransitionError('authorization effect has no capability hash')
	const fresh = requireRun(context, run.id)
	if (fresh.phase !== grant.phase || fresh.cycle !== grant.cycle || fresh.revision !== grant.revision) return changed
	const issuance = context.db.idempotentMutation(
		'issue_workflow_phase_capability',
		`${run.id}:${current.actionId}:${receipt.id}`,
		{ actionId: current.actionId, receipt, tokenHash: current.launchNonce },
		() => {
			context.db.issueWorkflowCapability({
				tokenHash: current.launchNonce as string,
				runId: fresh.id,
				rootSessionId: fresh.rootSessionId as string,
				cycle: grant.cycle,
				phase: grant.phase,
				revision: grant.revision,
				allowedRoles: grant.allowedRoles,
				issuedWith: { rowid: receipt.rowid, ...(receipt.turnId ? { turnId: receipt.turnId } : {}) },
				eventKey: `phase-capability:${current.actionId}:${receipt.id}`
			})
			return { runId: run.id }
		},
		{ runId: run.id, actionId: current.actionId }
	)
	return changed || !issuance.replayed
}
