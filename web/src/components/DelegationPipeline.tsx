import { AlertTriangle, ArrowRight, Hourglass, Loader2 } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import type { DelegationProjection, Session, SessionRoleAssignment } from '../lib/types.ts'
import { ProviderMark } from './AgentIcons.tsx'
import { Markdown } from './Markdown.tsx'
import { QueueBubble, type QueueBubbleAction } from './QueueBubble.tsx'

const STATUS_LABELS: Record<DelegationProjection['status'], string> = {
	queued: 'Queued',
	opening: 'Opening',
	configuring: 'Configuring',
	sending: 'Sending',
	running: 'Running',
	returning: 'Returning',
	returned: 'Returned',
	failed: 'Failed'
}

interface PipelineTab {
	key: string
	order: number
	role: string
	model: string | null
	agentType: string | null
	childSessionId?: string
	status?: string
	state?: 'busy' | 'waiting' | 'failed'
}

function pipelineTabs(
	jobs: DelegationProjection[],
	sessions: Session[],
	roles: Record<string, SessionRoleAssignment>
): PipelineTab[] {
	const registeredChildren = sessions.flatMap(session => {
		const assignment = roles[session.id]
		const delegationId = assignment?.delegationId
		return delegationId ? [{ session, assignment, delegationId }] : []
	})
	const registeredByDelegation = new Map(registeredChildren.map(child => [child.delegationId, child]))
	const activeJobIds = new Set(jobs.map(job => job.id))
	const tabs: PipelineTab[] = jobs.map(job => ({
		key: `job:${job.id}`,
		order: job.createdAt,
		role: job.role,
		model: job.resolvedRole.model,
		agentType: job.resolvedRole.agentType,
		childSessionId: job.childSessionId ?? registeredByDelegation.get(job.id)?.session.id,
		status: STATUS_LABELS[job.status],
		state: job.status === 'failed' ? 'failed' : 'busy'
	}))

	for (const { session, assignment, delegationId } of registeredChildren) {
		if (activeJobIds.has(delegationId)) continue
		const waiting = Boolean(session.background_tasks.length)
		const working = session.status === 'working'
		tabs.push({
			key: `session:${session.id}`,
			order: assignment.assignedAt,
			role: assignment.role,
			model: session.model,
			agentType: session.agent_type,
			childSessionId: session.id,
			...(working
				? { status: 'Running', state: 'busy' as const }
				: waiting
					? { status: 'Waiting', state: 'waiting' as const }
					: {})
		})
	}

	return tabs.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

/** Role-aware child tabs; live delegation jobs add their current pipeline state. */
export function DelegationPipeline({
	jobs,
	sessions = [],
	roles = {},
	activeSessionId,
	onSelectSession
}: {
	jobs: DelegationProjection[]
	sessions?: Session[]
	roles?: Record<string, SessionRoleAssignment>
	activeSessionId?: string | null
	onSelectSession: (sessionId: string) => void
}) {
	const tabs = pipelineTabs(jobs, sessions, roles)
	if (!tabs.length) return null
	return (
		<nav
			aria-label="Delegated work"
			className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-soft bg-bg px-3 py-2"
		>
			{tabs.map((tab, index) => {
				const failed = tab.state === 'failed'
				const selected = !!tab.childSessionId && tab.childSessionId === activeSessionId
				const contents = (
					<>
						<ProviderMark agentType={tab.agentType} model={tab.model} className="size-3.5" />
						<span className="max-w-24 truncate font-medium">{tab.role}</span>
						{tab.model ? <span className="max-w-28 truncate text-faint">{tab.model}</span> : null}
						{tab.status ? (
							<span className={cn('flex shrink-0 items-center gap-1', failed ? 'text-del' : 'text-muted')}>
								{tab.state === 'failed' ? (
									<AlertTriangle size={10} />
								) : tab.state === 'waiting' ? (
									<Hourglass size={10} />
								) : (
									<Loader2 size={10} className="animate-spin" />
								)}
								{tab.status}
							</span>
						) : null}
					</>
				)
				const childSessionId = tab.childSessionId
				return (
					<div key={tab.key} className="flex shrink-0 items-center gap-1.5">
						{index ? <ArrowRight size={11} className="shrink-0 text-faint" /> : null}
						{childSessionId ? (
							<button
								type="button"
								onClick={() => onSelectSession(childSessionId)}
								className={cn(
									'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border-soft px-2 text-[11px] active:bg-surface-2',
									selected && 'border-accent/50 bg-surface-2',
									failed && 'border-del/40'
								)}
							>
								{contents}
							</button>
						) : (
							<div
								className={cn(
									'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border-soft px-2 text-[11px]',
									failed && 'border-del/40'
								)}
							>
								{contents}
							</div>
						)}
					</div>
				)
			})}
		</nav>
	)
}

export function delegationStatusLabel(status: DelegationProjection['status']): string {
	return STATUS_LABELS[status]
}

/** Parent/child transcript cards for the jobs involving the chat on screen. */
export function DelegationBubbles({
	jobs,
	sessionId,
	onSelectSession,
	onDismiss,
	onOpenRoles
}: {
	jobs: DelegationProjection[]
	sessionId: string | null
	onSelectSession: (sessionId: string) => void
	onDismiss: (delegationId: string) => void
	onOpenRoles: () => void
}) {
	if (!sessionId) return null
	const visible = jobs.filter(job => job.parentSessionId === sessionId || job.childSessionId === sessionId)
	if (!visible.length) return null
	return (
		<>
			{visible.map(job => {
				const parent = job.parentSessionId === sessionId
				const failed = job.status === 'failed'
				const peer = parent ? job.childSessionId : job.parentSessionId
				const actions: QueueBubbleAction[] = []
				if (peer) actions.push({ label: parent ? 'Open worker' : 'Open parent', onClick: () => onSelectSession(peer) })
				if (failed) {
					actions.push({ label: 'Edit roles', onClick: onOpenRoles, primary: true })
					actions.push({ label: 'Dismiss delegation', onClick: () => onDismiss(job.id) })
				}
				return (
					<QueueBubble
						key={job.id}
						state={failed ? 'failed' : 'pending'}
						align="wide"
						label={`${parent ? 'Delegated' : 'Assigned'} · ${job.role} · ${job.resolvedRole.model}${job.resolvedRole.effort ? ` · ${job.resolvedRole.effort}` : ''}`}
						meta={
							failed
								? `${job.failure?.code ?? 'failed'}: ${job.failure?.message ?? 'The delegated job failed.'}`
								: `${delegationStatusLabel(job.status)}${job.attempts ? ` · attempt ${job.attempts + 1}` : ''}`
						}
						actions={actions}
						dataMessageState={`delegation-${job.status}`}
					>
						<Markdown>{job.prompt}</Markdown>
					</QueueBubble>
				)
			})}
		</>
	)
}
