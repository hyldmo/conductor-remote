import type { CachedModelGroup } from '../../agents/model-cache.ts'
import type { RoleStoreRead } from '../../agents/roles.ts'
import type { DeliveryReceipt } from '../../reads/types.ts'
import type { DelegationErrorCode, RolesConfig, WorkflowChildRoleName } from '../../wire.ts'
import type {
	FrozenWorkflowRole,
	OrchestrationDb,
	RelayIdentity,
	WorkflowAdoptionCandidate,
	WorkflowEffectRecord,
	WorkflowJobRecord,
	WorkflowRetryClass,
	WorkflowRunProjection,
	WorkflowRunRecord,
	WorkflowTarget
} from '../persistence/db.ts'
import type { WorkflowExternalProcess } from './effect-runner.ts'
import type { workflowChildPrompt } from './prompts.ts'

export interface WorkflowDeliveryCursor {
	rowid: number
	outboxIds: readonly string[]
}

export interface WorkflowRootInspection {
	workspaceId: string
	rootSessionId: string
	pristine: boolean
	pristineEvidence: unknown
	deliveryCursor: WorkflowDeliveryCursor
	reason?: string
}

export type WorkflowChildOutcome =
	| {
			kind: 'success'
			baton: string
			/** Absent only in outcomes saved by relays predating full reports. */
			text?: string
			assistantRowid?: number
			evidence?: unknown
	  }
	| {
			kind: 'failure'
			code: string
			message: string
			retryClass?: Extract<WorkflowRetryClass, 'deterministic' | 'terminal'>
			evidence?: unknown
	  }

export type WorkflowEffectReconciliation =
	| { status: 'committed'; receipt: unknown }
	| { status: 'pending' }
	| { status: 'ambiguous'; candidates?: WorkflowAdoptionCandidate[]; evidence?: unknown }

export type WorkflowDeliveryResolution =
	| { status: 'pending' }
	| { status: 'delivered'; receipt: Extract<DeliveryReceipt, { kind: 'message' }> }
	| { status: 'lost'; evidence?: unknown }

export type WorkflowEffectDispatchMode = 'in_process' | 'gated_child'

export interface WorkflowEffectDispatch {
	mode: WorkflowEffectDispatchMode
	/** Passed directly to runGatedWorkflowCommand.onSpawned. */
	gatedProcessReady(process: WorkflowExternalProcess): Promise<void>
}

export interface WorkflowEffectReadCall {
	run: WorkflowRunRecord
	effect: WorkflowEffectRecord
	job?: WorkflowJobRecord
	correlationMarker: string
}

export interface WorkflowEffectCall extends WorkflowEffectReadCall {
	dispatch: WorkflowEffectDispatch
}

export interface WorkflowBlockNotice {
	run: WorkflowRunRecord
	eventId: number
	action: string
	recovery: string
}

export interface WorkflowCoordinatorDeps {
	notifyBlocked?(notice: WorkflowBlockNotice): Promise<void>
	/** A single queued UI send; the adapter must recheck the block and shared UI hold. */
	sendBlockedNotice?(notice: WorkflowBlockNotice): Promise<void>
	/** Snapshot before a new-workspace deep link. It is persisted with the create intent. */
	captureWorkspaceBaseline(repo: string): Promise<unknown>
	/** Read-only validation of an explicitly selected existing root. */
	inspectExistingRoot(
		target: Extract<WorkflowTarget, { kind: 'existing_session' }>
	): Promise<WorkflowRootInspection | null>
	/** Read-only lookup of the first exact session in a workspace created by this run. */
	bindCreatedRoot(input: { run: WorkflowRunRecord; workspaceId: string }): Promise<WorkflowRootInspection | null>
	/** GUI adapters must eventually enter writes.uiTurn; the coordinator supplies its dispatch hook. */
	createWorkspace(input: WorkflowEffectCall & { target: Extract<WorkflowTarget, { kind: 'new_workspace' }> }): Promise<{
		workspaceId: string
	}>
	configureSession(input: WorkflowEffectCall & { sessionId: string; role: FrozenWorkflowRole }): Promise<unknown>
	openChild(input: WorkflowEffectCall & { job: WorkflowJobRecord }): Promise<{ sessionId: string }>
	/** Exact set/snapshot used to correlate an open-child result after a crash. */
	captureSessionBaseline(workspaceId: string): Promise<unknown>
	captureDeliveryCursor(sessionId: string): Promise<WorkflowDeliveryCursor>
	captureTranscriptCursor?(sessionId: string): Promise<unknown>
	materializeHandoff?(input: { run: WorkflowRunRecord; job: WorkflowJobRecord }): Promise<string | undefined>
	materializeReport(input: {
		run: WorkflowRunRecord
		job: WorkflowJobRecord
		outcome: Extract<WorkflowChildOutcome, { kind: 'success' }>
	}): Promise<string>
	sendPrompt(input: WorkflowEffectCall & { sessionId: string; text: string }): Promise<DeliveryReceipt>
	returnBaton(
		input: WorkflowEffectCall & { job: WorkflowJobRecord; sessionId: string; text: string }
	): Promise<DeliveryReceipt>
	resolveDeliveryReceipt(
		input: WorkflowEffectReadCall & {
			sessionId: string
			receipt: DeliveryReceipt
		}
	): Promise<WorkflowDeliveryResolution>
	readChildOutcome(input: { run: WorkflowRunRecord; job: WorkflowJobRecord }): Promise<WorkflowChildOutcome | null>
	/** Read-only invariant check after both UI locks are held but before the durable dispatch boundary. */
	validateBeforeDispatch?(input: WorkflowEffectReadCall): Promise<void>
	/** Positive reconciliation or explicit ambiguity; a negative read is represented by pending. */
	reconcileEffect?(input: WorkflowEffectReadCall): Promise<WorkflowEffectReconciliation>
	/** Revalidate a phone-selected saved candidate and return the positive effect receipt. */
	validateAdoption?(input: {
		run: WorkflowRunRecord
		effect: WorkflowEffectRecord
		candidate: WorkflowAdoptionCandidate
	}): Promise<unknown | null>
	/** Must enumerate live UI-capable relay processes, including unregistered older binaries. */
	assertCompatibleRelays?(): Promise<void>
	/** Gated mode leaves mayExecute=false until dispatch.gatedProcessReady commits. */
	dispatchMode?(effect: WorkflowEffectRecord): WorkflowEffectDispatchMode
}

export interface WorkflowCoordinatorStartInput {
	clientId: string
	objective: string
	target: WorkflowTarget
	roles: RolesConfig | RoleStoreRead
	modelGroups: CachedModelGroup[]
}

export interface WorkflowDelegateInput {
	clientId: string
	workflowId: string
	sessionId: string
	phaseCapability: string
	role: WorkflowChildRoleName
	task: string
	planningInterpretation?: string
}

export interface WorkflowRecoveryInput {
	clientId: string
	workflowId: string
	actionId: string
}

export interface WorkflowRetryInput {
	clientId: string
	workflowId: string
}

export interface WorkflowAdoptInput extends WorkflowRecoveryInput {
	candidateId: string
}

export interface WorkflowReplayInput extends WorkflowRecoveryInput {
	confirmDuplicateRisk: true
}

export interface WorkflowRunMutationInput {
	clientId: string
	workflowId: string
}

export interface WorkflowStartResult {
	replayed: boolean
	workflow: WorkflowRunProjection
}

export interface WorkflowDelegationResult extends WorkflowStartResult {
	job: WorkflowJobRecord
}

export interface WorkflowMutationResult extends WorkflowStartResult {}

export type WorkflowCoordinatorErrorCode =
	| DelegationErrorCode
	| 'workflow_not_found'
	| 'workflow_root_not_pristine'
	| 'workflow_effect_failed'
	| 'workflow_effect_ambiguous'
	| 'workflow_recovery_invalid'
	| 'workflow_adapter_invalid'
	| 'workflow_incompatible_relay'
	| 'workflow_role_verification_failed'

export interface CapabilityGrant {
	phase: 'exploring' | 'planning' | 'reviewing'
	cycle: number
	revision: number
	allowedRoles: WorkflowChildRoleName[]
}

export interface DurableEffectOptions<T> {
	run: WorkflowRunRecord
	effect: WorkflowEffectRecord
	job?: WorkflowJobRecord
	capabilityGrant?: CapabilityGrant
	execute: (capabilityToken: string | undefined, dispatch: WorkflowEffectDispatch) => Promise<T>
	validate: (result: T) => unknown
}

export interface DurableEffectResult {
	effect: WorkflowEffectRecord
	changed: boolean
}

export type PromptRole = Parameters<typeof workflowChildPrompt>[0]['role']

export interface WorkflowContext {
	readonly db: OrchestrationDb
	readonly relay: RelayIdentity
	readonly deps: WorkflowCoordinatorDeps
	readonly waking: Map<string, Promise<WorkflowRunProjection>>
}
