import { useQueryClient } from '@tanstack/react-query'
import { Archive, Check } from 'lucide-react'
import { useCallback, useState } from 'react'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { SETTABLE_STATUSES, STATUS_COLORS, workspaceStatus, workspaceStatusLabel } from '../lib/format.ts'
import type { Workspace } from '../lib/types.ts'
import { useApp } from '../store.ts'

/**
 * The status and archive writes, owned by the session view and shared between this
 * menu and the command palette. One `busy` for both surfaces, because the relay drives
 * Conductor's single window for either and a second request would only queue behind
 * the first; one `error`, because whichever surface asked, the menu is where the answer
 * is read.
 */
export interface WorkspaceActions {
	/** The status being applied, or 'archive', while the relay drives Conductor's UI. */
	busy: string | null
	error: string | null
	setStatus: (status: string) => Promise<void>
	archive: (stopAgents: boolean) => Promise<void>
	dismissError: () => void
}

export function useWorkspaceActions(workspaceId: string | undefined): WorkspaceActions {
	const [busy, setBusy] = useState<string | null>(null)
	// Kept with the workspace it came from: the session view stays mounted across a route
	// change, and a refusal from the workspace you left is not one from the one you reached.
	const [refusal, setRefusal] = useState<{ workspaceId: string; message: string } | null>(null)
	const queryClient = useQueryClient()
	const error = refusal && refusal.workspaceId === workspaceId ? refusal.message : null
	const setError = useCallback(
		(message: string | null) => setRefusal(message && workspaceId ? { workspaceId, message } : null),
		[workspaceId]
	)

	const setStatus = useCallback(
		async (status: string) => {
			if (!workspaceId || busy) return
			setBusy(status)
			setError(null)
			try {
				const r = await client.setStatus(workspaceId, status)
				if (!r.ok) setError(r.error ?? 'status change failed')
				await queryClient.invalidateQueries({ queryKey: ['state'] })
			} catch (e) {
				setError(e instanceof Error ? e.message : 'status change failed')
			} finally {
				setBusy(null)
			}
		},
		[workspaceId, busy, queryClient, setError]
	)

	const archive = useCallback(
		async (stopAgents: boolean) => {
			if (!workspaceId || busy) return
			setBusy('archive')
			setError(null)
			try {
				// The relay counts the running agents itself and refuses unless this says the
				// dialog above named them — so send what the user was actually shown.
				const r = await client.archive(workspaceId, stopAgents)
				if (!r.ok) setError(r.error ?? 'archiving failed')
				// The state poll drops the workspace on its own; invalidating both keys is what
				// swaps this chat to its archived, read-only view now rather than in 2.5s.
				await queryClient.invalidateQueries({ queryKey: ['state'] })
				await queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })
			} catch (e) {
				setError(e instanceof Error ? e.message : 'archiving failed')
			} finally {
				setBusy(null)
			}
		},
		[workspaceId, busy, queryClient, setError]
	)

	const dismissError = useCallback(() => setRefusal(null), [])
	return { busy, error, setStatus, archive, dismissError }
}

/**
 * The workspace's own menu, on the phone: move it between the sidebar's status
 * groups, or put it away. Conductor keeps both on one right-click menu over the
 * sidebar row, and both are unreachable from a phone otherwise.
 *
 * Worth the header space because Conductor's own status is *derived from a PR it
 * sometimes never links*: a PR that opens and merges inside its polling window is
 * invisible to it afterwards, so finished work sits in "In progress" forever and
 * the only fix — the sidebar row's right-click menu — needs a Mac.
 *
 * No optimism here, deliberately: the relay drives Conductor's real UI and only
 * answers once the DB agrees, so the pill stays busy for the seconds that takes
 * rather than showing a state the desktop hasn't accepted.
 *
 * Archiving asks twice, and the second ask carries Conductor's own sentence about
 * running agents, because that is the half a tap can't take back: the worktree is
 * deleted and any turn still in flight ends with it. The chat itself survives —
 * this workspace becomes the read-only view search already opens.
 */
export function WorkspaceMenu({
	workspace,
	agentsRunning,
	actions
}: {
	workspace: Workspace
	agentsRunning: number
	actions: WorkspaceActions
}) {
	const [open, setOpen] = useState(false)
	const [confirmingArchive, setConfirmingArchive] = useState(false)
	const online = useApp(s => s.online)
	const { busy, error } = actions

	const current = workspaceStatus(workspace)

	const close = () => {
		setOpen(false)
		setConfirmingArchive(false)
	}

	const apply = (status: string) => {
		close()
		if (status === current) return
		void actions.setStatus(status)
	}

	const archive = () => {
		close()
		void actions.archive(agentsRunning > 0)
	}

	const archiving = busy === 'archive'
	const shown = archiving ? current : (busy ?? current)

	return (
		<>
			<button
				type="button"
				onClick={() => (open ? close() : setOpen(true))}
				disabled={!online || busy !== null}
				aria-label={`Workspace menu: ${workspaceStatusLabel(current)}`}
				aria-expanded={open}
				className={cn(
					'flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-40',
					open && 'bg-surface-2 text-text'
				)}
			>
				{busy ? (
					<span className="dot-spinner size-4" style={{ '--spin-color': dotColor(shown) } as React.CSSProperties} />
				) : (
					<StatusGlyph status={shown} />
				)}
			</button>
			{open ? (
				<>
					{/* Tapping anywhere else closes it — the sheet has no chrome of its own. */}
					<button
						type="button"
						aria-label="Close workspace menu"
						className="fixed inset-0 z-20 cursor-default"
						onClick={close}
					/>
					<div className="fade-in absolute right-2 top-full z-30 w-60 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
						{confirmingArchive ? (
							<div className="p-3">
								<div className="text-sm font-semibold">Archive workspace?</div>
								<p className="mt-1 text-xs leading-snug text-muted">
									{agentsRunning > 0
										? 'Agents are still running in this workspace. Archiving will stop them and end any in-progress work.'
										: 'Its worktree is deleted. The chat stays readable and searchable.'}
								</p>
								<div className="mt-3 flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setConfirmingArchive(false)}
										className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold active:bg-surface-2"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={archive}
										className="rounded-lg bg-del px-2.5 py-1 text-xs font-semibold text-on-solid active:scale-95"
									>
										{agentsRunning > 0 ? 'Stop agents and archive' : 'Archive'}
									</button>
								</div>
							</div>
						) : (
							<>
								{SETTABLE_STATUSES.map(s => (
									<button
										type="button"
										key={s}
										onClick={() => apply(s)}
										className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm active:bg-surface-2"
									>
										<StatusGlyph status={s} />
										<span className="flex-1">{workspaceStatusLabel(s)}</span>
										{s === current ? <Check size={15} className="text-accent" /> : null}
									</button>
								))}
								<button
									type="button"
									onClick={() => setConfirmingArchive(true)}
									className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-left text-sm text-del active:bg-surface-2"
								>
									<Archive size={15} />
									<span className="flex-1">Archive workspace</span>
								</button>
							</>
						)}
					</div>
				</>
			) : null}
			{error ? (
				<button
					type="button"
					onClick={actions.dismissError}
					className="absolute right-2 top-full z-30 max-w-64 rounded-lg border border-del/40 bg-surface px-3 py-2 text-left text-xs text-del shadow-xl"
				>
					{error}
				</button>
			) : null}
		</>
	)
}

/** Unknown statuses (Conductor may add one) read as a hollow ring, never a wrong colour. */
function dotColor(status: string): string {
	return STATUS_COLORS[status] ?? 'var(--color-faint)'
}

function StatusGlyph({ status }: { status: string }) {
	const color = STATUS_COLORS[status]
	if (!color) return <span className="dot size-2.5 border border-faint bg-transparent" />
	return <span className="dot size-2.5" style={{ background: color }} />
}
