import { useQueryClient } from '@tanstack/react-query'
import {
	AlertTriangle,
	ArrowUpRight,
	Check,
	GitBranchPlus,
	GitMerge,
	Loader2,
	UploadCloud,
	XCircle
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { isLockedError } from '../lib/lock.ts'
import type { Workspace } from '../lib/types.ts'
import { UnlockLink } from './ui.tsx'

/** Local publish state from the diff endpoint — decides "Commit & push". */
interface LocalState {
	dirty: boolean
	unpushed: boolean
}

/**
 * What the bar offers, chosen by state (matches Conductor's top-of-diff bar):
 *  - push    → uncommitted/unpushed work; button asks the agent to commit & push
 *  - resolve → PR has merge conflicts; button asks the agent to resolve them
 *  - merge   → PR is mergeable; button merges it (gh pr merge)
 *  - checks  → CI is still running; the same Merge button, drawn plain rather
 *    than green. GitHub won't stop this merge (no required checks on an
 *    unprotected base), so the label is the only thing between a tap and a red
 *    build — but merging ahead of a slow job is a real choice, so it stays a
 *    choice rather than a disabled button.
 *  - failed  → CI failed; shown, no action. It has no button for the same reason
 *    draft doesn't, and it is here at all because the bar used to vanish on this
 *    state and take the #NN link with it.
 *  - draft   → PR isn't ready; shown, no action
 *  - merged  → the PR landed; shown purple, with Continue to move the same
 *    workspace and chats onto a fresh branch. It also keeps the #NN link
 *    reachable — the bar used to vanish on merge, which took the only route to
 *    the PR on the phone with it.
 * `push`/`resolve` send a chat message (like Conductor); `merge` acts on GitHub;
 * `merged` delegates the branch transition to Conductor's native Continue.
 */
type Action = 'push' | 'resolve' | 'merge' | 'checks' | 'failed' | 'draft' | 'merged'

function pickAction(ws: Workspace, local?: LocalState): Action | null {
	// merged outranks local dirt: pushing more onto a landed branch isn't the
	// next step, and the link is what the bar is still here for.
	if (ws.pr_status === 'merged') return 'merged'
	if (local && (local.dirty || local.unpushed)) return 'push'
	switch (ws.pr_status) {
		case 'conflicts':
			return 'resolve'
		case 'checks_failed':
			return 'failed'
		case 'checks_pending':
			return 'checks'
		case 'mergeable':
			return 'merge'
		case 'draft':
			return 'draft'
		default:
			return null // no PR and nothing to push → no bar
	}
}

const STATUS: Record<Action, { label: string; tone: string; icon?: ReactNode }> = {
	push: { label: 'Uncommitted changes', tone: 'text-working', icon: <UploadCloud size={14} /> },
	resolve: { label: 'Merge conflicts', tone: 'text-muted', icon: <AlertTriangle size={14} /> },
	merge: { label: 'Ready to merge', tone: 'text-add' },
	checks: { label: 'Checks running', tone: 'text-working', icon: <Loader2 size={14} className="animate-spin" /> },
	failed: { label: 'Checks failed', tone: 'text-del', icon: <XCircle size={14} /> },
	draft: { label: 'Draft', tone: 'text-muted' },
	merged: { label: 'Merged', tone: 'text-pr-merged', icon: <GitMerge size={14} /> }
}

/** The message each delegating action sends into the chat. */
const PROMPT: Record<'push' | 'resolve', string> = {
	push: 'Commit all outstanding changes with a clear message and push the branch to the remote.',
	resolve:
		'This branch has merge conflicts with its base branch. Merge the base branch in, resolve the conflicts, then commit and push.'
}

/**
 * Conductor's merge/resolve/commit bar, on the phone. Renders above the diff and
 * swaps its action by state. Nothing to do (no PR, clean, nothing to push) → no bar.
 */
export function MergeBanner({
	ws,
	local,
	sessionId
}: {
	ws: Workspace
	local?: LocalState
	sessionId?: string | null
}) {
	const queryClient = useQueryClient()
	const [confirming, setConfirming] = useState(false)
	const [busy, setBusy] = useState(false)
	const [done, setDone] = useState<{ ok: boolean; msg: string; continued?: boolean } | null>(null)

	// A local success receipt covers the state-poll gap. After a merge, the purple
	// bar says the same thing and takes over; after Continue changes the branch, the
	// green receipt remains because that branch no longer owns the merged PR.
	if (done?.ok && (done.continued || ws.pr_status !== 'merged'))
		return (
			<Bar>
				<Check size={15} className="shrink-0 text-add" />
				<span className="truncate font-medium text-add">{done.msg}</span>
			</Bar>
		)

	const action = pickAction(ws, local)
	if (!action) return null
	const { label, tone, icon } = STATUS[action]

	// Merge acts on GitHub; Continue acts in Conductor; push/resolve message the agent.
	const runMerge = async () => {
		setBusy(true)
		setDone(null)
		try {
			const r = await client.merge(ws.id)
			if (r.ok) {
				setDone({ ok: true, msg: `Merged${r.method ? ` (${r.method})` : ''}` })
				queryClient.invalidateQueries({ queryKey: ['state'] })
				queryClient.invalidateQueries({ queryKey: ['diff', ws.id] })
			} else {
				setDone({ ok: false, msg: r.error || 'Merge failed' })
				setConfirming(false)
			}
		} catch (err) {
			setDone({ ok: false, msg: err instanceof Error ? err.message : String(err) })
			setConfirming(false)
		} finally {
			setBusy(false)
		}
	}

	const runContinue = async () => {
		setBusy(true)
		setDone(null)
		try {
			const r = await client.continueWorkspace(ws.id, sessionId)
			if (r.ok) {
				setDone({
					ok: true,
					msg: r.workspace?.branch ? `Continued on ${r.workspace.branch}` : 'Continued on a new branch',
					continued: true
				})
				queryClient.invalidateQueries({ queryKey: ['state'] })
				queryClient.invalidateQueries({ queryKey: ['diff', ws.id] })
			} else {
				setDone({ ok: false, msg: r.error || 'Could not continue this workspace' })
			}
		} catch (err) {
			setDone({ ok: false, msg: err instanceof Error ? err.message : String(err) })
		} finally {
			setBusy(false)
		}
	}

	const sendMessage = async (kind: 'push' | 'resolve') => {
		if (!ws.active_session_id) return setDone({ ok: false, msg: 'No active session to message' })
		setBusy(true)
		setDone(null)
		try {
			const r = await client.sendPrompt(ws.active_session_id, PROMPT[kind], ws.id)
			setDone(r.ok ? { ok: true, msg: 'Asked the agent' } : { ok: false, msg: r.error || 'Send failed' })
		} catch (err) {
			setDone({ ok: false, msg: err instanceof Error ? err.message : String(err) })
		} finally {
			setBusy(false)
		}
	}

	return (
		<Bar tint={action === 'merge' ? 'add' : action === 'merged' ? 'merged' : undefined}>
			{ws.pr_number ? (
				<a
					href={ws.pr_url ?? undefined}
					target="_blank"
					rel="noreferrer"
					className={cn(
						'flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] active:bg-surface',
						action === 'merged' ? 'bg-pr-merged/15 text-pr-merged' : 'bg-surface-2 text-muted'
					)}
				>
					#{ws.pr_number}
					<ArrowUpRight size={12} />
				</a>
			) : null}
			<span className={cn('flex items-center gap-1 truncate font-medium', tone)}>
				{icon}
				{label}
			</span>

			<div className="ml-auto flex shrink-0 items-center gap-2">
				{done && !done.ok ? (
					<>
						<span className="max-w-36 truncate text-[11px] text-del">{done.msg}</span>
						{isLockedError(done.msg) ? <UnlockLink className="shrink-0 text-[11px]" /> : null}
					</>
				) : null}
				{action === 'merge' || action === 'checks' ? (
					confirming ? (
						<>
							<CancelBtn onClick={() => setConfirming(false)} />
							<Cta
								onClick={runMerge}
								busy={busy}
								className={action === 'merge' ? 'bg-add text-on-solid' : 'bg-working text-on-solid'}
							>
								Confirm
							</Cta>
						</>
					) : (
						<Cta
							onClick={() => setConfirming(true)}
							className={action === 'merge' ? 'bg-add text-on-solid' : 'border border-border bg-surface-2 text-text'}
						>
							<GitMerge size={13} />
							Merge
						</Cta>
					)
				) : action === 'push' ? (
					<Cta onClick={() => sendMessage('push')} busy={busy} className="bg-working text-on-solid">
						Commit &amp; push
					</Cta>
				) : action === 'resolve' ? (
					<Cta
						onClick={() => sendMessage('resolve')}
						busy={busy}
						className="border border-border bg-surface-2 text-text"
					>
						Resolve
					</Cta>
				) : action === 'merged' ? (
					<Cta
						onClick={runContinue}
						busy={busy}
						title="Continue on a new branch with the same chats"
						className="border border-pr-merged/30 bg-surface-2 text-pr-merged"
					>
						<GitBranchPlus size={13} />
						Continue
					</Cta>
				) : null}
			</div>
		</Bar>
	)
}

function Cta({
	onClick,
	busy,
	title,
	className,
	children
}: {
	onClick: () => void
	busy?: boolean
	title?: string
	className?: string
	children: ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={busy}
			title={title}
			className={cn(
				'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition active:scale-95 disabled:opacity-60',
				className
			)}
		>
			{busy ? <Loader2 size={13} className="animate-spin" /> : null}
			{children}
		</button>
	)
}

function CancelBtn({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="rounded-lg px-2 py-1 text-xs text-muted active:bg-surface-2">
			Cancel
		</button>
	)
}

const TINTS = { add: 'bg-add/10', merged: 'bg-pr-merged/10' }

function Bar({ tint, children }: { tint?: keyof typeof TINTS; children: ReactNode }) {
	return (
		<div
			className={cn(
				'sticky top-0 z-10 flex items-center gap-2 border-b border-border-soft px-3 py-2 backdrop-blur',
				tint ? TINTS[tint] : 'bg-surface/95'
			)}
		>
			{children}
		</div>
	)
}
