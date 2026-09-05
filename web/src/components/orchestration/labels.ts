import type { DelegationProjection, PublicFrozenRole, WorkflowJobCounts, WorkflowPhase } from '../../lib/types.ts'

export const STATUS_LABELS: Record<DelegationProjection['status'], string> = {
	queued: 'Queued',
	opening: 'Opening',
	configuring: 'Configuring',
	sending: 'Sending',
	running: 'Running',
	returning: 'Returning Baton',
	returned: 'Baton delivered',
	failed: 'Failed'
}

const PHASE_LABELS: Record<WorkflowPhase, string> = {
	creating_workspace: 'Creating workspace',
	binding_root: 'Binding root',
	pending_root: 'Root delivery pending',
	exploring: 'Exploring',
	planning: 'Planning',
	implementing: 'Implementing',
	reviewing: 'Reviewing',
	blocked: 'Blocked',
	completed: 'Completed',
	cancelled: 'Cancelled'
}

export function workflowPhaseLabel(phase: WorkflowPhase): string {
	return PHASE_LABELS[phase]
}

export function acceptedPhase(phase: WorkflowPhase): boolean {
	return phase === 'creating_workspace' || phase === 'binding_root' || phase === 'pending_root'
}

export function countLabel(counts: WorkflowJobCounts): string {
	const pieces = [`${counts.requested} requested`]
	if (counts.running) pieces.push(`${counts.running} running`)
	if (counts.returned) pieces.push(`${counts.returned} returned`)
	if (counts.failed) pieces.push(`${counts.failed} failed`)
	return pieces.join(' · ')
}

export function frozenRoleLabel(role: PublicFrozenRole): string {
	return [role.model, role.effort, role.fast === undefined ? undefined : role.fast ? 'Fast' : 'Fast off']
		.filter(Boolean)
		.join(' · ')
}

export function delegationStatusLabel(status: DelegationProjection['status']): string {
	return STATUS_LABELS[status]
}
