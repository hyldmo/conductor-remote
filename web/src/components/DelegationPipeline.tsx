import {
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	Hourglass,
	Loader2,
	RotateCcw,
	ShieldCheck,
	Workflow as WorkflowIcon,
	X
} from 'lucide-react'
import { useState } from 'react'
import { useConfirmUiStable, useWorkflowActions } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import type {
	DelegationProjection,
	PublicFrozenRole,
	Session,
	SessionRoleAssignment,
	UiQuarantineWire,
	WorkflowJobCounts,
	WorkflowPhase,
	WorkflowRoleName,
	WorkflowRunWire
} from '../lib/types.ts'
import { ProviderMark } from './AgentIcons.tsx'
import { Markdown } from './Markdown.tsx'
import { QueueBubble, type QueueBubbleAction } from './QueueBubble.tsx'

const STATUS_LABELS: Record<DelegationProjection['status'], string> = {
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

function acceptedPhase(phase: WorkflowPhase): boolean {
	return phase === 'creating_workspace' || phase === 'binding_root' || phase === 'pending_root'
}

function countLabel(counts: WorkflowJobCounts): string {
	const pieces = [`${counts.requested} requested`]
	if (counts.running) pieces.push(`${counts.running} running`)
	if (counts.returned) pieces.push(`${counts.returned} returned`)
	if (counts.failed) pieces.push(`${counts.failed} failed`)
	return pieces.join(' · ')
}

function frozenRoleLabel(role: PublicFrozenRole): string {
	return [role.model, role.effort, role.fast === undefined ? undefined : role.fast ? 'Fast' : 'Fast off']
		.filter(Boolean)
		.join(' · ')
}

function WorkflowRole({ name, role }: { name: WorkflowRoleName; role: PublicFrozenRole }) {
	return (
		<div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1.5 text-[11px]">
			<ProviderMark agentType={role.agentType} model={role.model} className="size-3.5 shrink-0" />
			<span className="shrink-0 font-medium capitalize text-text">{name}</span>
			<span className="truncate text-muted">{frozenRoleLabel(role)}</span>
		</div>
	)
}

/**
 * Relay-wide safety hold, intentionally separate from a Workflow card: its
 * originating run may already be cancelled while the shared Conductor window
 * still needs a human stability acknowledgement.
 */
export function UiQuarantineBanner({ quarantine, className }: { quarantine?: UiQuarantineWire; className?: string }) {
	const confirmUiStable = useConfirmUiStable()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	if (!quarantine) return null

	const confirm = async () => {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await confirmUiStable(quarantine)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section
			aria-label="Conductor UI safety hold"
			role="alert"
			className={cn('shrink-0 border-b border-del/40 bg-del/10 px-3 py-2.5 text-xs', className)}
		>
			<div className="flex items-start gap-2">
				<AlertTriangle size={16} className="mt-0.5 shrink-0 text-del" />
				<div className="min-w-0 flex-1">
					<div className="font-semibold text-del">Automated Conductor UI writes are paused</div>
					<p className="mt-0.5 text-text">{quarantine.reason}</p>
					<p className="mt-1 text-muted">
						Inspect Conductor on your Mac. Continue only when its window is stable and no UI action is still in flight.
					</p>
					<div className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[10px] text-faint">
						<span>{new Date(quarantine.createdAt).toLocaleString()}</span>
						{quarantine.actionId ? <span className="max-w-full truncate">Action · {quarantine.actionId}</span> : null}
						{quarantine.effectId ? <span className="max-w-full truncate">Effect · {quarantine.effectId}</span> : null}
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() => void confirm()}
						className="mt-2 flex min-h-9 items-center gap-1.5 rounded-lg bg-del px-3 py-1.5 font-semibold text-white disabled:opacity-50"
					>
						{busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}I checked — Conductor is
						stable
					</button>
					{error ? (
						<p className="mt-1.5 text-del" role="alert">
							{error}
						</p>
					) : null}
				</div>
			</div>
		</section>
	)
}

/** Workflow must fail visibly when its durable state cannot be opened safely. */
export function WorkflowWarningBanner({ warning }: { warning?: string }) {
	if (!warning) return null
	return (
		<section
			aria-label="Workflow unavailable"
			role="alert"
			className="shrink-0 border-b border-del/40 bg-del/10 px-3 py-2.5 text-xs"
		>
			<div className="flex items-start gap-2">
				<AlertTriangle size={16} className="mt-0.5 shrink-0 text-del" />
				<div className="min-w-0">
					<div className="font-semibold text-del">Workflow is unavailable</div>
					<p className="mt-0.5 text-text">{warning}</p>
				</div>
			</div>
		</section>
	)
}

/**
 * Secret-free coordinator state and phone-only recovery controls. This component
 * receives a WorkflowRunWire directly; jobs never manufacture Workflow ownership.
 */
export function WorkflowSummary({
	workflow,
	bootstrapJob,
	compact = false
}: {
	workflow: WorkflowRunWire
	bootstrapJob?: DelegationProjection
	compact?: boolean
}) {
	const actions = useWorkflowActions()
	const [busy, setBusy] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [confirmReplay, setConfirmReplay] = useState(false)
	const [confirmCancel, setConfirmCancel] = useState(false)
	const explorers = workflow.jobs.exploration
	const extraExplorers = Math.max(0, explorers.requested - 1)
	const guaranteedState = bootstrapJob
		? STATUS_LABELS[bootstrapJob.status]
		: acceptedPhase(workflow.phase)
			? 'Waiting for root delivery'
			: 'Scheduled'

	const run = async (label: string, operation: () => Promise<unknown>) => {
		if (busy) return
		setBusy(label)
		setActionError(null)
		try {
			await operation()
			setConfirmReplay(false)
			setConfirmCancel(false)
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(null)
		}
	}

	return (
		<section
			aria-label={`Workflow ${workflowPhaseLabel(workflow.phase)}`}
			className={cn('border-b border-border-soft bg-bg px-3 py-2', compact && 'rounded-xl border')}
		>
			<div className="flex min-w-0 items-start gap-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
					{workflow.phase === 'blocked' ? (
						<AlertTriangle size={15} />
					) : workflow.phase === 'completed' ? (
						<CheckCircle2 size={15} />
					) : workflow.phase === 'cancelled' ? (
						<X size={15} />
					) : (
						<WorkflowIcon size={15} />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 text-xs font-semibold text-text">
							{acceptedPhase(workflow.phase) ? 'Workflow accepted' : workflowPhaseLabel(workflow.phase)}
						</span>
						{acceptedPhase(workflow.phase) ? (
							<span className="truncate text-[11px] text-muted">{workflowPhaseLabel(workflow.phase)}</span>
						) : null}
					</div>
					<p className="mt-0.5 line-clamp-2 text-xs text-muted">{workflow.objectiveExcerpt}</p>
					<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
						<span>
							Guaranteed explorer ·{' '}
							<span className={bootstrapJob?.status === 'failed' ? 'text-del' : 'text-text'}>{guaranteedState}</span>
						</span>
						<span>
							{extraExplorers
								? `${extraExplorers} extra explorer${extraExplorers === 1 ? '' : 's'}`
								: 'No extra explorers'}
						</span>
					</div>
				</div>
			</div>

			<div className="mt-2 grid gap-1 min-[560px]:grid-cols-3">
				{(['planning', 'exploration', 'implementation'] as const).map(name => (
					<WorkflowRole key={name} name={name} role={workflow.roles[name]} />
				))}
			</div>
			{compact ? null : (
				<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint">
					<span>Exploration · {countLabel(workflow.jobs.exploration)}</span>
					<span>Implementation · {countLabel(workflow.jobs.implementation)}</span>
				</div>
			)}

			{workflow.error ? (
				<div className="mt-2 rounded-lg border border-del/30 bg-del/5 px-2.5 py-2 text-xs text-del" role="alert">
					<div className="font-medium">{workflow.error.code}</div>
					<div>{workflow.error.message}</div>
				</div>
			) : null}
			{actionError ? (
				<div className="mt-2 text-xs text-del" role="alert">
					{actionError}
				</div>
			) : null}

			{workflow.actions.canAdopt && workflow.adoption ? (
				<div className="mt-2 rounded-lg border border-border-soft bg-surface px-2.5 py-2">
					<div className="text-xs font-medium text-text">Choose the {workflow.adoption.kind} the relay observed</div>
					{workflow.adoption.candidates.length ? (
						<div className="mt-1 flex flex-wrap gap-1">
							{workflow.adoption.candidates.map(candidate => (
								<button
									key={candidate.id}
									type="button"
									disabled={!!busy}
									onClick={() => void run(`adopt:${candidate.id}`, () => actions.adopt(workflow, candidate))}
									title={candidate.id}
									className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-left text-[11px] text-text disabled:opacity-50"
								>
									<span className="block font-medium">{candidate.title}</span>
									<span className="text-faint">
										{candidate.repo} · {new Date(candidate.createdAt).toLocaleString()} · {candidate.id.slice(0, 8)}
									</span>
								</button>
							))}
						</div>
					) : (
						<div className="mt-1 text-[11px] text-faint">No candidate remains eligible.</div>
					)}
				</div>
			) : null}

			{confirmReplay ? (
				<div className="mt-2 rounded-lg border border-del/30 bg-del/5 px-2.5 py-2 text-xs">
					<p className="text-del">
						The earlier UI action may already have happened. Replaying it can create a duplicate.
					</p>
					<div className="mt-1.5 flex gap-1.5">
						<button
							type="button"
							disabled={!!busy}
							onClick={() => void run('replay', () => actions.replay(workflow))}
							className="rounded-lg bg-del px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
						>
							Confirm replay
						</button>
						<button type="button" onClick={() => setConfirmReplay(false)} className="px-2 py-1 text-[11px] text-muted">
							Keep blocked
						</button>
					</div>
				</div>
			) : null}

			{confirmCancel ? (
				<div className="mt-2 rounded-lg border border-border-soft bg-surface px-2.5 py-2 text-xs">
					<p className="text-muted">Cancel orchestration only. Existing chats, turns, and worktrees stay in place.</p>
					<div className="mt-1.5 flex gap-1.5">
						<button
							type="button"
							disabled={!!busy}
							onClick={() => void run('cancel', () => actions.cancel(workflow))}
							className="rounded-lg border border-del/40 px-2 py-1 text-[11px] font-medium text-del disabled:opacity-50"
						>
							Confirm cancel
						</button>
						<button type="button" onClick={() => setConfirmCancel(false)} className="px-2 py-1 text-[11px] text-muted">
							Keep running
						</button>
					</div>
				</div>
			) : null}

			{workflow.actions.canRetry ||
			workflow.actions.canReplayAmbiguous ||
			workflow.actions.canComplete ||
			workflow.actions.canCancel ? (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{workflow.actions.canRetry ? (
						<button
							type="button"
							disabled={!!busy}
							onClick={() => void run('retry', () => actions.retry(workflow))}
							className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-on-solid disabled:opacity-50"
						>
							{busy === 'retry' ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
							Retry saved action
						</button>
					) : null}
					{workflow.actions.canReplayAmbiguous && !confirmReplay ? (
						<button
							type="button"
							disabled={!!busy}
							onClick={() => setConfirmReplay(true)}
							className="rounded-lg border border-del/40 px-2 py-1 text-[11px] font-medium text-del disabled:opacity-50"
						>
							Review risky replay
						</button>
					) : null}
					{workflow.actions.canComplete ? (
						<button
							type="button"
							disabled={!!busy}
							onClick={() => void run('complete', () => actions.complete(workflow))}
							className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-on-solid disabled:opacity-50"
						>
							<ShieldCheck size={11} /> Mark complete
						</button>
					) : null}
					{workflow.actions.canCancel && !confirmCancel ? (
						<button
							type="button"
							disabled={!!busy}
							onClick={() => setConfirmCancel(true)}
							className="rounded-lg px-2 py-1 text-[11px] text-muted disabled:opacity-50"
						>
							Cancel workflow
						</button>
					) : null}
				</div>
			) : null}
		</section>
	)
}

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

function pipelineTabs(
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

function PipelineTabs({
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
			{label.startsWith('Legacy') ? (
				<span className="shrink-0 text-[10px] font-medium uppercase text-faint">Legacy</span>
			) : null}
			{tabs.map((tab, index) => {
				const failed = tab.state === 'failed'
				const contents = (
					<>
						<ProviderMark agentType={tab.agentType} model={tab.model} className="size-3.5" />
						<span className="max-w-28 truncate font-medium">{tab.label}</span>
						{tab.model ? <span className="max-w-28 truncate text-faint">{tab.model}</span> : null}
						{tab.status ? (
							<span className={cn('flex shrink-0 items-center gap-1', failed ? 'text-del' : 'text-muted')}>
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
									'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border-soft px-2 text-[11px] active:bg-surface-2',
									tab.selected && 'border-accent/50 bg-surface-2',
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
	const legacyTabs = pipelineTabs(jobs, sessions, roles, null)
	if (!workflow && !legacyTabs.length) return null
	return (
		<>
			{workflow ? <WorkflowSummary workflow={workflow} bootstrapJob={bootstrapJob} /> : null}
			<PipelineTabs
				tabs={workflowTabs}
				label="Workflow jobs"
				activeSessionId={activeSessionId}
				onSelectSession={onSelectSession}
			/>
			<PipelineTabs
				tabs={legacyTabs}
				label="Legacy delegated work"
				activeSessionId={activeSessionId}
				onSelectSession={onSelectSession}
			/>
		</>
	)
}

export function delegationStatusLabel(status: DelegationProjection['status']): string {
	return STATUS_LABELS[status]
}

/** Parent/child transcript cards for upgrade-era legacy jobs only. */
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
	const visible = jobs.filter(
		job => !job.workflowId && (job.parentSessionId === sessionId || job.childSessionId === sessionId)
	)
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
						label={`Legacy delegation · ${parent ? 'Delegated' : 'Assigned'} · ${job.role} · ${job.resolvedRole.model}${job.resolvedRole.effort ? ` · ${job.resolvedRole.effort}` : ''}`}
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
