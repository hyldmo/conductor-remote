import type { DelegationProjection, Session, SessionRoleAssignment, WorkflowRunWire } from '../../lib/types.ts'
import { PipelineTabs, pipelineTabs } from './AgentSubtabs.tsx'
import { WorkflowSummary } from './WorkflowSummary.tsx'

/** Role-aware child tabs plus an explicit managed-run summary. */
export function DelegationPipeline({
	workflow,
	jobs,
	sessions = [],
	roles = {},
	activeSessionId,
	onSelectSession
}: {
	workflow?: WorkflowRunWire
	jobs: DelegationProjection[]
	sessions?: Session[]
	roles?: Record<string, SessionRoleAssignment>
	activeSessionId?: string | null
	onSelectSession: (sessionId: string) => void
}) {
	const workflowTabs = workflow ? pipelineTabs(jobs, sessions, roles, workflow.id) : []
	const bootstrapJob = workflow ? jobs.find(job => job.workflowId === workflow.id && job.bootstrap) : undefined
	const delegatedTabs = pipelineTabs(jobs, sessions, roles, null)
	if (!workflow && !delegatedTabs.length) return null
	return (
		<>
			{workflow ? (
				<WorkflowSummary
					workflow={workflow}
					bootstrapJob={bootstrapJob}
					rootSession={sessions.find(session => session.id === workflow.rootSessionId)}
				/>
			) : null}
			<PipelineTabs
				tabs={workflowTabs}
				label="Workflow jobs"
				activeSessionId={activeSessionId}
				onSelectSession={onSelectSession}
			/>
			<PipelineTabs
				tabs={delegatedTabs}
				label="Delegated agents"
				activeSessionId={activeSessionId}
				onSelectSession={onSelectSession}
			/>
		</>
	)
}
