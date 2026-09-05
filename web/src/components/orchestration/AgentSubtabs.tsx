import { AlertTriangle, ArrowRight, CheckCircle2, Hourglass, Loader2 } from 'lucide-react'
import { displayedModelPickerLabel } from '../../../../src/shared.ts'
import { cn } from '../../lib/cn.ts'
import type { DelegationProjection, Session, SessionRoleAssignment } from '../../lib/types.ts'
import { ProviderMark } from '../agents/AgentIcons.tsx'
import { STATUS_LABELS } from './labels.ts'

interface PipelineTab {
	key: string
	order: number
	role: string
	model: string | null
	agentType: string | null
	childSessionId?: string
	status?: string
	state?: 'busy' | 'waiting' | 'failed' | 'done'
}

/** One real workflow child or virtual provider-native child in the shared agent strip. */
export interface AgentSubtab {
	key: string
	label: string
	model: string | null
	agentType: string | null
	status?: string
	state?: 'busy' | 'waiting' | 'failed' | 'done'
	selected?: boolean
	onSelect?: () => void
}

export function pipelineTabs(
	jobs: DelegationProjection[],
	sessions: Session[],
	roles: Record<string, SessionRoleAssignment>,
	workflowId: string | null
): PipelineTab[] {
	const inScope = (candidateWorkflowId: string | undefined) =>
		workflowId === null ? !candidateWorkflowId : candidateWorkflowId === workflowId
	const scopedJobs = jobs.filter(job => inScope(job.workflowId))
	const registeredChildren = sessions.flatMap(session => {
		const assignment = roles[session.id]
		const delegationId = assignment?.delegationId
		return delegationId && inScope(assignment.workflowId) ? [{ session, assignment, delegationId }] : []
	})
	const registeredByDelegation = new Map(registeredChildren.map(child => [child.delegationId, child]))
	const activeJobIds = new Set(scopedJobs.map(job => job.id))
	const tabs: PipelineTab[] = scopedJobs.map(job => ({
		key: `job:${job.id}`,
		order: job.createdAt,
		role: job.bootstrap ? 'Guaranteed explorer' : job.role,
		model: job.resolvedRole.model,
		agentType: job.resolvedRole.agentType,
		childSessionId: job.childSessionId ?? registeredByDelegation.get(job.id)?.session.id,
		status: STATUS_LABELS[job.status],
		state: job.status === 'failed' ? 'failed' : job.status === 'returned' ? 'done' : 'busy'
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
					: { status: 'Returned', state: 'done' as const })
		})
	}

	return tabs.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

export function PipelineTabs({
	tabs,
	label,
	activeSessionId,
	onSelectSession
}: {
	tabs: PipelineTab[]
	label: string
	activeSessionId?: string | null
	onSelectSession: (sessionId: string) => void
}) {
	return (
		<AgentSubtabStrip
			label={label}
			tabs={tabs.map(tab => {
				const childSessionId = tab.childSessionId
				return {
					key: tab.key,
					label: tab.role,
					model: tab.model,
					agentType: tab.agentType,
					status: tab.status,
					state: tab.state,
					selected: !!childSessionId && childSessionId === activeSessionId,
					...(childSessionId ? { onSelect: () => onSelectSession(childSessionId) } : {})
				}
			})}
		/>
	)
}

/**
 * The product's second navigation level: compact provider-aware agent tabs.
 *
 * Workflow children use real session ids; native subagents use spawning tool ids.
 * Keeping the presentation address-agnostic lets both preserve the same visual
 * hierarchy without pretending a native child is a promptable Conductor chat.
 */
export function AgentSubtabStrip({ tabs, label }: { tabs: AgentSubtab[]; label: string }) {
	if (!tabs.length) return null
	return (
		<nav
			aria-label={label}
			className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-soft bg-bg px-3 py-2"
		>
			{tabs.map((tab, index) => {
				const failed = tab.state === 'failed'
				const contents = (
					<>
						<ProviderMark agentType={tab.agentType} model={tab.model} monochrome={tab.selected} className="size-3.5" />
						<span className="max-w-28 truncate font-medium">{tab.label}</span>
						{tab.model ? (
							<span className={cn('max-w-28 truncate', tab.selected ? 'text-bg/75' : 'text-faint')}>
								{displayedModelPickerLabel(tab.model)}
							</span>
						) : null}
						{tab.status ? (
							<span
								className={cn(
									'flex shrink-0 items-center gap-1',
									tab.selected ? 'text-bg/75' : failed ? 'text-del' : 'text-muted'
								)}
							>
								{tab.state === 'failed' ? (
									<AlertTriangle size={10} />
								) : tab.state === 'waiting' ? (
									<Hourglass size={10} />
								) : tab.state === 'done' ? (
									<CheckCircle2 size={10} />
								) : (
									<Loader2 size={10} className="animate-spin" />
								)}
								{tab.status}
							</span>
						) : null}
					</>
				)
				return (
					<div key={tab.key} className="flex shrink-0 items-center gap-1.5">
						{index ? <ArrowRight size={11} className="shrink-0 text-faint" /> : null}
						{tab.onSelect ? (
							<button
								type="button"
								onClick={tab.onSelect}
								aria-current={tab.selected ? 'page' : undefined}
								className={cn(
									'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11px]',
									tab.selected
										? 'border-text bg-text text-bg active:bg-text/90'
										: 'border-border-soft active:bg-surface-2',
									failed && !tab.selected && 'border-del/40'
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
