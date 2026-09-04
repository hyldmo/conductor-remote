import type { WorkflowChildRoleName, WorkflowPhase } from './wire.ts'

export type WorkflowCapabilityPhase = 'exploring' | 'planning' | 'reviewing'

export interface WorkflowCapabilityClaims {
	runId: string
	rootSessionId: string
	cycle: number
	revision: number
	phase: WorkflowCapabilityPhase
	allowedRoles: WorkflowChildRoleName[]
	consumed: boolean
	revoked: boolean
}

export interface WorkflowGuardRun {
	id: string
	rootSessionId: string | null
	phase: WorkflowPhase
	cycle: number
	revision: number
}

export interface WorkflowGuardJob {
	role: WorkflowChildRoleName
	cycle: number
	status: string
	/** Only a durable parent transcript row satisfies a Baton barrier. */
	batonReceiptKind?: 'outbox' | 'message'
}

export type WorkflowGuardErrorCode =
	| 'workflow_required'
	| 'workflow_authorization_failed'
	| 'workflow_phase_invalid'
	| 'workflow_blocked'

export class WorkflowGuardError extends Error {
	readonly code: WorkflowGuardErrorCode
	readonly status: 403 | 409

	constructor(code: WorkflowGuardErrorCode, message: string, status: 403 | 409 = 409) {
		super(message)
		this.name = 'WorkflowGuardError'
		this.code = code
		this.status = status
	}
}

export function isTerminalWorkflowPhase(
	phase: WorkflowPhase
): phase is Extract<WorkflowPhase, 'completed' | 'cancelled'> {
	return phase === 'completed' || phase === 'cancelled'
}

export function isTerminalWorkflowJobState(state: string): boolean {
	return state === 'returned' || state === 'failed' || state === 'cancelled'
}

/** Which managed child role the root may request at this evidence barrier. */
export function workflowAllowedRoles(phase: WorkflowPhase): readonly WorkflowChildRoleName[] {
	if (phase === 'exploring') return ['exploration']
	if (phase === 'planning' || phase === 'reviewing') return ['exploration', 'implementation']
	return []
}

export function workflowOutstandingJobs(jobs: WorkflowGuardJob[], cycle: number): WorkflowGuardJob[] {
	return jobs.filter(job => job.cycle === cycle && !isTerminalWorkflowJobState(job.status))
}

export function workflowExplorationBarrierSatisfied(jobs: WorkflowGuardJob[], cycle: number): boolean {
	const explorers = jobs.filter(job => job.cycle === cycle && job.role === 'exploration')
	return explorers.length > 0 && explorers.every(job => job.status === 'returned' && job.batonReceiptKind === 'message')
}

export function workflowImplementationBarrierSatisfied(jobs: WorkflowGuardJob[], cycle: number): boolean {
	const implementers = jobs.filter(job => job.cycle === cycle && job.role === 'implementation')
	return (
		implementers.length > 0 &&
		implementers.every(job => job.status === 'returned' && job.batonReceiptKind === 'message')
	)
}

/**
 * Validate a root delegation against the capability that was causally delivered
 * to that exact chat. This is intentionally pure; the caller still consumes or
 * rotates the matching database row in the same transaction that creates a job.
 */
export function assertWorkflowDelegation(
	run: WorkflowGuardRun | null,
	claims: WorkflowCapabilityClaims | null,
	request: { sessionId: string; role: WorkflowChildRoleName },
	jobs: WorkflowGuardJob[]
): void {
	if (!run) {
		throw new WorkflowGuardError(
			'workflow_required',
			'delegate_task is available only inside a UI-authorized Workflow.'
		)
	}
	if (run.phase === 'blocked') {
		throw new WorkflowGuardError('workflow_blocked', 'This Workflow is blocked and needs recovery from the phone.')
	}
	if (isTerminalWorkflowPhase(run.phase)) {
		throw new WorkflowGuardError('workflow_phase_invalid', `This Workflow is ${run.phase}.`)
	}
	if (!run.rootSessionId || request.sessionId !== run.rootSessionId) {
		throw new WorkflowGuardError(
			'workflow_authorization_failed',
			'The phase capability does not authorize this root session.',
			403
		)
	}
	if (
		!claims ||
		claims.consumed ||
		claims.revoked ||
		claims.runId !== run.id ||
		claims.rootSessionId !== run.rootSessionId
	) {
		throw new WorkflowGuardError(
			'workflow_authorization_failed',
			'The phase capability is missing, invalid, consumed, or revoked.',
			403
		)
	}
	if (
		claims.cycle !== run.cycle ||
		claims.revision !== run.revision ||
		claims.phase !== run.phase ||
		!claims.allowedRoles.includes(request.role)
	) {
		throw new WorkflowGuardError(
			'workflow_phase_invalid',
			'That phase capability is stale or does not permit the requested role.'
		)
	}
	if (!workflowAllowedRoles(run.phase).includes(request.role)) {
		throw new WorkflowGuardError(
			'workflow_phase_invalid',
			`Role ${request.role} cannot start while the Workflow is ${run.phase}.`
		)
	}
	const outstanding = workflowOutstandingJobs(jobs, run.cycle)
	const conflicting =
		run.phase === 'exploring' && request.role === 'exploration'
			? outstanding.some(job => job.role === 'implementation')
			: outstanding.length > 0
	if (conflicting) {
		throw new WorkflowGuardError(
			'workflow_phase_invalid',
			'The current Workflow job must return before another phase can start.'
		)
	}
	if (request.role === 'implementation' && !workflowExplorationBarrierSatisfied(jobs, run.cycle)) {
		throw new WorkflowGuardError(
			'workflow_phase_invalid',
			'Implementation remains closed until every current explorer Baton is delivered.'
		)
	}
}

export interface WorkflowDelegationTransition {
	phase: 'exploring' | 'implementing'
	cycle: number
	revision: number
	logicalPrefix: 'explore' | 'implement'
}

/** The transition materialized atomically beside capability consumption and job creation. */
export function workflowDelegationTransition(
	run: WorkflowGuardRun,
	role: WorkflowChildRoleName
): WorkflowDelegationTransition {
	if (role === 'implementation') {
		return {
			phase: 'implementing',
			cycle: run.cycle,
			revision: run.revision + 1,
			logicalPrefix: 'implement'
		}
	}
	if (run.phase === 'exploring') {
		return {
			phase: 'exploring',
			cycle: run.cycle,
			revision: run.revision + 1,
			logicalPrefix: 'explore'
		}
	}
	return {
		phase: 'exploring',
		cycle: run.cycle + 1,
		revision: 0,
		logicalPrefix: 'explore'
	}
}

/** Delivered Batons, never merely accepted outbox rows, open the next root phase. */
export function phaseAfterDeliveredBaton(
	role: WorkflowChildRoleName,
	jobs: WorkflowGuardJob[],
	cycle: number
): 'planning' | 'reviewing' | null {
	if (role === 'exploration') return workflowExplorationBarrierSatisfied(jobs, cycle) ? 'planning' : null
	return workflowImplementationBarrierSatisfied(jobs, cycle) ? 'reviewing' : null
}
