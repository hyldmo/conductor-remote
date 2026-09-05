import {
	consumeWorkflowCapability,
	getWorkflowCapability,
	issueWorkflowCapability,
	revokeWorkflowCapabilities
} from './capabilities.ts'
import { PersistenceConnection } from './connection.ts'
import {
	markWorkflowEffectReceiptLost,
	reconcileAbandonedWorkflowEffect,
	recordLateWorkflowEffect,
	replayAmbiguousWorkflowEffect,
	retryWorkflowEffect
} from './effect-recovery.ts'
import {
	markWorkflowConfigurationRejected,
	markWorkflowEffectAmbiguous,
	markWorkflowEffectCancelled,
	markWorkflowEffectCommitted,
	markWorkflowEffectDispatched,
	markWorkflowEffectFailed,
	markWorkflowEffectFailedBeforeMayExecute,
	markWorkflowEffectMayExecute
} from './effect-transitions.ts'
import {
	claimPreparedWorkflowEffect,
	markWorkflowEffectSatisfiedWithoutDispatch,
	prepareWorkflowEffect
} from './effects.ts'
import { listWorkflowEvents, recordWorkflowObservation } from './events.ts'
import { getIdempotentMutation, idempotentMutation } from './idempotency.ts'
import { createWorkflowJobAttempt, recordLateWorkflowChildResult, updateWorkflowJobAttempt } from './job-attempts.ts'
import {
	activateWorkflowJob,
	claimNextWorkflowJob,
	createWorkflowJob,
	reconcileAbandonedWorkflowJobClaim,
	updateWorkflowJob
} from './jobs.ts'
import {
	compactTerminalRuns,
	getWorkflowProjection,
	listLatestWorkflowProjectionsForWorkspaces,
	listWorkflowProjections,
	listWorkflowRunIdsNeedingWake
} from './projections.ts'
import { activateUiQuarantine, clearUiQuarantine, getUiQuarantine } from './quarantine.ts'
import {
	findActiveWorkflowByRoot,
	getWorkflowEffect,
	getWorkflowJob,
	getWorkflowRun,
	listWorkflowEffectAttempts,
	listWorkflowEffects,
	listWorkflowJobAttempts,
	listWorkflowJobs
} from './records.ts'
import {
	findIncompatibleRelayInstances,
	heartbeatRelayInstance,
	listRelayInstances,
	registerRelayInstance
} from './relays.ts'
import { cancelWorkflowRun, createWorkflowRun, transitionWorkflowRun } from './runs.ts'
import type { OrchestrationDbOptions } from './types.ts'
import {
	acquireUiLease,
	createSharedUiLeaseProvider,
	getUiLeaseOwner,
	markUiLeaseMayExecute,
	releaseUiLease,
	renewUiLease
} from './ui-lease.ts'

export type { WorkflowPhase, WorkflowRoleName } from '../../wire.ts'
export type { FrozenWorkflowRole, FrozenWorkflowRoles } from '../workflow/prompts.ts'
export * from './errors.ts'
export { canonicalRequestHash, canonicalRequestJson, hashCapabilityToken } from './idempotency.ts'
export {
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkflowAdoptionCandidate,
	type WorkflowEffectState,
	type WorkflowJobRole,
	type WorkflowJobState,
	type WorkflowRetryClass,
	type WorkflowTarget
} from './schema.ts'
export * from './types.ts'

type OperationArgs<Operation> = Operation extends (context: PersistenceConnection, ...args: infer Args) => unknown
	? Args
	: never

/** One connection owns every nested transaction; domain operations never open a second handle. */
export class OrchestrationDb {
	private readonly connection: PersistenceConnection
	constructor(file: string, options: OrchestrationDbOptions = {}) {
		this.connection = new PersistenceConnection(file, options)
	}
	get schemaVersion() {
		return this.connection.schemaVersion
	}
	get writable() {
		return this.connection.writable
	}
	get schemaWarning() {
		return this.connection.schemaWarning
	}
	close(): void {
		this.connection.close()
	}
	idempotentMutation<T>(
		operation: string,
		clientId: string,
		request: unknown,
		mutate: () => T,
		link: { runId?: string; actionId?: string } = {}
	): { replayed: boolean; result: T } {
		return idempotentMutation<T>(this.connection, operation, clientId, request, mutate, link)
	}

	getIdempotentMutation<T>(operation: string, clientId: string, request: unknown): { result: T } | undefined {
		return getIdempotentMutation<T>(this.connection, operation, clientId, request)
	}

	createWorkflowRun = (...args: OperationArgs<typeof createWorkflowRun>) => createWorkflowRun(this.connection, ...args)

	getWorkflowRun = (...args: OperationArgs<typeof getWorkflowRun>) => getWorkflowRun(this.connection, ...args)

	findActiveWorkflowByRoot = (...args: OperationArgs<typeof findActiveWorkflowByRoot>) =>
		findActiveWorkflowByRoot(this.connection, ...args)

	transitionWorkflowRun = (...args: OperationArgs<typeof transitionWorkflowRun>) =>
		transitionWorkflowRun(this.connection, ...args)

	cancelWorkflowRun = (...args: OperationArgs<typeof cancelWorkflowRun>) => cancelWorkflowRun(this.connection, ...args)

	createWorkflowJob = (...args: OperationArgs<typeof createWorkflowJob>) => createWorkflowJob(this.connection, ...args)

	activateWorkflowJob = (...args: OperationArgs<typeof activateWorkflowJob>) =>
		activateWorkflowJob(this.connection, ...args)

	getWorkflowJob = (...args: OperationArgs<typeof getWorkflowJob>) => getWorkflowJob(this.connection, ...args)

	listWorkflowJobs = (...args: OperationArgs<typeof listWorkflowJobs>) => listWorkflowJobs(this.connection, ...args)

	claimNextWorkflowJob = (...args: OperationArgs<typeof claimNextWorkflowJob>) =>
		claimNextWorkflowJob(this.connection, ...args)

	reconcileAbandonedWorkflowJobClaim = (...args: OperationArgs<typeof reconcileAbandonedWorkflowJobClaim>) =>
		reconcileAbandonedWorkflowJobClaim(this.connection, ...args)

	updateWorkflowJob = (...args: OperationArgs<typeof updateWorkflowJob>) => updateWorkflowJob(this.connection, ...args)

	createWorkflowJobAttempt = (...args: OperationArgs<typeof createWorkflowJobAttempt>) =>
		createWorkflowJobAttempt(this.connection, ...args)

	listWorkflowJobAttempts = (...args: OperationArgs<typeof listWorkflowJobAttempts>) =>
		listWorkflowJobAttempts(this.connection, ...args)

	updateWorkflowJobAttempt = (...args: OperationArgs<typeof updateWorkflowJobAttempt>) =>
		updateWorkflowJobAttempt(this.connection, ...args)

	recordLateWorkflowChildResult = (...args: OperationArgs<typeof recordLateWorkflowChildResult>) =>
		recordLateWorkflowChildResult(this.connection, ...args)

	prepareWorkflowEffect = (...args: OperationArgs<typeof prepareWorkflowEffect>) =>
		prepareWorkflowEffect(this.connection, ...args)

	getWorkflowEffect = (...args: OperationArgs<typeof getWorkflowEffect>) => getWorkflowEffect(this.connection, ...args)

	listWorkflowEffects = (...args: OperationArgs<typeof listWorkflowEffects>) =>
		listWorkflowEffects(this.connection, ...args)

	markWorkflowEffectSatisfiedWithoutDispatch = (
		...args: OperationArgs<typeof markWorkflowEffectSatisfiedWithoutDispatch>
	) => markWorkflowEffectSatisfiedWithoutDispatch(this.connection, ...args)

	claimPreparedWorkflowEffect = (...args: OperationArgs<typeof claimPreparedWorkflowEffect>) =>
		claimPreparedWorkflowEffect(this.connection, ...args)

	markWorkflowEffectDispatched = (...args: OperationArgs<typeof markWorkflowEffectDispatched>) =>
		markWorkflowEffectDispatched(this.connection, ...args)

	markWorkflowEffectMayExecute = (...args: OperationArgs<typeof markWorkflowEffectMayExecute>) =>
		markWorkflowEffectMayExecute(this.connection, ...args)

	markWorkflowEffectCommitted = (...args: OperationArgs<typeof markWorkflowEffectCommitted>) =>
		markWorkflowEffectCommitted(this.connection, ...args)

	markWorkflowEffectFailed = (...args: OperationArgs<typeof markWorkflowEffectFailed>) =>
		markWorkflowEffectFailed(this.connection, ...args)
	markWorkflowConfigurationRejected = (...args: OperationArgs<typeof markWorkflowConfigurationRejected>) =>
		markWorkflowConfigurationRejected(this.connection, ...args)

	markWorkflowEffectFailedBeforeMayExecute = (
		...args: OperationArgs<typeof markWorkflowEffectFailedBeforeMayExecute>
	) => markWorkflowEffectFailedBeforeMayExecute(this.connection, ...args)

	markWorkflowEffectAmbiguous = (...args: OperationArgs<typeof markWorkflowEffectAmbiguous>) =>
		markWorkflowEffectAmbiguous(this.connection, ...args)

	markWorkflowEffectReceiptLost = (...args: OperationArgs<typeof markWorkflowEffectReceiptLost>) =>
		markWorkflowEffectReceiptLost(this.connection, ...args)

	recordLateWorkflowEffect = (...args: OperationArgs<typeof recordLateWorkflowEffect>) =>
		recordLateWorkflowEffect(this.connection, ...args)

	markWorkflowEffectCancelled = (...args: OperationArgs<typeof markWorkflowEffectCancelled>) =>
		markWorkflowEffectCancelled(this.connection, ...args)

	reconcileAbandonedWorkflowEffect = (...args: OperationArgs<typeof reconcileAbandonedWorkflowEffect>) =>
		reconcileAbandonedWorkflowEffect(this.connection, ...args)

	retryWorkflowEffect = (...args: OperationArgs<typeof retryWorkflowEffect>) =>
		retryWorkflowEffect(this.connection, ...args)

	replayAmbiguousWorkflowEffect = (...args: OperationArgs<typeof replayAmbiguousWorkflowEffect>) =>
		replayAmbiguousWorkflowEffect(this.connection, ...args)

	listWorkflowEffectAttempts = (...args: OperationArgs<typeof listWorkflowEffectAttempts>) =>
		listWorkflowEffectAttempts(this.connection, ...args)

	getWorkflowCapability = (...args: OperationArgs<typeof getWorkflowCapability>) =>
		getWorkflowCapability(this.connection, ...args)

	issueWorkflowCapability = (...args: OperationArgs<typeof issueWorkflowCapability>) =>
		issueWorkflowCapability(this.connection, ...args)

	consumeWorkflowCapability = (...args: OperationArgs<typeof consumeWorkflowCapability>) =>
		consumeWorkflowCapability(this.connection, ...args)

	revokeWorkflowCapabilities = (...args: OperationArgs<typeof revokeWorkflowCapabilities>) =>
		revokeWorkflowCapabilities(this.connection, ...args)

	listWorkflowEvents = (...args: OperationArgs<typeof listWorkflowEvents>) =>
		listWorkflowEvents(this.connection, ...args)
	recordWorkflowObservation = (...args: OperationArgs<typeof recordWorkflowObservation>) =>
		recordWorkflowObservation(this.connection, ...args)

	registerRelayInstance = (...args: OperationArgs<typeof registerRelayInstance>) =>
		registerRelayInstance(this.connection, ...args)

	heartbeatRelayInstance = (...args: OperationArgs<typeof heartbeatRelayInstance>) =>
		heartbeatRelayInstance(this.connection, ...args)

	listRelayInstances = (...args: OperationArgs<typeof listRelayInstances>) =>
		listRelayInstances(this.connection, ...args)

	findIncompatibleRelayInstances = (...args: OperationArgs<typeof findIncompatibleRelayInstances>) =>
		findIncompatibleRelayInstances(this.connection, ...args)

	acquireUiLease = (...args: OperationArgs<typeof acquireUiLease>) => acquireUiLease(this.connection, ...args)

	markUiLeaseMayExecute = (...args: OperationArgs<typeof markUiLeaseMayExecute>) =>
		markUiLeaseMayExecute(this.connection, ...args)

	renewUiLease = (...args: OperationArgs<typeof renewUiLease>) => renewUiLease(this.connection, ...args)

	releaseUiLease = (...args: OperationArgs<typeof releaseUiLease>) => releaseUiLease(this.connection, ...args)

	getUiLeaseOwner = (...args: OperationArgs<typeof getUiLeaseOwner>) => getUiLeaseOwner(this.connection, ...args)

	createSharedUiLeaseProvider = (...args: OperationArgs<typeof createSharedUiLeaseProvider>) =>
		createSharedUiLeaseProvider(this.connection, ...args)

	activateUiQuarantine = (...args: OperationArgs<typeof activateUiQuarantine>) =>
		activateUiQuarantine(this.connection, ...args)

	clearUiQuarantine = (...args: OperationArgs<typeof clearUiQuarantine>) => clearUiQuarantine(this.connection, ...args)

	getUiQuarantine = (...args: OperationArgs<typeof getUiQuarantine>) => getUiQuarantine(this.connection, ...args)

	getWorkflowProjection = (...args: OperationArgs<typeof getWorkflowProjection>) =>
		getWorkflowProjection(this.connection, ...args)

	listWorkflowProjections = (...args: OperationArgs<typeof listWorkflowProjections>) =>
		listWorkflowProjections(this.connection, ...args)

	listLatestWorkflowProjectionsForWorkspaces = (
		...args: OperationArgs<typeof listLatestWorkflowProjectionsForWorkspaces>
	) => listLatestWorkflowProjectionsForWorkspaces(this.connection, ...args)

	listWorkflowRunIdsNeedingWake = (...args: OperationArgs<typeof listWorkflowRunIdsNeedingWake>) =>
		listWorkflowRunIdsNeedingWake(this.connection, ...args)

	compactTerminalRuns = (...args: OperationArgs<typeof compactTerminalRuns>) =>
		compactTerminalRuns(this.connection, ...args)
}
