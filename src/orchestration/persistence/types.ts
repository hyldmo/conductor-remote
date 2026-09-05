import type { WorkflowPhase, WorkflowRunWire } from '../../wire.ts'
import type { FrozenWorkflowRole, FrozenWorkflowRoles } from '../workflow/prompts.ts'
import type {
	WorkflowAdoptionCandidate,
	WorkflowEffectState,
	WorkflowJobRole,
	WorkflowJobState,
	WorkflowRetryClass,
	WorkflowTarget
} from './schema.ts'

export const ORCHESTRATION_PROTOCOL_VERSION = 1

export interface ProcessIdentity {
	pid: number
	processStartedAt: string
}

export interface RelayIdentity extends ProcessIdentity {
	instanceId: string
	protocolVersion: number
}

/**
 * True when the exact PID/start identity is alive. For an external identity with
 * `processGroup`, implementations must also return true while any group member
 * remains alive; failure to prove the entire group dead must fail closed.
 */
export type ProcessProbe = (process: ProcessIdentity & { processGroup?: number }) => boolean

export interface WorkflowBlockedState {
	actionId: string
	errorCode: string
	message: string
	resumePhase: Exclude<WorkflowPhase, 'blocked' | 'completed' | 'cancelled'>
	retryClass: WorkflowRetryClass
	candidates?: WorkflowAdoptionCandidate[]
	blockedAt?: number
}

export interface WorkflowRunRecord {
	id: string
	objective: string
	target: WorkflowTarget
	roles: FrozenWorkflowRoles
	phase: WorkflowPhase
	cycle: number
	revision: number
	workspaceId?: string
	rootSessionId?: string
	pristineEvidence?: unknown
	deliveryBaseline?: unknown
	planningInterpretation?: string
	cancellationGeneration: number
	blocked?: WorkflowBlockedState
	implementationBatonsDelivered: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowJobRecord {
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
	owner?: RelayIdentity
	transcriptCursor?: unknown
	childSessionId?: string
	outcome?: unknown
	taskReceipt?: unknown
	batonReceipt?: unknown
	attemptCount: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowJobAttemptRecord {
	id: string
	jobId: string
	attemptNumber: number
	state: WorkflowJobState
	childSessionId?: string
	openEffectId?: string
	configureEffectId?: string
	taskEffectId?: string
	batonEffectId?: string
	outcome?: unknown
	failureEvidence?: unknown
	owner?: RelayIdentity
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowEffectRecord {
	id: string
	runId: string
	actionId: string
	jobId?: string
	kind: string
	state: WorkflowEffectState
	target?: unknown
	inputs?: unknown
	baseline?: unknown
	cursor?: unknown
	receipt?: unknown
	errorCode?: string
	errorMessage?: string
	owner?: RelayIdentity
	launchNonce?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	attemptCount: number
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowEffectAttemptRecord {
	id: string
	effectId: string
	attemptNumber: number
	state: WorkflowEffectState
	owner: RelayIdentity
	launchNonce?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	receipt?: unknown
	evidence?: unknown
	errorCode?: string
	errorMessage?: string
	createdAt: number
	updatedAt: number
	terminalAt?: number
}

export interface WorkflowCapabilityRecord {
	id: string
	tokenHash: string
	runId: string
	rootSessionId: string
	cycle: number
	phase: WorkflowPhase
	revision: number
	allowedRoles: WorkflowJobRole[]
	issuedWith?: { rowid: number; turnId?: string }
	consumedAt?: number
	revokedAt?: number
	createdAt: number
}

export interface WorkflowEventRecord {
	id: number
	runId: string
	eventKey: string
	type: string
	data?: unknown
	createdAt: number
}

export type WorkflowRunProjection = WorkflowRunWire

export interface RelayInstanceRecord extends RelayIdentity {
	canDriveUi: boolean
	heartbeatAt: number
	registeredAt: number
	metadata?: unknown
}

export interface UiLeaseOwner extends RelayIdentity {
	nonce: string
	actionId: string
	effectId?: string
	externalProcess?: ProcessIdentity & { processGroup?: number }
	mayExecute: boolean
	deadlineAt: number
	acquiredAt: number
	updatedAt: number
}

export interface UiLease {
	instanceId: string
	pid: number
	processStartedAt: string
	nonce: string
	actionId: string
	effectId?: string
}

export interface UiQuarantineRecord {
	active: boolean
	actionId?: string
	effectId?: string
	reason?: string
	owner?: RelayIdentity
	externalProcess?: ProcessIdentity & { processGroup?: number }
	createdAt?: number
	clearedAt?: number
	clearedBy?: string
}

export type AcquireUiLeaseResult =
	| { status: 'acquired'; lease: UiLease; reclaimed?: UiLeaseOwner }
	| { status: 'busy'; owner: UiLeaseOwner; reason: 'owner_alive' | 'external_process_alive' | 'changed' }
	| { status: 'quarantined'; quarantine: UiQuarantineRecord }

export type AbandonedEffectRecovery =
	| { status: 'owner_alive'; effect: WorkflowEffectRecord }
	| { status: 'external_process_alive'; effect: WorkflowEffectRecord }
	| { status: 'safely_prepared'; effect: WorkflowEffectRecord }
	| { status: 'ambiguous'; effect: WorkflowEffectRecord }
	| { status: 'unowned' | 'changed' | 'terminal'; effect: WorkflowEffectRecord }

export type AbandonedJobRecovery =
	| { status: 'owner_alive' | 'unsafe' | 'changed'; job: WorkflowJobRecord }
	| { status: 'requeued'; job: WorkflowJobRecord }

/** Structural match for `src/writes/ui-lock.ts` without coupling the coordinator to the actuator module. */
export interface OrchestrationSharedUiLeaseProvider {
	acquire(request: { priority: 'interactive' | 'background'; actionId?: string }): Promise<{
		markMayExecute(externalProcess?: ProcessIdentity & { processGroup?: number }): void | Promise<void>
		release(): void | Promise<void>
	}>
}

export interface OrchestrationDbOptions {
	now?: () => number
	processProbe?: ProcessProbe
	busyTimeoutMs?: number
	scrubPublicText?: (text: string) => string
}
