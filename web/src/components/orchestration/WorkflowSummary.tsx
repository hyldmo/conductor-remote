import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, ShieldCheck, Workflow as WorkflowIcon, X } from 'lucide-react'
import { useState } from 'react'
import { useWorkflowActions } from '../../hooks/workflows.ts'
import { cn } from '../../lib/cn.ts'
import type { DelegationProjection, PublicFrozenRole, WorkflowRoleName, WorkflowRunWire } from '../../lib/types.ts'
import { ProviderMark } from '../agents/AgentIcons.tsx'
import { acceptedPhase, countLabel, frozenRoleLabel, STATUS_LABELS, workflowPhaseLabel } from './labels.ts'

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
