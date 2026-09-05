import type { DelegationProjection, SessionRoleAssignment, WorkflowRunWire } from '../../lib/types.ts'

/** Resolve Workflow ownership from the exact chat, never from a workspace-level display fallback. */
export function workflowForActiveSession(
	workflows: readonly WorkflowRunWire[],
	sessionId: string | null,
	roles: Readonly<Record<string, SessionRoleAssignment>>,
	jobs: readonly DelegationProjection[]
): WorkflowRunWire | undefined {
	if (!sessionId) return undefined
	const root = workflows.find(workflow => workflow.rootSessionId === sessionId)
	if (root) return root
	const assignedWorkflowId = roles[sessionId]?.workflowId
	if (assignedWorkflowId) {
		const assigned = workflows.find(workflow => workflow.id === assignedWorkflowId)
		if (assigned) return assigned
	}
	const jobWorkflowId = jobs.find(job => job.childSessionId === sessionId && job.workflowId)?.workflowId
	return jobWorkflowId ? workflows.find(workflow => workflow.id === jobWorkflowId) : undefined
}

interface DelegationPipelineSelection {
	parentSessionId: string
	workflow?: WorkflowRunWire
	jobs: DelegationProjection[]
	roles: Record<string, SessionRoleAssignment>
}

/** Child tabs belong beneath their parent chat, never whichever top-level tab happens to be open. */
export function delegationPipelineForParentSession(
	workflows: readonly WorkflowRunWire[],
	jobs: readonly DelegationProjection[],
	roles: Readonly<Record<string, SessionRoleAssignment>>,
	sessionId: string | null
): DelegationPipelineSelection | undefined {
	if (!sessionId) return undefined
	const workflow = workflows.find(candidate => candidate.rootSessionId === sessionId)
	const parentJobs = jobs.filter(job => job.parentSessionId === sessionId)
	const activeAssignment = roles[sessionId]
	const hasPersistedChildren = Object.values(roles).some(assignment => assignment.parentSessionId === sessionId)
	const hasPersistedLegacyChildren = Object.values(roles).some(
		assignment => assignment.delegationId && !assignment.workflowId && !assignment.parentSessionId
	)
	// Legacy jobs were deleted after returning, while their role assignments survived.
	// Their old role document did not record the parent id, but did mark that parent as
	// planning; keep those completed children reachable only from that parent tab.
	const isLegacyParent =
		activeAssignment?.role === 'planning' &&
		!activeAssignment.delegationId &&
		!activeAssignment.workflowId &&
		hasPersistedLegacyChildren
	if (!workflow && !parentJobs.length && !hasPersistedChildren && !isLegacyParent) return undefined

	const parentLegacyJobIds = new Set(parentJobs.filter(job => !job.workflowId).map(job => job.id))
	const scopedRoles = Object.fromEntries(
		Object.entries(roles).filter(([candidateId, assignment]) => {
			if (candidateId === sessionId) return !assignment.delegationId
			if (assignment.workflowId) return assignment.workflowId === workflow?.id
			if (!assignment.delegationId) return false
			if (assignment.parentSessionId) return assignment.parentSessionId === sessionId
			return isLegacyParent || parentLegacyJobIds.has(assignment.delegationId)
		})
	)

	return { parentSessionId: sessionId, workflow, jobs: parentJobs, roles: scopedRoles }
}

/** Keep each ancestor's sibling tabs reachable while reading a delegated child. */
export function delegationPipelinesForSession(
	workflows: readonly WorkflowRunWire[],
	jobs: readonly DelegationProjection[],
	roles: Readonly<Record<string, SessionRoleAssignment>>,
	sessionId: string | null
): DelegationPipelineSelection[] {
	const pipelines: DelegationPipelineSelection[] = []
	const visited = new Set<string>()
	let currentId = sessionId
	while (currentId && !visited.has(currentId)) {
		visited.add(currentId)
		const pipeline = delegationPipelineForParentSession(workflows, jobs, roles, currentId)
		if (pipeline) pipelines.unshift(pipeline)

		const assignment = roles[currentId]
		const job = jobs.find(candidate => candidate.childSessionId === currentId)
		const workflow = workflowForActiveSession(workflows, currentId, roles, jobs)
		const legacyParentIds =
			assignment?.delegationId && !assignment.workflowId && !assignment.parentSessionId && !job
				? Object.keys(roles).filter(candidateId => {
						const candidate = roles[candidateId]
						return candidate.role === 'planning' && !candidate.delegationId && !candidate.workflowId
					})
				: []
		const legacyParentId = legacyParentIds.length === 1 ? legacyParentIds[0] : undefined
		currentId = assignment?.parentSessionId ?? job?.parentSessionId ?? workflow?.rootSessionId ?? legacyParentId ?? null
	}
	return pipelines
}
