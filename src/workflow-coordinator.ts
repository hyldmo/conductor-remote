import { randomBytes, randomUUID } from 'node:crypto'
import type { CachedModelGroup } from './model-cache.ts'
import {
	type FrozenWorkflowRole,
	hashCapabilityToken,
	type OrchestrationDb,
	type RelayIdentity,
	type WorkflowAdoptionCandidate,
	type WorkflowEffectRecord,
	type WorkflowJobRecord,
	type WorkflowPhase,
	type WorkflowRetryClass,
	type WorkflowRunProjection,
	type WorkflowRunRecord,
	type WorkflowTarget,
	WorkflowTransitionError
} from './orchestration-db.ts'
import type { DeliveryReceipt } from './reads.ts'
import type { RoleStoreRead } from './roles.ts'
import {
	scrubWorkflowSecrets,
	WORKFLOW_PRIVATE_ENVELOPE_CLOSE,
	WORKFLOW_PRIVATE_ENVELOPE_OPEN,
	workflowCapabilityToken,
	workflowPrivateEnvelope
} from './shared.ts'
import type { DelegationErrorCode, RolesConfig, WorkflowChildRoleName } from './wire.ts'
import { prepareWorkflowRun, workflowBootstrapPrompt, workflowChildPrompt, workflowRootPrompt } from './workflow.ts'
import type { WorkflowExternalProcess } from './workflow-effect-runner.ts'
import {
	assertWorkflowDelegation,
	isTerminalWorkflowJobState,
	isTerminalWorkflowPhase,
	phaseAfterDeliveredBaton,
	type WorkflowCapabilityClaims,
	type WorkflowGuardJob,
	workflowDelegationTransition
} from './workflow-machine.ts'
import { withUiDispatchHook, withUiPriority } from './writes.ts'

const MAX_WAKE_STEPS = 64

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
	| { kind: 'success'; baton: string; evidence?: unknown }
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

export interface WorkflowCoordinatorDeps {
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

export class WorkflowCoordinatorError extends Error {
	readonly code: WorkflowCoordinatorErrorCode
	readonly status: 400 | 404 | 409 | 503
	readonly retryable: boolean

	constructor(
		code: WorkflowCoordinatorErrorCode,
		message: string,
		options: { status?: 400 | 404 | 409 | 503; retryable?: boolean } = {}
	) {
		super(scrubWorkflowSecrets(message))
		this.name = 'WorkflowCoordinatorError'
		this.code = code
		this.status = options.status ?? 409
		this.retryable = options.retryable ?? false
	}
}

interface CapabilityGrant {
	phase: 'exploring' | 'planning' | 'reviewing'
	cycle: number
	revision: number
	allowedRoles: WorkflowChildRoleName[]
}

interface DurableEffectOptions<T> {
	run: WorkflowRunRecord
	effect: WorkflowEffectRecord
	job?: WorkflowJobRecord
	capabilityGrant?: CapabilityGrant
	execute: (capabilityToken: string | undefined, dispatch: WorkflowEffectDispatch) => Promise<T>
	validate: (result: T) => unknown
}

interface DurableEffectResult {
	effect: WorkflowEffectRecord
	changed: boolean
}

function cleanUnknown(value: unknown, depth = 0): unknown {
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

function errorMessage(error: unknown): string {
	return scrubWorkflowSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function errorCode(error: unknown, fallback: string): string {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
		return scrubWorkflowSecrets(error.code).slice(0, 100)
	}
	return fallback
}

function preExecutionRetryClass(error: unknown): WorkflowRetryClass {
	return errorCode(error, 'workflow_effect_failed') === 'workflow_root_not_pristine' ? 'terminal' : 'deterministic'
}

function sanitizeChildOutcome(outcome: WorkflowChildOutcome): WorkflowChildOutcome {
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

function isDeliveryReceipt(value: unknown): value is DeliveryReceipt {
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

function messageReceipt(
	resolution: WorkflowDeliveryResolution,
	expectedId: string
): Extract<DeliveryReceipt, { kind: 'message' }> | null {
	if (resolution.status !== 'delivered' || resolution.receipt.id !== expectedId) return null
	return resolution.receipt
}

function effectSessionId(effect: WorkflowEffectRecord): string | undefined {
	if (!effect.target || typeof effect.target !== 'object') return undefined
	const sessionId = (effect.target as { sessionId?: unknown }).sessionId
	return typeof sessionId === 'string' && sessionId ? sessionId : undefined
}

function receiptEventSuffix(receipt: unknown, fallback: string): string {
	return isDeliveryReceipt(receipt) ? `${receipt.kind}:${receipt.id}` : fallback
}

/** Stable, non-secret evidence used to match an orphaned external effect. */
export function workflowEffectCorrelationMarker(runId: string, actionId: string): string {
	return `[conductor-remote workflow:${runId} action:${actionId}]`
}

/** Raw Conductor sees the marker; every scrubbed transcript surface removes it. */
function privateCorrelationBlock(runId: string, actionId: string): string {
	return [
		WORKFLOW_PRIVATE_ENVELOPE_OPEN,
		workflowEffectCorrelationMarker(runId, actionId),
		WORKFLOW_PRIVATE_ENVELOPE_CLOSE
	].join('\n')
}

function sameRelay(left: RelayIdentity | undefined, right: RelayIdentity): boolean {
	return Boolean(
		left &&
			left.instanceId === right.instanceId &&
			left.pid === right.pid &&
			left.processStartedAt === right.processStartedAt &&
			left.protocolVersion === right.protocolVersion
	)
}

function activeResumePhase(run: WorkflowRunRecord): Exclude<WorkflowPhase, 'blocked' | 'completed' | 'cancelled'> {
	if (run.phase === 'blocked') return run.blocked?.resumePhase ?? 'pending_root'
	if (isTerminalWorkflowPhase(run.phase)) {
		throw new WorkflowTransitionError(`Workflow ${run.id} is ${run.phase}`)
	}
	return run.phase
}

function guardJobs(jobs: WorkflowJobRecord[]): WorkflowGuardJob[] {
	return jobs.map(job => ({
		role: job.role,
		cycle: job.cycle,
		status: job.state,
		...(isDeliveryReceipt(job.batonReceipt) ? { batonReceiptKind: job.batonReceipt.kind } : {})
	}))
}

function actionOrdinal(jobs: WorkflowJobRecord[], role: WorkflowChildRoleName, cycle: number): number {
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

function effectGrant(effect: WorkflowEffectRecord): CapabilityGrant | null {
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

function assertWorkspaceReceipt(value: unknown): { workspaceId: string } {
	if (!value || typeof value !== 'object' || typeof (value as { workspaceId?: unknown }).workspaceId !== 'string') {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Workspace creation returned no exact workspace ID.')
	}
	return { workspaceId: (value as { workspaceId: string }).workspaceId }
}

function assertSessionReceipt(value: unknown): { sessionId: string } {
	if (!value || typeof value !== 'object' || typeof (value as { sessionId?: unknown }).sessionId !== 'string') {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Child creation returned no exact session ID.')
	}
	return { sessionId: (value as { sessionId: string }).sessionId }
}

function assertDeliveryReceipt(value: unknown): DeliveryReceipt {
	if (!isDeliveryReceipt(value)) {
		throw new WorkflowCoordinatorError('workflow_adapter_invalid', 'Prompt delivery returned no tagged receipt.')
	}
	return value
}

type PromptRole = Parameters<typeof workflowChildPrompt>[0]['role']

/** DB roles originate exclusively in prepareWorkflowRun, whose effort union is narrower. */
function promptRole(role: FrozenWorkflowRole): PromptRole {
	return role as unknown as PromptRole
}

export class WorkflowCoordinator {
	private readonly waking = new Map<string, Promise<WorkflowRunProjection>>()
	private readonly db: OrchestrationDb
	private readonly relay: RelayIdentity
	private readonly deps: WorkflowCoordinatorDeps

	constructor(db: OrchestrationDb, relay: RelayIdentity, deps: WorkflowCoordinatorDeps) {
		this.db = db
		this.relay = relay
		this.deps = deps
		this.db.registerRelayInstance({ ...relay, canDriveUi: true })
	}

	async start(input: WorkflowCoordinatorStartInput): Promise<WorkflowStartResult> {
		const replay = this.db.getIdempotentMutation<{ runId: string }>('start_workflow', input.clientId, {
			objective: input.objective,
			target: input.target
		})
		if (replay) return { replayed: true, workflow: this.projection(replay.result.runId) }
		this.heartbeat()
		await this.assertCompatible()
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
			inspection = await this.deps.inspectExistingRoot(input.target)
			if (!inspection) {
				throw new WorkflowCoordinatorError('workflow_not_found', 'The selected Workflow root no longer exists.', {
					status: 404
				})
			}
			if (inspection.workspaceId !== input.target.workspaceId || inspection.rootSessionId !== input.target.sessionId) {
				throw new WorkflowCoordinatorError(
					'workflow_not_found',
					'The root inspection did not match the selected chat.',
					{
						status: 404
					}
				)
			}
			if (!inspection.pristine) {
				throw new WorkflowCoordinatorError(
					'workflow_root_not_pristine',
					inspection.reason ?? 'Workflow requires a pristine root chat.',
					{ status: 409 }
				)
			}
		} else {
			baseline = cleanUnknown(await this.deps.captureWorkspaceBaseline(input.target.repo))
		}

		const accepted = this.db.createWorkflowRun({
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
		return { replayed: accepted.replayed, workflow: this.projection(accepted.run.id) }
	}

	wake(runId: string): Promise<WorkflowRunProjection> {
		const existing = this.waking.get(runId)
		if (existing) return existing
		const running = this.wakeInternal(runId).finally(() => this.waking.delete(runId))
		this.waking.set(runId, running)
		return running
	}

	private async wakeInternal(runId: string): Promise<WorkflowRunProjection> {
		this.heartbeat()
		for (let step = 0; step < MAX_WAKE_STEPS; step++) {
			const run = this.requireRun(runId)
			if (run.phase === 'cancelled') {
				await this.observeCancelledRun(run)
				break
			}
			if (run.phase === 'completed') break
			if (run.phase === 'blocked') {
				if (await this.reconcileBlockedEffect(run)) continue
				break
			}
			try {
				await this.assertCompatible()
			} catch (error) {
				this.blockRun(run, {
					actionId: `compatibility:${run.id}`,
					errorCode: 'workflow_incompatible_relay',
					message: errorMessage(error),
					retryClass: 'deterministic'
				})
				break
			}
			let changed = false
			try {
				changed = await this.driveOnce(run)
			} catch (error) {
				if (error instanceof WorkflowTransitionError) {
					const current = this.requireRun(runId)
					if (current.phase !== run.phase || current.cancellationGeneration !== run.cancellationGeneration) continue
				}
				throw error
			}
			if (!changed) break
		}
		return this.projection(runId)
	}

	private async observeCancelledRun(run: WorkflowRunRecord): Promise<void> {
		const observedEffects = new Map(this.db.listWorkflowEffects(run.id).map(effect => [effect.id, effect]))
		for (const observed of observedEffects.values()) {
			let effect = observed
			const sessionId = effectSessionId(effect)
			if (sessionId && isDeliveryReceipt(effect.receipt) && effect.receipt.kind === 'outbox') {
				const resolution = await this.deps.resolveDeliveryReceipt({
					...this.effectReadCall(run, effect),
					sessionId,
					receipt: effect.receipt
				})
				if (resolution.status === 'lost') {
					this.markReceiptLost(run, effect, resolution.evidence)
					continue
				}
				if (resolution.status === 'delivered' && resolution.receipt.id === effect.receipt.id) {
					effect = this.db.recordLateWorkflowEffect({
						runId: run.id,
						actionId: effect.actionId,
						receipt: resolution.receipt,
						eventKey: `late-effect:${effect.actionId}:message:${resolution.receipt.id}`
					})
					observedEffects.set(effect.id, effect)
				}
			}
			if (effect.state !== 'dispatched' && effect.state !== 'ambiguous') continue
			const reconciliation = await this.deps.reconcileEffect?.(this.effectReadCall(run, effect))
			if (reconciliation?.status === 'committed') {
				const receipt = cleanUnknown(reconciliation.receipt)
				effect = this.db.recordLateWorkflowEffect({
					runId: run.id,
					actionId: effect.actionId,
					receipt,
					eventKey: `late-effect:${effect.actionId}:${receiptEventSuffix(receipt, `attempt:${effect.attemptCount}`)}`
				})
				observedEffects.set(effect.id, effect)
				continue
			}
			if (effect.state === 'dispatched' && effect.mayExecute) {
				const recovery = this.db.reconcileAbandonedWorkflowEffect({
					runId: run.id,
					actionId: effect.actionId,
					eventKey: `late-effect-recovery:${effect.actionId}:${effect.attemptCount}`
				})
				if (recovery.status !== 'ambiguous') continue
				const ambiguous = recovery.effect
				this.db.activateUiQuarantine({
					actionId: ambiguous.actionId,
					effectId: ambiguous.id,
					reason: ambiguous.errorMessage ?? 'A cancelled Workflow effect remains ambiguous.',
					owner: ambiguous.owner,
					externalProcess: ambiguous.externalProcess
				})
			}
		}

		for (const job of this.db.listWorkflowJobs(run.id)) {
			if (job.state !== 'cancelled' || !job.childSessionId || job.outcome !== undefined) continue
			const taskEffect = [...observedEffects.values()].find(
				effect => effect.jobId === job.id && effect.kind === 'send_task'
			)
			const taskReceipt =
				isDeliveryReceipt(job.taskReceipt) && job.taskReceipt.kind === 'message'
					? job.taskReceipt
					: isDeliveryReceipt(taskEffect?.receipt) && taskEffect.receipt.kind === 'message'
						? taskEffect.receipt
						: undefined
			if (!taskReceipt) continue
			const outcome = await this.deps.readChildOutcome({
				run,
				job: job.taskReceipt === taskReceipt ? job : { ...job, taskReceipt }
			})
			if (!outcome) continue
			this.db.recordLateWorkflowChildResult({
				runId: run.id,
				jobId: job.id,
				attemptNumber: job.attemptCount,
				outcome: sanitizeChildOutcome(outcome),
				eventKey: `late-child:${job.id}:${job.attemptCount}`
			})
		}
	}

	private async driveOnce(run: WorkflowRunRecord): Promise<boolean> {
		if (run.phase === 'creating_workspace') return this.driveWorkspaceCreation(run)
		if (run.phase === 'binding_root') return this.driveRootBinding(run)
		if (run.phase === 'pending_root') return this.drivePendingRoot(run)
		if (
			run.phase === 'exploring' ||
			run.phase === 'planning' ||
			run.phase === 'implementing' ||
			run.phase === 'reviewing'
		) {
			if (await this.drivePhaseAuthorization(run)) return true
			if (this.advanceDeliveredBarrier(run)) return true
			if (run.phase === 'planning' || run.phase === 'reviewing') return false
			return this.driveNextJob(run)
		}
		return false
	}

	private async driveWorkspaceCreation(run: WorkflowRunRecord): Promise<boolean> {
		const effect = this.requireEffect(run.id, 'create-workspace')
		const result = await this.runDurableEffect({
			run,
			effect,
			execute: (_token, dispatch) =>
				this.deps.createWorkspace({
					...this.effectCall(run, effect, dispatch),
					target: run.target as Extract<WorkflowTarget, { kind: 'new_workspace' }>
				}),
			validate: assertWorkspaceReceipt
		})
		const committed = result.effect.state === 'committed' ? result.effect : this.requireEffect(run.id, effect.actionId)
		if (committed.state !== 'committed') return result.changed
		const receipt = assertWorkspaceReceipt(committed.receipt)
		const fresh = this.requireRun(run.id)
		if (fresh.phase !== 'creating_workspace') return true
		this.db.transitionWorkflowRun({
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

	private async driveRootBinding(run: WorkflowRunRecord): Promise<boolean> {
		if (!run.workspaceId) throw new WorkflowTransitionError(`Workflow ${run.id} has no created workspace binding`)
		const inspection = await this.deps.bindCreatedRoot({ run, workspaceId: run.workspaceId })
		if (!inspection) return false
		if (inspection.workspaceId !== run.workspaceId) {
			this.blockRun(run, {
				actionId: 'bind-root',
				errorCode: 'workflow_root_mismatch',
				message: 'The discovered root did not belong to the exact created workspace.',
				retryClass: 'terminal'
			})
			return true
		}
		if (!inspection.pristine) {
			this.blockRun(run, {
				actionId: 'bind-root',
				errorCode: 'workflow_root_not_pristine',
				message: inspection.reason ?? 'The created root chat is no longer pristine.',
				retryClass: 'terminal'
			})
			return true
		}
		this.db.idempotentMutation(
			'bind_workflow_root',
			`${run.id}:${inspection.workspaceId}:${inspection.rootSessionId}`,
			{
				workspaceId: inspection.workspaceId,
				rootSessionId: inspection.rootSessionId,
				pristineEvidence: cleanUnknown(inspection.pristineEvidence),
				deliveryCursor: inspection.deliveryCursor
			},
			() => {
				this.db.transitionWorkflowRun({
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
				this.prepareRootEffects(this.requireRun(run.id), inspection.deliveryCursor)
				return { runId: run.id }
			},
			{ runId: run.id }
		)
		return true
	}

	private prepareRootEffects(run: WorkflowRunRecord, cursor: WorkflowDeliveryCursor): void {
		if (!run.workspaceId || !run.rootSessionId) throw new WorkflowTransitionError('Workflow root is not fully bound')
		this.db.prepareWorkflowEffect({
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
		this.db.prepareWorkflowEffect({
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

	private async drivePendingRoot(run: WorkflowRunRecord): Promise<boolean> {
		if (!run.rootSessionId || !run.workspaceId) throw new WorkflowTransitionError('pending root is not bound')
		let configure = this.db.getWorkflowEffect(run.id, 'configure-root')
		let send = this.db.getWorkflowEffect(run.id, 'send-root')
		if (!configure || !send) {
			this.prepareRootEffects(run, run.deliveryBaseline as WorkflowDeliveryCursor)
			configure = this.requireEffect(run.id, 'configure-root')
			send = this.requireEffect(run.id, 'send-root')
		}
		if (configure.state !== 'committed') {
			const result = await this.runDurableEffect({
				run,
				effect: configure,
				execute: (_token, dispatch) =>
					this.deps.configureSession({
						...this.effectCall(run, configure as WorkflowEffectRecord, dispatch),
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
			const result = await this.runDurableEffect({
				run,
				effect: send,
				capabilityGrant: grant,
				execute: (token, dispatch) =>
					this.deps.sendPrompt({
						...this.effectCall(run, send as WorkflowEffectRecord, dispatch),
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
			return (await this.activateRootFromReceipt(run, result.effect)) || result.changed
		}
		return this.activateRootFromReceipt(run, send)
	}

	private async activateRootFromReceipt(run: WorkflowRunRecord, effect: WorkflowEffectRecord): Promise<boolean> {
		if (!run.rootSessionId || !isDeliveryReceipt(effect.receipt)) return false
		const resolution = await this.deps.resolveDeliveryReceipt({
			...this.effectReadCall(run, effect),
			sessionId: run.rootSessionId,
			receipt: effect.receipt
		})
		if (resolution.status === 'lost') {
			this.markReceiptLost(run, effect, resolution.evidence)
			return true
		}
		const resolved = messageReceipt(resolution, effect.receipt.id)
		if (!resolved) return false
		if (!effect.launchNonce || !/^[a-f\d]{64}$/i.test(effect.launchNonce)) {
			throw new WorkflowTransitionError('delivered root effect has no capability hash')
		}
		this.db.idempotentMutation(
			'activate_workflow_root',
			`${run.id}:${resolved.id}`,
			{ receipt: resolved, tokenHash: effect.launchNonce },
			() => {
				const current = this.requireRun(run.id)
				if (current.phase !== 'pending_root') return { runId: run.id }
				const exploring = this.db.transitionWorkflowRun({
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
				this.db.issueWorkflowCapability({
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
				this.db.activateWorkflowJob(
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

	private async drivePhaseAuthorization(run: WorkflowRunRecord): Promise<boolean> {
		if (run.phase !== 'exploring' || !run.rootSessionId) return false
		const actionId = `authorize:exploring:${run.cycle}:${run.revision}`
		const effect = this.db.getWorkflowEffect(run.id, actionId)
		if (!effect) return false
		const grant = effectGrant(effect)
		if (!grant) throw new WorkflowTransitionError(`authorization effect ${actionId} has invalid grant inputs`)
		let current = effect
		let changed = false
		if (effect.state !== 'committed') {
			const result = await this.runDurableEffect({
				run,
				effect,
				capabilityGrant: grant,
				execute: (token, dispatch) =>
					this.deps.sendPrompt({
						...this.effectCall(run, effect, dispatch),
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
		const resolution = await this.deps.resolveDeliveryReceipt({
			...this.effectReadCall(run, current),
			sessionId: run.rootSessionId,
			receipt: current.receipt
		})
		if (resolution.status === 'lost') {
			this.markReceiptLost(run, current, resolution.evidence)
			return true
		}
		const receipt = messageReceipt(resolution, current.receipt.id)
		if (!receipt) return changed
		if (!current.launchNonce) throw new WorkflowTransitionError('authorization effect has no capability hash')
		const fresh = this.requireRun(run.id)
		if (fresh.phase !== grant.phase || fresh.cycle !== grant.cycle || fresh.revision !== grant.revision) return changed
		const issuance = this.db.idempotentMutation(
			'issue_workflow_phase_capability',
			`${run.id}:${current.actionId}:${receipt.id}`,
			{ actionId: current.actionId, receipt, tokenHash: current.launchNonce },
			() => {
				this.db.issueWorkflowCapability({
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

	private async driveNextJob(run: WorkflowRunRecord): Promise<boolean> {
		let jobs = this.db
			.listWorkflowJobs(run.id)
			.filter(
				job => job.cycle === run.cycle && job.role === (run.phase === 'exploring' ? 'exploration' : 'implementation')
			)
		const queued = jobs.find(job => job.state === 'queued')
		if (queued) return Boolean(this.db.claimNextWorkflowJob(this.relay, run.id))
		const owned = jobs.find(job => job.state === 'owned')
		if (owned) {
			if (!sameRelay(owned.owner, this.relay)) {
				const recovered = this.db.reconcileAbandonedWorkflowJobClaim({
					jobId: owned.id,
					eventKey: `recover-job-claim:${owned.id}:${owned.attemptCount}`
				})
				return recovered.status === 'requeued'
			}
			await this.beginJobAttempt(run, owned)
			return true
		}
		jobs = this.db.listWorkflowJobs(run.id).filter(job => job.cycle === run.cycle)
		for (const active of jobs.filter(job => !isTerminalWorkflowJobState(job.state) && job.state !== 'dormant')) {
			if (await this.driveJob(run, active)) return true
		}
		return false
	}

	private async beginJobAttempt(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<void> {
		if (!run.workspaceId) throw new WorkflowTransitionError(`Workflow ${run.id} has no workspace for child creation`)
		const sessionBaseline = cleanUnknown(await this.deps.captureSessionBaseline(run.workspaceId))
		const latest = this.db.getWorkflowJob(job.id)
		if (latest?.state !== 'owned' || !sameRelay(latest.owner, this.relay)) return
		const attemptNumber = job.attemptCount + 1
		const openAction = `${job.id}:open:${attemptNumber}`
		const configureAction = `${job.id}:configure:${attemptNumber}`
		const taskAction = `${job.id}:task:${attemptNumber}`
		const batonAction = `${job.id}:baton:${attemptNumber}`
		this.db.idempotentMutation(
			'begin_workflow_job_attempt',
			`${run.id}:${job.id}:${attemptNumber}`,
			{ jobId: job.id, attemptNumber, openAction, sessionBaseline },
			() => {
				this.db.createWorkflowJobAttempt({
					jobId: job.id,
					owner: this.relay,
					state: 'opening',
					effectIds: {
						open: `${run.id}:${openAction}`,
						configure: `${run.id}:${configureAction}`,
						task: `${run.id}:${taskAction}`,
						baton: `${run.id}:${batonAction}`
					}
				})
				this.db.prepareWorkflowEffect({
					id: `${run.id}:${openAction}`,
					runId: run.id,
					actionId: openAction,
					kind: 'open_child',
					jobId: job.id,
					target: { workspaceId: run.workspaceId, rootSessionId: run.rootSessionId },
					inputs: { correlationMarker: workflowEffectCorrelationMarker(run.id, openAction) },
					baseline: sessionBaseline,
					expectedCancellationGeneration: run.cancellationGeneration,
					eventKey: `prepare:${openAction}`
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['owned'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'opening',
					eventKey: `job-opening:${job.id}:${attemptNumber}`,
					eventType: 'workflow_job_opening'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId: openAction }
		)
	}

	private async driveJob(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		if (job.state === 'opening') return this.driveJobOpen(run, job)
		if (job.state === 'configuring') return this.driveJobConfigure(run, job)
		if (job.state === 'sending') return this.driveJobSend(run, job)
		if (job.state === 'running') return this.driveJobOutcome(run, job)
		if (job.state === 'returning') return this.driveJobBaton(run, job)
		return false
	}

	private async driveJobOpen(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		const actionId = `${job.id}:open:${job.attemptCount}`
		const effect = this.requireEffect(run.id, actionId)
		const result = await this.runDurableEffect({
			run,
			effect,
			job,
			execute: (_token, dispatch) => this.deps.openChild({ ...this.effectCall(run, effect, dispatch, job), job }),
			validate: assertSessionReceipt
		})
		const current = result.effect.state === 'committed' ? result.effect : this.requireEffect(run.id, actionId)
		if (current.state !== 'committed') return result.changed
		const receipt = assertSessionReceipt(current.receipt)
		const freshJob = this.db.getWorkflowJob(job.id)
		if (freshJob?.state !== 'opening') return true
		this.db.idempotentMutation(
			'workflow_job_opened',
			`${job.id}:${job.attemptCount}:${receipt.sessionId}`,
			receipt,
			() => {
				this.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'opening',
					state: 'configuring',
					childSessionId: receipt.sessionId,
					eventKey: `attempt-configuring:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_configuring'
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['opening'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'configuring',
					childSessionId: receipt.sessionId,
					eventKey: `job-configuring:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_configuring'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId }
		)
		return true
	}

	private async driveJobConfigure(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		if (!job.childSessionId) throw new WorkflowTransitionError(`job ${job.id} is configuring without a child`)
		const actionId = `${job.id}:configure:${job.attemptCount}`
		let effect = this.db.getWorkflowEffect(run.id, actionId)
		if (!effect) {
			effect = this.db.prepareWorkflowEffect({
				id: `${run.id}:${actionId}`,
				runId: run.id,
				actionId,
				kind: 'configure_child',
				jobId: job.id,
				target: { sessionId: job.childSessionId },
				inputs: {
					role: job.resolvedRole,
					correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
				},
				expectedCancellationGeneration: run.cancellationGeneration,
				eventKey: `prepare:${actionId}`
			}).effect
		}
		const result = await this.runDurableEffect({
			run,
			effect,
			job,
			execute: (_token, dispatch) =>
				this.deps.configureSession({
					...this.effectCall(run, effect as WorkflowEffectRecord, dispatch, job),
					sessionId: job.childSessionId as string,
					role: job.resolvedRole
				}),
			validate: value => cleanUnknown(value ?? { matched: true })
		})
		const current = result.effect.state === 'committed' ? result.effect : this.requireEffect(run.id, actionId)
		if (current.state !== 'committed') return result.changed
		const freshJob = this.db.getWorkflowJob(job.id)
		if (freshJob?.state !== 'configuring') return true
		const taskAction = `${job.id}:task:${job.attemptCount}`
		const existingTask = this.db.getWorkflowEffect(run.id, taskAction)
		if (existingTask) {
			if (existingTask.kind !== 'send_task' || existingTask.jobId !== job.id) {
				throw new WorkflowTransitionError(`task effect ${taskAction} does not match job ${job.id}`)
			}
			const prompt =
				existingTask.inputs &&
				typeof existingTask.inputs === 'object' &&
				typeof (existingTask.inputs as { prompt?: unknown }).prompt === 'string'
					? (existingTask.inputs as { prompt: string }).prompt
					: undefined
			if (!prompt) throw new WorkflowTransitionError(`task effect ${taskAction} has no frozen prompt`)
			this.finishJobConfiguration(run, job, taskAction, existingTask.cursor, prompt, false)
			return true
		}
		const cursor = await this.deps.captureDeliveryCursor(job.childSessionId)
		const handoff = scrubWorkflowSecrets((await this.deps.materializeHandoff?.({ run, job })) ?? '')
		const basePrompt = handoff ? `${job.prompt}\n\nSanitized root handoff: ${handoff}` : job.prompt
		const prompt = `${basePrompt}\n\n${privateCorrelationBlock(run.id, taskAction)}`
		this.finishJobConfiguration(run, job, taskAction, cursor, prompt, true)
		return true
	}

	private finishJobConfiguration(
		run: WorkflowRunRecord,
		job: WorkflowJobRecord,
		taskAction: string,
		cursor: unknown,
		prompt: string,
		prepareTask: boolean
	): void {
		this.db.idempotentMutation(
			'workflow_job_configured',
			`${job.id}:${job.attemptCount}`,
			{ cursor, prompt },
			() => {
				if (prepareTask) {
					this.db.prepareWorkflowEffect({
						id: `${run.id}:${taskAction}`,
						runId: run.id,
						actionId: taskAction,
						kind: 'send_task',
						jobId: job.id,
						target: { sessionId: job.childSessionId },
						inputs: {
							prompt,
							correlationMarker: workflowEffectCorrelationMarker(run.id, taskAction)
						},
						cursor,
						expectedCancellationGeneration: run.cancellationGeneration,
						eventKey: `prepare:${taskAction}`
					})
				}
				this.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'configuring',
					state: 'sending',
					eventKey: `attempt-sending:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_sending'
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['configuring'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'sending',
					eventKey: `job-sending:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_sending'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId: taskAction }
		)
	}

	private async driveJobSend(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		if (!job.childSessionId) throw new WorkflowTransitionError(`job ${job.id} is sending without a child`)
		const actionId = `${job.id}:task:${job.attemptCount}`
		const effect = this.requireEffect(run.id, actionId)
		let current = effect
		let changed = false
		if (effect.state !== 'committed') {
			const prompt =
				effect.inputs &&
				typeof effect.inputs === 'object' &&
				typeof (effect.inputs as { prompt?: unknown }).prompt === 'string'
					? ((effect.inputs as { prompt: string }).prompt as string)
					: job.prompt
			const result = await this.runDurableEffect({
				run,
				effect,
				job,
				execute: (_token, dispatch) =>
					this.deps.sendPrompt({
						...this.effectCall(run, effect, dispatch, job),
						sessionId: job.childSessionId as string,
						text: prompt
					}),
				validate: assertDeliveryReceipt
			})
			current = result.effect
			changed = result.changed
		}
		if (current.state !== 'committed' || !isDeliveryReceipt(current.receipt)) return changed
		const latestJob = this.db.getWorkflowJob(job.id)
		if (latestJob?.state !== 'sending') return true
		const resolution = await this.deps.resolveDeliveryReceipt({
			...this.effectReadCall(run, current, job),
			sessionId: job.childSessionId,
			receipt: current.receipt
		})
		if (resolution.status === 'lost') {
			this.markReceiptLost(run, current, resolution.evidence)
			return true
		}
		const resolved = messageReceipt(resolution, current.receipt.id)
		if (!resolved) {
			if (!isDeliveryReceipt(latestJob.taskReceipt)) {
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['sending'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'sending',
					taskReceipt: current.receipt,
					eventKey: `task-accepted:${job.id}:${current.receipt.id}`,
					eventType: 'workflow_task_accepted'
				})
				return true
			}
			return changed
		}
		this.db.idempotentMutation(
			'workflow_task_delivered',
			`${job.id}:${resolved.id}`,
			resolved,
			() => {
				this.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'sending',
					state: 'running',
					eventKey: `attempt-running:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_running'
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['sending'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'running',
					taskReceipt: resolved,
					eventKey: `task-delivered:${job.id}:${resolved.id}`,
					eventType: 'workflow_task_delivered'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId }
		)
		return true
	}

	private async driveJobOutcome(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		const outcome = await this.deps.readChildOutcome({ run, job })
		if (!outcome) return false
		const sanitized = sanitizeChildOutcome(outcome)
		const freshRun = this.requireRun(run.id)
		if (freshRun.phase === 'cancelled') {
			this.db.recordLateWorkflowChildResult({
				runId: freshRun.id,
				jobId: job.id,
				attemptNumber: job.attemptCount,
				outcome: sanitized,
				eventKey: `late-child:${job.id}:${job.attemptCount}`
			})
			return true
		}
		if (sanitized.kind === 'failure') {
			this.db.idempotentMutation(
				'workflow_job_failed',
				`${job.id}:${job.attemptCount}`,
				sanitized,
				() => {
					this.db.updateWorkflowJobAttempt({
						jobId: job.id,
						attemptNumber: job.attemptCount,
						expectedState: 'running',
						state: 'failed',
						outcome: sanitized,
						failureEvidence: sanitized.evidence,
						eventKey: `attempt-failed:${job.id}:${job.attemptCount}`,
						eventType: 'workflow_job_attempt_failed'
					})
					this.db.updateWorkflowJob({
						jobId: job.id,
						expectedStates: ['running'],
						expectedCancellationGeneration: run.cancellationGeneration,
						state: 'failed',
						outcome: sanitized,
						clearOwner: true,
						eventKey: `job-failed:${job.id}:${job.attemptCount}`,
						eventType: 'workflow_job_failed'
					})
					this.blockRun(this.requireRun(run.id), {
						actionId: `job:${job.id}`,
						errorCode: sanitized.code,
						message: sanitized.message,
						retryClass: sanitized.retryClass ?? 'deterministic'
					})
					return { runId: run.id, jobId: job.id }
				},
				{ runId: run.id, actionId: `job:${job.id}` }
			)
			return true
		}
		this.db.idempotentMutation(
			'workflow_job_outcome',
			`${job.id}:${job.attemptCount}`,
			sanitized,
			() => {
				this.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'running',
					state: 'returning',
					outcome: sanitized,
					eventKey: `attempt-returning:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_returning'
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['running'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'returning',
					outcome: sanitized,
					eventKey: `job-returning:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_returning'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId: `job:${job.id}:outcome` }
		)
		return true
	}

	private potentialBatonGrant(run: WorkflowRunRecord, job: WorkflowJobRecord): CapabilityGrant | undefined {
		const peers = this.db
			.listWorkflowJobs(run.id)
			.filter(peer => peer.cycle === job.cycle && peer.role === job.role && peer.id !== job.id)
		const peersDelivered = peers.every(
			peer => peer.state === 'returned' && isDeliveryReceipt(peer.batonReceipt) && peer.batonReceipt.kind === 'message'
		)
		if (!peersDelivered) return undefined
		return {
			phase: job.role === 'exploration' ? 'planning' : 'reviewing',
			cycle: run.cycle,
			revision: run.revision + 1,
			allowedRoles: ['exploration', 'implementation']
		}
	}

	private async driveJobBaton(run: WorkflowRunRecord, job: WorkflowJobRecord): Promise<boolean> {
		if (!run.rootSessionId) throw new WorkflowTransitionError(`Workflow ${run.id} has no root for Baton return`)
		const outcome = job.outcome as WorkflowChildOutcome | undefined
		if (outcome?.kind !== 'success') throw new WorkflowTransitionError(`job ${job.id} has no successful outcome`)
		const actionId = `${job.id}:baton:${job.attemptCount}`
		let effect = this.db.getWorkflowEffect(run.id, actionId)
		if (!effect) {
			const roleJobs = this.db
				.listWorkflowJobs(run.id)
				.filter(peer => peer.cycle === job.cycle && peer.role === job.role)
			const designatedFinal = roleJobs.at(-1)?.id === job.id
			const grant = designatedFinal ? this.potentialBatonGrant(run, job) : undefined
			// Exactly one current-cycle Baton carries the next phase capability. Hold
			// that deterministic final job until every earlier sibling Baton is a
			// durable root message; accepted outbox rows do not satisfy the barrier.
			if (designatedFinal && !grant) return false
			effect = this.db.prepareWorkflowEffect({
				id: `${run.id}:${actionId}`,
				runId: run.id,
				actionId,
				kind: 'return_baton',
				jobId: job.id,
				target: { sessionId: run.rootSessionId },
				inputs: {
					...(grant ? { grant } : {}),
					correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
				},
				cursor: await this.deps.captureDeliveryCursor(run.rootSessionId),
				expectedCancellationGeneration: run.cancellationGeneration,
				eventKey: `prepare:${actionId}`
			}).effect
		}
		const grant = effectGrant(effect) ?? undefined
		let current = effect
		let changed = false
		if (effect.state !== 'committed') {
			const result = await this.runDurableEffect({
				run,
				effect,
				job,
				...(grant ? { capabilityGrant: grant } : {}),
				execute: (token, dispatch) => {
					const envelope =
						grant && token
							? workflowPrivateEnvelope({
									workflowId: run.id,
									phaseCapability: token,
									cycle: grant.cycle,
									revision: grant.revision,
									allowedRoles: grant.allowedRoles
								})
							: ''
					return this.deps.returnBaton({
						...this.effectCall(run, effect, dispatch, job),
						job,
						sessionId: run.rootSessionId as string,
						text: [outcome.baton, envelope, privateCorrelationBlock(run.id, effect.actionId)]
							.filter(Boolean)
							.join('\n\n')
					})
				},
				validate: assertDeliveryReceipt
			})
			current = result.effect
			changed = result.changed
		}
		if (current.state !== 'committed' || !isDeliveryReceipt(current.receipt)) return changed
		const latestJob = this.db.getWorkflowJob(job.id)
		if (latestJob?.state !== 'returning') return true
		const resolution = await this.deps.resolveDeliveryReceipt({
			...this.effectReadCall(run, current, job),
			sessionId: run.rootSessionId,
			receipt: current.receipt
		})
		if (resolution.status === 'lost') {
			this.markReceiptLost(run, current, resolution.evidence)
			return true
		}
		const resolved = messageReceipt(resolution, current.receipt.id)
		if (!resolved) {
			if (!isDeliveryReceipt(latestJob.batonReceipt)) {
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['returning'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'returning',
					batonReceipt: current.receipt,
					eventKey: `baton-accepted:${job.id}:${current.receipt.id}`,
					eventType: 'workflow_baton_accepted'
				})
				return true
			}
			return changed
		}
		this.db.idempotentMutation(
			'workflow_baton_delivered',
			`${job.id}:${resolved.id}`,
			resolved,
			() => {
				this.db.updateWorkflowJobAttempt({
					jobId: job.id,
					attemptNumber: job.attemptCount,
					expectedState: 'returning',
					state: 'returned',
					outcome: outcome,
					eventKey: `attempt-returned:${job.id}:${job.attemptCount}`,
					eventType: 'workflow_job_attempt_returned'
				})
				this.db.updateWorkflowJob({
					jobId: job.id,
					expectedStates: ['returning'],
					expectedCancellationGeneration: run.cancellationGeneration,
					state: 'returned',
					batonReceipt: resolved,
					clearOwner: true,
					eventKey: `job-returned:${job.id}:${resolved.id}`,
					eventType: 'workflow_job_returned'
				})
				return { runId: run.id, jobId: job.id }
			},
			{ runId: run.id, actionId }
		)
		this.advanceDeliveredBarrier(this.requireRun(run.id))
		return true
	}

	private advanceDeliveredBarrier(run: WorkflowRunRecord): boolean {
		if (run.phase !== 'exploring' && run.phase !== 'implementing') return false
		const role: WorkflowChildRoleName = run.phase === 'exploring' ? 'exploration' : 'implementation'
		const jobs = this.db.listWorkflowJobs(run.id)
		const next = phaseAfterDeliveredBaton(role, guardJobs(jobs), run.cycle)
		if (!next) return false
		const grantJob = [...jobs].reverse().find(job => {
			if (job.role !== role || job.cycle !== run.cycle || job.state !== 'returned') return false
			const effect = this.db.getWorkflowEffect(run.id, `${job.id}:baton:${job.attemptCount}`)
			return effect ? effectGrant(effect)?.phase === next : false
		})
		if (!grantJob) {
			this.blockRun(run, {
				actionId: `barrier:${role}:${run.cycle}`,
				errorCode: 'workflow_barrier_capability_missing',
				message: 'The final delivered Baton had no matching phase authorization.',
				retryClass: 'terminal'
			})
			return true
		}
		const effect = this.requireEffect(run.id, `${grantJob.id}:baton:${grantJob.attemptCount}`)
		const receipt =
			isDeliveryReceipt(grantJob.batonReceipt) && grantJob.batonReceipt.kind === 'message'
				? grantJob.batonReceipt
				: null
		const grant = effectGrant(effect)
		if (!receipt || !grant || !effect.launchNonce) return false
		this.db.idempotentMutation(
			'advance_workflow_baton_barrier',
			`${run.id}:${role}:${run.cycle}:${receipt.id}`,
			{ role, receipt, grant, tokenHash: effect.launchNonce },
			() => {
				const current = this.requireRun(run.id)
				if (current.phase !== run.phase || current.cycle !== run.cycle || current.revision !== run.revision) {
					return { runId: run.id }
				}
				const implementationDelivered = this.db
					.listWorkflowJobs(run.id)
					.filter(
						job =>
							job.role === 'implementation' &&
							job.state === 'returned' &&
							isDeliveryReceipt(job.batonReceipt) &&
							job.batonReceipt.kind === 'message'
					).length
				const advanced = this.db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: run.phase,
					expectedCancellationGeneration: current.cancellationGeneration,
					phase: next,
					cycle: grant.cycle,
					revision: grant.revision,
					implementationBatonsDelivered: implementationDelivered,
					eventKey: `barrier-advanced:${role}:${receipt.id}`,
					eventType: 'workflow_baton_barrier_satisfied',
					eventData: { role, receipt }
				})
				this.db.revokeWorkflowCapabilities(run.id, `revoke-after-barrier:${receipt.id}`, run.phase)
				this.db.issueWorkflowCapability({
					tokenHash: effect.launchNonce as string,
					runId: run.id,
					rootSessionId: advanced.rootSessionId as string,
					cycle: advanced.cycle,
					phase: next,
					revision: advanced.revision,
					allowedRoles: grant.allowedRoles,
					issuedWith: { rowid: receipt.rowid, ...(receipt.turnId ? { turnId: receipt.turnId } : {}) },
					eventKey: `capability-after-baton:${receipt.id}`
				})
				return { runId: run.id }
			},
			{ runId: run.id, actionId: effect.actionId }
		)
		return true
	}

	async delegate(input: WorkflowDelegateInput): Promise<WorkflowDelegationResult> {
		const tokenHash = hashCapabilityToken(input.phaseCapability)
		const request = {
			workflowId: input.workflowId,
			sessionId: input.sessionId,
			tokenHash,
			role: input.role,
			task: input.task,
			planningInterpretation: input.planningInterpretation
		}
		const replay = this.db.getIdempotentMutation<{ runId: string; jobId: string }>(
			'workflow_delegate',
			input.clientId,
			request
		)
		if (replay) {
			const job = this.db.getWorkflowJob(replay.result.jobId)
			if (!job) throw new WorkflowTransitionError('accepted Workflow job disappeared')
			return { replayed: true, job, workflow: this.projection(replay.result.runId) }
		}
		this.heartbeat()
		if (!input.task.trim())
			throw new WorkflowCoordinatorError('invalid_request', 'Delegation needs a focused task.', { status: 400 })
		const initial = this.db.getWorkflowRun(input.workflowId)
		if (!initial) throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
		const jobId = randomUUID()
		const transcriptCursor = await this.deps.captureTranscriptCursor?.(input.sessionId)
		const deliveryCursor = await this.deps.captureDeliveryCursor(input.sessionId)
		const role = initial.roles[input.role]
		const prompt = [
			workflowChildPrompt({
				roleName: input.role,
				objective: initial.objective,
				role: promptRole(role),
				task: input.task
			}),
			privateCorrelationBlock(initial.id, `job:${jobId}`)
		].join('\n\n')
		const mutation = this.db.idempotentMutation(
			'workflow_delegate',
			input.clientId,
			request,
			() => {
				const run = this.requireRun(input.workflowId)
				const jobs = this.db.listWorkflowJobs(run.id)
				const capability = this.db.getWorkflowCapability(tokenHash)
				const claims: WorkflowCapabilityClaims | null =
					capability &&
					(capability.phase === 'exploring' || capability.phase === 'planning' || capability.phase === 'reviewing')
						? {
								runId: capability.runId,
								rootSessionId: capability.rootSessionId,
								cycle: capability.cycle,
								revision: capability.revision,
								phase: capability.phase,
								allowedRoles: capability.allowedRoles,
								consumed: capability.consumedAt !== undefined,
								revoked: capability.revokedAt !== undefined
							}
						: null
				const guardRun = {
					id: run.id,
					rootSessionId: run.rootSessionId ?? null,
					phase: run.phase,
					cycle: run.cycle,
					revision: run.revision
				}
				assertWorkflowDelegation(guardRun, claims, { sessionId: input.sessionId, role: input.role }, guardJobs(jobs))
				const transition = workflowDelegationTransition(guardRun, input.role)
				const ordinal = actionOrdinal(jobs, input.role, transition.cycle)
				const logicalKey = `${transition.logicalPrefix}:${transition.cycle}:${ordinal}`
				this.db.consumeWorkflowCapability({
					tokenHash,
					runId: run.id,
					rootSessionId: input.sessionId,
					role: input.role,
					expectedPhase: run.phase,
					expectedCycle: run.cycle,
					expectedRevision: run.revision,
					eventKey: `capability-consumed:${logicalKey}`
				})
				const created = this.db.createWorkflowJob({
					id: jobId,
					runId: run.id,
					logicalKey,
					role: input.role,
					cycle: transition.cycle,
					revision: transition.revision,
					resolvedRole: role,
					prompt,
					state: 'queued',
					transcriptCursor,
					expectedCancellationGeneration: run.cancellationGeneration,
					eventKey: `delegated:${logicalKey}`
				})
				const advanced = this.db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: run.phase,
					expectedCancellationGeneration: run.cancellationGeneration,
					phase: transition.phase,
					cycle: transition.cycle,
					revision: transition.revision,
					...(input.role === 'implementation'
						? { planningInterpretation: input.planningInterpretation ?? input.task }
						: {}),
					eventKey: `delegation-transition:${logicalKey}`,
					eventType: 'workflow_delegation_accepted',
					eventData: { jobId: created.job.id, logicalKey, role: input.role }
				})
				this.db.revokeWorkflowCapabilities(run.id, `revoke-after-delegation:${logicalKey}`, run.phase)
				if (input.role === 'exploration') {
					const actionId = `authorize:exploring:${advanced.cycle}:${advanced.revision}`
					this.db.prepareWorkflowEffect({
						runId: run.id,
						actionId,
						kind: 'authorize_phase',
						target: { sessionId: input.sessionId },
						inputs: {
							grant: {
								phase: 'exploring',
								cycle: advanced.cycle,
								revision: advanced.revision,
								allowedRoles: ['exploration']
							},
							correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
						},
						cursor: deliveryCursor,
						expectedCancellationGeneration: run.cancellationGeneration,
						eventKey: `prepare:${actionId}`
					})
				}
				return { runId: run.id, jobId: created.job.id }
			},
			{ runId: input.workflowId }
		)
		const job = this.db.getWorkflowJob(mutation.result.jobId)
		if (!job) throw new WorkflowTransitionError('accepted Workflow job disappeared')
		return { replayed: mutation.replayed, job, workflow: this.projection(input.workflowId) }
	}

	async retry(input: WorkflowRetryInput): Promise<WorkflowMutationResult> {
		const replay = this.db.getIdempotentMutation<{ runId: string }>('workflow_retry', input.clientId, input)
		if (replay) return { replayed: true, workflow: this.projection(replay.result.runId) }
		this.heartbeat()
		await this.assertCompatible()
		const mutation = this.db.idempotentMutation(
			'workflow_retry',
			input.clientId,
			input,
			() => {
				const run = this.requireBlockedRun(input.workflowId)
				const actionId = run.blocked?.actionId as string
				if (run.blocked?.retryClass !== 'deterministic') {
					throw new WorkflowCoordinatorError(
						'workflow_recovery_invalid',
						'This blocked action is not safely retryable.'
					)
				}
				if (actionId.startsWith('job:')) {
					const jobId = actionId.slice(4)
					this.db.updateWorkflowJob({
						jobId,
						expectedStates: ['failed'],
						expectedCancellationGeneration: run.cancellationGeneration,
						state: 'queued',
						childSessionId: null,
						outcome: null,
						taskReceipt: null,
						batonReceipt: null,
						clearOwner: true,
						eventKey: `job-retry:${jobId}:${input.clientId}`,
						eventType: 'workflow_job_retry_queued'
					})
				} else if (actionId.startsWith('compatibility:') || actionId === 'bind-root') {
					// No external intent exists for these read-only gates; unblocking is the retry.
				} else {
					this.db.retryWorkflowEffect(run.id, actionId, `effect-retry:${actionId}:${input.clientId}`)
				}
				this.db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: 'blocked',
					expectedCancellationGeneration: run.cancellationGeneration,
					phase: run.blocked?.resumePhase,
					blocked: null,
					eventKey: `workflow-retry:${actionId}:${input.clientId}`,
					eventType: 'workflow_retry_accepted'
				})
				return { runId: run.id }
			},
			{ runId: input.workflowId }
		)
		return { replayed: mutation.replayed, workflow: this.projection(input.workflowId) }
	}

	async adopt(input: WorkflowAdoptInput): Promise<WorkflowMutationResult> {
		const replay = this.db.getIdempotentMutation<{ runId: string }>('workflow_adopt', input.clientId, input)
		if (replay) return { replayed: true, workflow: this.projection(replay.result.runId) }
		this.heartbeat()
		const run = this.requireBlockedAction(input.workflowId, input.actionId)
		const candidate = run.blocked?.candidates?.find(item => item.id === input.candidateId)
		if (!candidate)
			throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'That saved adoption candidate is unavailable.')
		const effect = this.requireEffect(run.id, input.actionId)
		if (effect.state !== 'ambiguous' || !this.deps.validateAdoption) {
			throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'This action cannot be adopted.')
		}
		const receipt = await this.deps.validateAdoption({ run, effect, candidate })
		if (receipt === null)
			throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'The candidate no longer validates.')
		const mutation = this.db.idempotentMutation(
			'workflow_adopt',
			input.clientId,
			input,
			() => {
				const current = this.requireBlockedAction(input.workflowId, input.actionId)
				const currentEffect = this.requireSameAmbiguousEffect(current.id, input.actionId, effect)
				this.db.markWorkflowEffectCommitted({
					runId: current.id,
					actionId: input.actionId,
					receipt: cleanUnknown(receipt),
					eventKey: `effect-adopted:${input.actionId}:${input.clientId}`
				})
				this.db.transitionWorkflowRun({
					runId: current.id,
					expectedPhase: 'blocked',
					expectedCancellationGeneration: current.cancellationGeneration,
					phase: current.blocked?.resumePhase,
					blocked: null,
					eventKey: `workflow-adopted:${input.actionId}:${input.clientId}`,
					eventType: 'workflow_effect_adopted',
					eventData: { candidateId: candidate.id }
				})
				this.clearMatchingQuarantine(currentEffect, `adopt:${input.clientId}`)
				return { runId: current.id }
			},
			{ runId: input.workflowId, actionId: input.actionId }
		)
		return { replayed: mutation.replayed, workflow: this.projection(input.workflowId) }
	}

	async replay(input: WorkflowReplayInput): Promise<WorkflowMutationResult> {
		const prior = this.db.getIdempotentMutation<{ runId: string }>('workflow_replay_ambiguous', input.clientId, input)
		if (prior) return { replayed: true, workflow: this.projection(prior.result.runId) }
		this.heartbeat()
		if (input.confirmDuplicateRisk !== true) {
			throw new WorkflowCoordinatorError(
				'workflow_recovery_invalid',
				'Risky replay requires explicit duplicate-risk confirmation.'
			)
		}
		const blocked = this.requireBlockedAction(input.workflowId, input.actionId)
		const effect = this.requireEffect(blocked.id, input.actionId)
		await this.reconcileBlockedEffect(blocked)
		if (this.requireRun(input.workflowId).phase !== 'blocked') {
			const reconciled = this.db.idempotentMutation(
				'workflow_replay_ambiguous',
				input.clientId,
				input,
				() => ({ runId: input.workflowId }),
				{ runId: input.workflowId, actionId: input.actionId }
			)
			return { replayed: reconciled.replayed, workflow: this.projection(input.workflowId) }
		}
		const mutation = this.db.idempotentMutation(
			'workflow_replay_ambiguous',
			input.clientId,
			input,
			() => {
				const run = this.requireBlockedAction(input.workflowId, input.actionId)
				if (run.blocked?.retryClass !== 'ambiguous') {
					throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'This action is not an ambiguous effect.')
				}
				if (run.blocked.candidates?.length) {
					throw new WorkflowCoordinatorError(
						'workflow_recovery_invalid',
						'Validate and adopt a saved candidate instead of risking a duplicate replay.'
					)
				}
				const currentEffect = this.requireSameAmbiguousEffect(run.id, input.actionId, effect)
				this.db.replayAmbiguousWorkflowEffect(
					run.id,
					input.actionId,
					`effect-replay:${input.actionId}:${input.clientId}`
				)
				this.db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: 'blocked',
					expectedCancellationGeneration: run.cancellationGeneration,
					phase: run.blocked?.resumePhase,
					blocked: null,
					eventKey: `workflow-replay:${input.actionId}:${input.clientId}`,
					eventType: 'workflow_ambiguous_replay_confirmed'
				})
				this.clearMatchingQuarantine(currentEffect, `replay:${input.clientId}`)
				return { runId: run.id }
			},
			{ runId: input.workflowId, actionId: input.actionId }
		)
		return { replayed: mutation.replayed, workflow: this.projection(input.workflowId) }
	}

	/** A later positive receipt resolves ambiguity safely; a newly visible candidate only refreshes the phone choice. */
	private async reconcileBlockedEffect(run: WorkflowRunRecord): Promise<boolean> {
		if (run.phase !== 'blocked' || run.blocked?.retryClass !== 'ambiguous') return false
		const effect = this.db.getWorkflowEffect(run.id, run.blocked.actionId)
		if (effect?.state !== 'ambiguous') return false
		const reconciliation = await this.deps.reconcileEffect?.(this.effectReadCall(run, effect))
		if (!reconciliation || reconciliation.status === 'pending') return false
		if (reconciliation.status === 'committed') {
			const receipt = cleanUnknown(reconciliation.receipt)
			this.db.idempotentMutation(
				'reconcile_blocked_workflow_effect',
				`${run.id}:${effect.actionId}:${receiptEventSuffix(receipt, `attempt:${effect.attemptCount}`)}`,
				{ actionId: effect.actionId, receipt },
				() => {
					const current = this.requireBlockedAction(run.id, effect.actionId)
					const currentEffect = this.requireSameAmbiguousEffect(current.id, effect.actionId, effect)
					this.db.markWorkflowEffectCommitted({
						runId: current.id,
						actionId: effect.actionId,
						receipt,
						eventKey: `effect-positive-while-blocked:${effect.actionId}:${effect.attemptCount}`
					})
					this.db.transitionWorkflowRun({
						runId: current.id,
						expectedPhase: 'blocked',
						expectedCancellationGeneration: current.cancellationGeneration,
						phase: current.blocked?.resumePhase,
						blocked: null,
						eventKey: `workflow-positive-while-blocked:${effect.actionId}:${effect.attemptCount}`,
						eventType: 'workflow_ambiguous_effect_reconciled'
					})
					this.clearMatchingQuarantine(currentEffect, `positive-receipt:${effect.id}`)
					return { runId: current.id }
				},
				{ runId: run.id, actionId: effect.actionId }
			)
			return true
		}

		const candidates = (reconciliation.candidates ?? [])
			.slice(0, 20)
			.map(candidate => cleanUnknown(candidate) as WorkflowAdoptionCandidate)
		const prior = run.blocked.candidates ?? []
		if (JSON.stringify(prior) === JSON.stringify(candidates)) return false
		this.db.transitionWorkflowRun({
			runId: run.id,
			expectedPhase: 'blocked',
			expectedCancellationGeneration: run.cancellationGeneration,
			phase: 'blocked',
			blocked: { ...run.blocked, candidates },
			eventKey: `workflow-candidates-refreshed:${effect.actionId}:${effect.attemptCount}:${candidates.map(item => item.id).join(',') || 'none'}`,
			eventType: 'workflow_adoption_candidates_refreshed',
			eventData: { actionId: effect.actionId, candidateCount: candidates.length }
		})
		return true
	}

	async complete(input: WorkflowRunMutationInput): Promise<WorkflowMutationResult> {
		const replay = this.db.getIdempotentMutation<{ runId: string }>('workflow_complete', input.clientId, input)
		if (replay) return { replayed: true, workflow: this.projection(replay.result.runId) }
		this.heartbeat()
		const mutation = this.db.idempotentMutation(
			'workflow_complete',
			input.clientId,
			input,
			() => {
				const run = this.requireRun(input.workflowId)
				const jobs = this.db.listWorkflowJobs(run.id)
				const outstanding = jobs.some(job => !isTerminalWorkflowJobState(job.state))
				const implementationDelivered = jobs.some(
					job =>
						job.role === 'implementation' &&
						job.state === 'returned' &&
						isDeliveryReceipt(job.batonReceipt) &&
						job.batonReceipt.kind === 'message'
				)
				if (
					run.phase !== 'reviewing' ||
					outstanding ||
					!implementationDelivered ||
					run.implementationBatonsDelivered < 1
				) {
					throw new WorkflowCoordinatorError(
						'workflow_recovery_invalid',
						'Workflow can complete only from reviewing after a delivered implementation Baton and no outstanding job.'
					)
				}
				this.db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: 'reviewing',
					expectedCancellationGeneration: run.cancellationGeneration,
					phase: 'completed',
					eventKey: `workflow-completed:${input.clientId}`,
					eventType: 'workflow_completed'
				})
				this.db.revokeWorkflowCapabilities(run.id, `revoke-on-complete:${input.clientId}`)
				return { runId: run.id }
			},
			{ runId: input.workflowId }
		)
		return { replayed: mutation.replayed, workflow: this.projection(input.workflowId) }
	}

	async cancel(input: WorkflowRunMutationInput): Promise<WorkflowMutationResult> {
		const replay = this.db.getIdempotentMutation<{ runId: string }>('workflow_cancel', input.clientId, input)
		if (replay) return { replayed: true, workflow: this.projection(replay.result.runId) }
		this.heartbeat()
		const mutation = this.db.idempotentMutation(
			'workflow_cancel',
			input.clientId,
			input,
			() => {
				this.db.cancelWorkflowRun(input.workflowId, `workflow-cancelled:${input.clientId}`)
				this.db.revokeWorkflowCapabilities(input.workflowId, `revoke-on-cancel:${input.clientId}`)
				return { runId: input.workflowId }
			},
			{ runId: input.workflowId }
		)
		return { replayed: mutation.replayed, workflow: this.projection(input.workflowId) }
	}

	projection(runId: string): WorkflowRunProjection {
		const projection = this.db.getWorkflowProjection(runId)
		if (!projection)
			throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
		return projection
	}

	projections(includeTerminal = false): WorkflowRunProjection[] {
		return this.db.listWorkflowProjections({ includeTerminal })
	}

	runIdsNeedingWake(): string[] {
		return this.db.listWorkflowRunIdsNeedingWake()
	}

	workflowForSession(sessionId: string): WorkflowRunProjection | undefined {
		for (const projection of this.db.listWorkflowProjections()) {
			if (projection.rootSessionId === sessionId) return projection
			if (this.db.listWorkflowJobs(projection.id).some(job => job.childSessionId === sessionId)) return projection
		}
		return undefined
	}

	ownsSession(sessionId: string): boolean {
		return this.workflowForSession(sessionId) !== undefined
	}

	private async runDurableEffect<T>(options: DurableEffectOptions<T>): Promise<DurableEffectResult> {
		let effect = this.requireEffect(options.run.id, options.effect.actionId)
		if (
			effect.state === 'committed' ||
			effect.state === 'failed' ||
			effect.state === 'ambiguous' ||
			effect.state === 'cancelled'
		) {
			return { effect, changed: false }
		}
		if (
			!effect.owner &&
			effect.state === 'prepared' &&
			(effect.kind === 'configure_root' || effect.kind === 'configure_child')
		) {
			const satisfaction = await this.deps.reconcileEffect?.(this.effectReadCall(options.run, effect, options.job))
			if (satisfaction?.status === 'committed') {
				const latest = this.requireEffect(options.run.id, effect.actionId)
				const latestRun = this.requireRun(options.run.id)
				if (
					!latest.owner &&
					latest.state === 'prepared' &&
					latestRun.phase !== 'blocked' &&
					!isTerminalWorkflowPhase(latestRun.phase)
				) {
					effect = this.db.markWorkflowEffectSatisfiedWithoutDispatch({
						runId: latestRun.id,
						actionId: latest.actionId,
						expectedCancellationGeneration: latestRun.cancellationGeneration,
						receipt: cleanUnknown(satisfaction.receipt),
						eventKey: `effect-satisfied:${latest.actionId}`
					})
					return { effect, changed: true }
				}
			}
		}
		if (effect.owner) {
			const reconciled = await this.reconcileClaimedEffect(options.run, effect, options.job)
			effect = reconciled.effect
			if (reconciled.changed || effect.owner || effect.state !== 'prepared') return reconciled
		}
		const currentRun = this.requireRun(options.run.id)
		if (currentRun.phase === 'blocked' || isTerminalWorkflowPhase(currentRun.phase)) return { effect, changed: false }
		const claim = this.db.claimPreparedWorkflowEffect({
			runId: options.run.id,
			actionId: effect.actionId,
			owner: this.relay,
			expectedCancellationGeneration: currentRun.cancellationGeneration
		})
		if (!claim) return { effect: this.requireEffect(options.run.id, effect.actionId), changed: false }
		const capabilityToken = options.capabilityGrant
			? workflowCapabilityToken(randomBytes(32).toString('base64url'))
			: undefined
		const launchNonce = capabilityToken ? hashCapabilityToken(capabilityToken) : randomBytes(32).toString('hex')
		const dispatchMode = this.deps.dispatchMode?.(claim.effect) ?? 'in_process'
		const dispatch: WorkflowEffectDispatch = {
			mode: dispatchMode,
			gatedProcessReady: async externalProcess => {
				if (dispatchMode !== 'gated_child') {
					throw new WorkflowCoordinatorError(
						'workflow_adapter_invalid',
						`Workflow adapter for ${effect.actionId} registered a gated process in in-process mode.`
					)
				}
				const latestRun = this.requireRun(options.run.id)
				if (
					latestRun.cancellationGeneration !== currentRun.cancellationGeneration ||
					latestRun.phase === 'blocked' ||
					isTerminalWorkflowPhase(latestRun.phase)
				) {
					throw new WorkflowTransitionError(`Workflow ${latestRun.id} changed before gated process release`)
				}
				await this.assertCompatible()
				this.db.markWorkflowEffectMayExecute({
					runId: latestRun.id,
					actionId: effect.actionId,
					owner: this.relay,
					attemptNumber: claim.attempt.attemptNumber,
					launchNonce,
					externalProcess
				})
			}
		}
		try {
			return await withUiPriority('background', () =>
				withUiDispatchHook(
					async () => {
						const latestRun = this.requireRun(options.run.id)
						if (
							latestRun.cancellationGeneration !== currentRun.cancellationGeneration ||
							latestRun.phase === 'blocked' ||
							isTerminalWorkflowPhase(latestRun.phase)
						) {
							throw new WorkflowTransitionError(`Workflow ${latestRun.id} changed before UI dispatch`)
						}
						await this.deps.validateBeforeDispatch?.(
							this.effectReadCall(latestRun, this.requireEffect(latestRun.id, effect.actionId), options.job)
						)
						await this.assertCompatible()
						this.db.markWorkflowEffectDispatched({
							runId: latestRun.id,
							actionId: effect.actionId,
							owner: this.relay,
							attemptNumber: claim.attempt.attemptNumber,
							launchNonce,
							mayExecute: dispatchMode === 'in_process'
						})
					},
					async () => {
						try {
							const result = await options.execute(capabilityToken, dispatch)
							effect = this.requireEffect(options.run.id, effect.actionId)
							if (effect.state !== 'dispatched') {
								throw new WorkflowCoordinatorError(
									'workflow_adapter_invalid',
									`Workflow adapter for ${effect.actionId} returned without entering uiTurn.`
								)
							}
							if (!effect.mayExecute) {
								throw new WorkflowCoordinatorError(
									'workflow_adapter_invalid',
									`Workflow adapter for ${effect.actionId} returned before releasing its gated process.`
								)
							}
							const receipt = cleanUnknown(options.validate(result))
							const completedRun = this.requireRun(options.run.id)
							if (completedRun.phase === 'cancelled') {
								effect = this.db.recordLateWorkflowEffect({
									runId: completedRun.id,
									actionId: effect.actionId,
									receipt,
									eventKey: `late-effect:${effect.actionId}:${claim.attempt.attemptNumber}`
								})
								return { effect, changed: true }
							}
							if (completedRun.phase === 'completed') return { effect, changed: false }
							effect = this.db.markWorkflowEffectCommitted({
								runId: options.run.id,
								actionId: effect.actionId,
								owner: this.relay,
								attemptNumber: claim.attempt.attemptNumber,
								receipt
							})
							if (this.requireRun(options.run.id).phase === 'cancelled') {
								effect = this.db.recordLateWorkflowEffect({
									runId: options.run.id,
									actionId: effect.actionId,
									receipt,
									eventKey: `late-effect:${effect.actionId}:${claim.attempt.attemptNumber}`
								})
							}
							return { effect, changed: true }
						} catch (error) {
							return this.failEffect(options.run, effect.actionId, claim.attempt.attemptNumber, error, options.job)
						}
					},
					claim.effect.id
				)
			)
		} catch (error) {
			return this.failEffect(options.run, effect.actionId, claim.attempt.attemptNumber, error, options.job)
		}
	}

	private async reconcileClaimedEffect(
		run: WorkflowRunRecord,
		effect: WorkflowEffectRecord,
		job?: WorkflowJobRecord
	): Promise<DurableEffectResult> {
		const positive = await this.deps.reconcileEffect?.(this.effectReadCall(run, effect, job))
		if (positive?.status === 'committed') {
			const committed = this.db.markWorkflowEffectCommitted({
				runId: run.id,
				actionId: effect.actionId,
				receipt: cleanUnknown(positive.receipt),
				eventKey: `effect-reconciled:${effect.actionId}:${effect.attemptCount}`
			})
			return { effect: committed, changed: true }
		}
		const recovery = this.db.reconcileAbandonedWorkflowEffect({
			runId: run.id,
			actionId: effect.actionId,
			eventKey: `recover-effect:${effect.actionId}:${effect.attemptCount}`
		})
		if (recovery.status === 'safely_prepared') return { effect: recovery.effect, changed: true }
		if (recovery.status === 'ambiguous') {
			this.quarantineAndBlock(run, recovery.effect, positive?.status === 'ambiguous' ? positive.candidates : undefined)
			return { effect: recovery.effect, changed: true }
		}
		return { effect: recovery.effect, changed: false }
	}

	private async failEffect(
		run: WorkflowRunRecord,
		actionId: string,
		attemptNumber: number,
		error: unknown,
		job?: WorkflowJobRecord
	): Promise<DurableEffectResult> {
		let effect = this.requireEffect(run.id, actionId)
		const currentRun = this.requireRun(run.id)
		if (currentRun.phase === 'cancelled' || currentRun.phase === 'completed') {
			if (effect.state === 'dispatched') {
				if (!effect.mayExecute) {
					effect = this.db.markWorkflowEffectFailedBeforeMayExecute({
						runId: run.id,
						actionId,
						owner: this.relay,
						attemptNumber,
						errorCode: errorCode(error, 'workflow_effect_failed'),
						errorMessage: errorMessage(error),
						evidence: cleanUnknown(error)
					})
					return { effect, changed: true }
				}
				let positive: WorkflowEffectReconciliation | undefined
				try {
					positive = await this.deps.reconcileEffect?.(this.effectReadCall(currentRun, effect, job))
				} catch {
					// Failure to read a receipt is not negative evidence. Preserve ambiguity below.
				}
				if (positive?.status === 'committed') {
					const receipt = cleanUnknown(positive.receipt)
					effect =
						currentRun.phase === 'cancelled'
							? this.db.recordLateWorkflowEffect({
									runId: run.id,
									actionId,
									receipt,
									eventKey: `late-effect-error:${actionId}:${attemptNumber}`
								})
							: this.db.markWorkflowEffectCommitted({
									runId: run.id,
									actionId,
									owner: this.relay,
									attemptNumber,
									receipt
								})
					return { effect, changed: true }
				}
				effect = this.db.markWorkflowEffectAmbiguous({
					runId: run.id,
					actionId,
					owner: this.relay,
					attemptNumber,
					errorCode: errorCode(error, 'ambiguous_effect'),
					errorMessage: errorMessage(error),
					evidence: cleanUnknown(error)
				})
				this.db.activateUiQuarantine({
					actionId: effect.actionId,
					effectId: effect.id,
					reason: effect.errorMessage ?? 'A terminal Workflow has an unresolved UI effect.',
					owner: effect.owner,
					externalProcess: effect.externalProcess
				})
				return { effect, changed: true }
			}
			return { effect, changed: false }
		}
		if (effect.state === 'prepared' && sameRelay(effect.owner, this.relay)) {
			effect = this.db.markWorkflowEffectFailed({
				runId: run.id,
				actionId,
				owner: this.relay,
				attemptNumber,
				errorCode: errorCode(error, 'workflow_effect_failed'),
				errorMessage: errorMessage(error),
				evidence: cleanUnknown(error)
			})
			this.blockRun(currentRun, {
				actionId,
				errorCode: effect.errorCode ?? 'workflow_effect_failed',
				message: effect.errorMessage ?? 'Workflow UI action failed before dispatch.',
				retryClass: preExecutionRetryClass(error)
			})
			return { effect, changed: true }
		}
		if (effect.state === 'dispatched') {
			if (!effect.mayExecute) {
				effect = this.db.markWorkflowEffectFailedBeforeMayExecute({
					runId: run.id,
					actionId,
					owner: this.relay,
					attemptNumber,
					errorCode: errorCode(error, 'workflow_effect_failed'),
					errorMessage: errorMessage(error),
					evidence: cleanUnknown(error)
				})
				this.blockRun(currentRun, {
					actionId,
					errorCode: effect.errorCode ?? 'workflow_effect_failed',
					message: effect.errorMessage ?? 'Workflow external command failed before its private gate opened.',
					retryClass: preExecutionRetryClass(error)
				})
				return { effect, changed: true }
			}
			let positive: WorkflowEffectReconciliation | undefined
			try {
				positive = await this.deps.reconcileEffect?.(this.effectReadCall(currentRun, effect, job))
			} catch {
				// A failed receipt read cannot make an already-authorized external action safe to replay.
			}
			if (positive?.status === 'committed') {
				effect = this.db.markWorkflowEffectCommitted({
					runId: run.id,
					actionId,
					owner: this.relay,
					attemptNumber,
					receipt: cleanUnknown(positive.receipt),
					eventKey: `effect-positive-after-error:${actionId}:${attemptNumber}`
				})
				return { effect, changed: true }
			}
			effect = this.db.markWorkflowEffectAmbiguous({
				runId: run.id,
				actionId,
				owner: this.relay,
				attemptNumber,
				errorCode: errorCode(error, 'ambiguous_effect'),
				errorMessage: errorMessage(error),
				evidence: cleanUnknown(error)
			})
			this.quarantineAndBlock(currentRun, effect, positive?.status === 'ambiguous' ? positive.candidates : undefined)
			return { effect, changed: true }
		}
		return { effect, changed: false }
	}

	private markReceiptLost(run: WorkflowRunRecord, effect: WorkflowEffectRecord, evidence?: unknown): void {
		if (!isDeliveryReceipt(effect.receipt) || effect.receipt.kind !== 'outbox') {
			throw new WorkflowCoordinatorError(
				'workflow_adapter_invalid',
				`Delivery resolver reported a non-outbox receipt lost for ${effect.actionId}.`
			)
		}
		const errorMessage =
			'Conductor accepted the queued message, but it disappeared before a durable message row was found.'
		const ambiguous =
			effect.state === 'dispatched'
				? this.db.markWorkflowEffectAmbiguous({
						runId: run.id,
						actionId: effect.actionId,
						errorCode: 'outbox_receipt_lost',
						errorMessage,
						...(evidence === undefined ? {} : { evidence: cleanUnknown(evidence) }),
						eventKey: `effect-receipt-lost:${effect.actionId}:${effect.receipt.id}`
					})
				: this.db.markWorkflowEffectReceiptLost({
						runId: run.id,
						actionId: effect.actionId,
						expectedReceipt: effect.receipt,
						errorCode: 'outbox_receipt_lost',
						errorMessage,
						...(evidence === undefined ? {} : { evidence: cleanUnknown(evidence) }),
						eventKey: `effect-receipt-lost:${effect.actionId}:${effect.receipt.id}`
					})
		const current = this.requireRun(run.id)
		if (current.phase === 'cancelled') {
			this.db.activateUiQuarantine({
				actionId: ambiguous.actionId,
				effectId: ambiguous.id,
				reason: ambiguous.errorMessage ?? 'A cancelled Workflow has a lost accepted outbox receipt.',
				owner: ambiguous.owner,
				externalProcess: ambiguous.externalProcess
			})
			return
		}
		this.quarantineAndBlock(current, ambiguous)
	}

	private quarantineAndBlock(
		run: WorkflowRunRecord,
		effect: WorkflowEffectRecord,
		candidates?: WorkflowAdoptionCandidate[]
	): void {
		this.db.activateUiQuarantine({
			actionId: effect.actionId,
			effectId: effect.id,
			reason: effect.errorMessage ?? 'Workflow UI effect has no positive receipt.',
			owner: effect.owner,
			externalProcess: effect.externalProcess
		})
		this.blockRun(this.requireRun(run.id), {
			actionId: effect.actionId,
			errorCode: effect.errorCode ?? 'workflow_effect_ambiguous',
			message: effect.errorMessage ?? 'The UI action may have executed; automatic replay is disabled.',
			retryClass: 'ambiguous',
			candidates
		})
	}

	/** Call only inside the surrounding durable mutation so a newer hold cannot be cleared between read and write. */
	private clearMatchingQuarantine(effect: WorkflowEffectRecord, clearedBy: string): void {
		const quarantine = this.db.getUiQuarantine()
		const matches = quarantine.effectId
			? quarantine.effectId === effect.id
			: quarantine.actionId === effect.id || quarantine.actionId === effect.actionId
		if (quarantine.active && matches) {
			this.db.clearUiQuarantine(clearedBy)
		}
	}

	private requireSameAmbiguousEffect(
		runId: string,
		actionId: string,
		expected: WorkflowEffectRecord
	): WorkflowEffectRecord {
		const current = this.requireEffect(runId, actionId)
		if (current.state !== 'ambiguous' || current.attemptCount !== expected.attemptCount) {
			throw new WorkflowCoordinatorError(
				'workflow_recovery_invalid',
				'The ambiguous action changed while it was being validated; inspect its current state and try again.'
			)
		}
		return current
	}

	private blockRun(
		run: WorkflowRunRecord,
		blocked: {
			actionId: string
			errorCode: string
			message: string
			retryClass: WorkflowRetryClass
			candidates?: WorkflowAdoptionCandidate[]
		}
	): void {
		if (run.phase === 'blocked' || isTerminalWorkflowPhase(run.phase)) return
		const blockOrdinal = this.db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_blocked').length
		this.db.transitionWorkflowRun({
			runId: run.id,
			expectedPhase: run.phase,
			expectedCancellationGeneration: run.cancellationGeneration,
			phase: 'blocked',
			blocked: {
				actionId: blocked.actionId,
				errorCode: scrubWorkflowSecrets(blocked.errorCode),
				message: scrubWorkflowSecrets(blocked.message).slice(0, 500),
				resumePhase: activeResumePhase(run),
				retryClass: blocked.retryClass,
				...(blocked.candidates
					? {
							candidates: blocked.candidates
								.slice(0, 20)
								.map(candidate => cleanUnknown(candidate) as WorkflowAdoptionCandidate)
						}
					: {})
			},
			eventKey: `workflow-blocked:${blocked.actionId}:${blockOrdinal}`,
			eventType: 'workflow_blocked',
			eventData: { actionId: blocked.actionId, retryClass: blocked.retryClass }
		})
	}

	private requireBlockedAction(runId: string, actionId: string): WorkflowRunRecord {
		const run = this.requireBlockedRun(runId)
		if (run.blocked?.actionId !== actionId) {
			throw new WorkflowCoordinatorError(
				'workflow_recovery_invalid',
				'Recovery does not match the current blocked action.'
			)
		}
		return run
	}

	private requireBlockedRun(runId: string): WorkflowRunRecord {
		const run = this.requireRun(runId)
		if (run.phase !== 'blocked' || !run.blocked) {
			throw new WorkflowCoordinatorError('workflow_recovery_invalid', 'Workflow has no current blocked action.')
		}
		return run
	}

	private requireRun(runId: string): WorkflowRunRecord {
		const run = this.db.getWorkflowRun(runId)
		if (!run) throw new WorkflowCoordinatorError('workflow_not_found', 'Workflow does not exist.', { status: 404 })
		return run
	}

	private requireEffect(runId: string, actionId: string): WorkflowEffectRecord {
		const effect = this.db.getWorkflowEffect(runId, actionId)
		if (!effect) throw new WorkflowTransitionError(`Workflow effect ${actionId} does not exist`)
		return effect
	}

	private effectCall(
		run: WorkflowRunRecord,
		effect: WorkflowEffectRecord,
		dispatch: WorkflowEffectDispatch,
		job?: WorkflowJobRecord
	): WorkflowEffectCall {
		return {
			...this.effectReadCall(run, effect, job),
			dispatch
		}
	}

	private effectReadCall(
		run: WorkflowRunRecord,
		effect: WorkflowEffectRecord,
		job?: WorkflowJobRecord
	): WorkflowEffectReadCall {
		return {
			run,
			effect,
			...(job ? { job } : {}),
			correlationMarker: workflowEffectCorrelationMarker(run.id, effect.actionId)
		}
	}

	private async assertCompatible(): Promise<void> {
		await this.deps.assertCompatibleRelays?.()
	}

	private heartbeat(): void {
		if (!this.db.heartbeatRelayInstance(this.relay)) {
			this.db.registerRelayInstance({ ...this.relay, canDriveUi: true })
		}
	}
}
