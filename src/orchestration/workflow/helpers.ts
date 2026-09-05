import type { DeliveryReceipt } from '../../reads/types.ts'
import { scrubWorkflowSecrets, WORKFLOW_PRIVATE_ENVELOPE_CLOSE, WORKFLOW_PRIVATE_ENVELOPE_OPEN } from '../../shared.ts'
import type { WorkflowChildRoleName } from '../../wire.ts'
import {
	type FrozenWorkflowRole,
	type RelayIdentity,
	type WorkflowEffectRecord,
	type WorkflowJobRecord,
	type WorkflowPhase,
	type WorkflowRetryClass,
	type WorkflowRunRecord,
	WorkflowTransitionError
} from '../persistence/db.ts'
import { WorkflowCoordinatorError } from './errors.ts'
import { isTerminalWorkflowPhase, type WorkflowGuardJob } from './machine.ts'
import type { CapabilityGrant, PromptRole, WorkflowChildOutcome, WorkflowDeliveryResolution } from './types.ts'

export function cleanUnknown(value: unknown, depth = 0): unknown {
	if (depth > 12) return '[truncated]'
	if (typeof value === 'string') return scrubWorkflowSecrets(value)
	if (Array.isArray(value)) return value.map(entry => cleanUnknown(entry, depth + 1))
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cleanUnknown(entry, depth + 1)])
		)
	}
	return value
}

export function errorMessage(error: unknown): string {
	return scrubWorkflowSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

export function errorCode(error: unknown, fallback: string): string {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
		return scrubWorkflowSecrets(error.code).slice(0, 100)
	}
	return fallback
}

export function preExecutionRetryClass(error: unknown): WorkflowRetryClass {
	return errorCode(error, 'workflow_effect_failed') === 'workflow_root_not_pristine' ? 'terminal' : 'deterministic'
}

export function sanitizeChildOutcome(outcome: WorkflowChildOutcome): WorkflowChildOutcome {
	return outcome.kind === 'success'
		? {
				kind: 'success',
				baton: scrubWorkflowSecrets(outcome.baton),
				...(outcome.evidence === undefined ? {} : { evidence: cleanUnknown(outcome.evidence) })
			}
		: {
				kind: 'failure',
				code: scrubWorkflowSecrets(outcome.code),
				message: scrubWorkflowSecrets(outcome.message),
				retryClass: outcome.retryClass ?? 'deterministic',
				...(outcome.evidence === undefined ? {} : { evidence: cleanUnknown(outcome.evidence) })
			}
}

export function isDeliveryReceipt(value: unknown): value is DeliveryReceipt {
	if (!value || typeof value !== 'object') return false
	const receipt = value as Partial<DeliveryReceipt>
	if (receipt.kind === 'outbox') return typeof receipt.id === 'string' && receipt.id.length > 0
	return (
		receipt.kind === 'message' &&
		typeof receipt.id === 'string' &&
		typeof receipt.rowid === 'number' &&
		Number.isSafeInteger(receipt.rowid) &&
		(receipt.turnId === null || typeof receipt.turnId === 'string')
	)
}

export function messageReceipt(
	resolution: WorkflowDeliveryResolution,
	expectedId: string
): Extract<DeliveryReceipt, { kind: 'message' }> | null {
	if (resolution.status !== 'delivered' || resolution.receipt.id !== expectedId) return null
	return resolution.receipt
}

export function effectSessionId(effect: WorkflowEffectRecord): string | undefined {
	if (!effect.target || typeof effect.target !== 'object') return undefined
	const sessionId = (effect.target as { sessionId?: unknown }).sessionId
	return typeof sessionId === 'string' && sessionId ? sessionId : undefined
}

export function receiptEventSuffix(receipt: unknown, fallback: string): string {
	return isDeliveryReceipt(receipt) ? `${receipt.kind}:${receipt.id}` : fallback
}

/** Stable, non-secret evidence used to match an orphaned external effect. */
export function workflowEffectCorrelationMarker(runId: string, actionId: string): string {
	return `[conductor-remote workflow:${runId} action:${actionId}]`
}

/** Raw Conductor sees the marker; every scrubbed transcript surface removes it. */
export function privateCorrelationBlock(runId: string, actionId: string): string {
	return [
		WORKFLOW_PRIVATE_ENVELOPE_OPEN,
		workflowEffectCorrelationMarker(runId, actionId),
		WORKFLOW_PRIVATE_ENVELOPE_CLOSE
	].join('\n')
}

export function sameRelay(left: RelayIdentity | undefined, right: RelayIdentity): boolean {
	return Boolean(
		left &&
			left.instanceId === right.instanceId &&
			left.pid === right.pid &&
			left.processStartedAt === right.processStartedAt &&
			left.protocolVersion === right.protocolVersion
	)
}

export function activeResumePhase(
	run: WorkflowRunRecord
): Exclude<WorkflowPhase, 'blocked' | 'completed' | 'cancelled'> {
	if (run.phase === 'blocked') return run.blocked?.resumePhase ?? 'pending_root'
	if (isTerminalWorkflowPhase(run.phase)) {
		throw new WorkflowTransitionError(`Workflow ${run.id} is ${run.phase}`)
	}
	return run.phase
}

export function guardJobs(jobs: WorkflowJobRecord[]): WorkflowGuardJob[] {
	return jobs.map(job => ({
		role: job.role,
		cycle: job.cycle,
		status: job.state,
		...(isDeliveryReceipt(job.batonReceipt) ? { batonReceiptKind: job.batonReceipt.kind } : {})
	}))
}

export function actionOrdinal(jobs: WorkflowJobRecord[], role: WorkflowChildRoleName, cycle: number): number {
	const prefix = role === 'exploration' ? 'explore' : 'implement'
	let max = -1
	for (const job of jobs) {
		if (job.role !== role || job.cycle !== cycle) continue
		if (job.logicalKey === 'explore:0' && cycle === 0) max = Math.max(max, 0)
		const match = job.logicalKey.match(new RegExp(`^${prefix}:${cycle}:(\\d+)$`))
		if (match) max = Math.max(max, Number(match[1]))
	}
	return max + 1
}

export function effectGrant(effect: WorkflowEffectRecord): CapabilityGrant | null {
	if (!effect.inputs || typeof effect.inputs !== 'object') return null
	const grant = (effect.inputs as { grant?: Partial<CapabilityGrant> }).grant
	if (
		!grant ||
		(grant.phase !== 'exploring' && grant.phase !== 'planning' && grant.phase !== 'reviewing') ||
		!Number.isSafeInteger(grant.cycle) ||
		!Number.isSafeInteger(grant.revision) ||
		!Array.isArray(grant.allowedRoles) ||
		grant.allowedRoles.some(role => role !== 'exploration' && role !== 'implementation')
	) {
		return null
	}
	return grant as CapabilityGrant
}

export function assertWorkspaceReceipt(value: unknown): { workspaceId: string } {
	if (!value || typeof value !== 'object' || typeof (value as { workspaceId?: unknown }).workspaceId !== 'string') {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Workspace creation returned no exact workspace ID.')
	}
	return { workspaceId: (value as { workspaceId: string }).workspaceId }
}

export function assertSessionReceipt(value: unknown): { sessionId: string } {
	if (!value || typeof value !== 'object' || typeof (value as { sessionId?: unknown }).sessionId !== 'string') {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Child creation returned no exact session ID.')
	}
	return { sessionId: (value as { sessionId: string }).sessionId }
}

export function assertDeliveryReceipt(value: unknown): DeliveryReceipt {
	if (!isDeliveryReceipt(value)) {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Prompt delivery returned no tagged receipt.')
	}
	return value
}

/** DB roles originate exclusively in prepareWorkflowRun, whose effort union is narrower. */
export function promptRole(role: FrozenWorkflowRole): PromptRole {
	return role as unknown as PromptRole
}
