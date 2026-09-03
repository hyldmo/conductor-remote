import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import type { DelegationProjection } from '../lib/types.ts'
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

/** Compact workspace-level view of every live delegation, above the transcript. */
export function DelegationPipeline({
	jobs,
	activeSessionId,
	onSelectSession
}: {
	jobs: DelegationProjection[]
	activeSessionId?: string | null
	onSelectSession: (sessionId: string) => void
}) {
	if (!jobs.length) return null
	return (
		<nav
			aria-label="Delegated work"
			className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-soft bg-bg px-3 py-2"
		>
			{jobs.map((job, index) => {
				const failed = job.status === 'failed'
				const selected = !!job.childSessionId && job.childSessionId === activeSessionId
				const contents = (
					<>
						<ProviderMark agentType={job.resolvedRole.agentType} model={job.resolvedRole.model} className="size-3.5" />
						<span className="max-w-24 truncate font-medium">{job.role}</span>
						<span className="max-w-28 truncate text-faint">{job.resolvedRole.model}</span>
						<span className={cn('flex shrink-0 items-center gap-1', failed ? 'text-del' : 'text-muted')}>
							{failed ? <AlertTriangle size={10} /> : <Loader2 size={10} className="animate-spin" />}
							{STATUS_LABELS[job.status]}
						</span>
					</>
				)
				return (
					<div key={job.id} className="flex shrink-0 items-center gap-1.5">
						{index ? <ArrowRight size={11} className="shrink-0 text-faint" /> : null}
						{job.childSessionId ? (
							<button
								type="button"
								onClick={() => onSelectSession(job.childSessionId as string)}
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
