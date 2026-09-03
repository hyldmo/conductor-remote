import { useQueryClient } from '@tanstack/react-query'
import { Archive, Check } from 'lucide-react'
import { useState } from 'react'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { SETTABLE_STATUSES, STATUS_COLORS, workspaceStatus, workspaceStatusLabel } from '../lib/format.ts'
import type { Workspace } from '../lib/types.ts'
import { useApp } from '../store.ts'

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
export function WorkspaceMenu({ workspace, agentsRunning }: { workspace: Workspace; agentsRunning: number }) {
	const [open, setOpen] = useState(false)
	const [confirmingArchive, setConfirmingArchive] = useState(false)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const online = useApp(s => s.online)
	const queryClient = useQueryClient()

	const current = workspaceStatus(workspace)

	const close = () => {
		setOpen(false)
		setConfirmingArchive(false)
	}

	const apply = async (status: string) => {
		if (busy) return
		close()
		if (status === current) return
		setBusy(status)
		setError(null)
		try {
			const r = await client.setStatus(workspace.id, status)
			if (!r.ok) setError(r.error ?? 'status change failed')
			await queryClient.invalidateQueries({ queryKey: ['state'] })
		} catch (e) {
			setError(e instanceof Error ? e.message : 'status change failed')
		} finally {
			setBusy(null)
		}
	}

	const archive = async () => {
		if (busy) return
		close()
		setBusy('archive')
		setError(null)
		try {
			// The relay counts the running agents itself and refuses unless this says the
			// dialog above named them — so send what the user was actually shown.
			const r = await client.archive(workspace.id, agentsRunning > 0)
			if (!r.ok) setError(r.error ?? 'archiving failed')
			// The state poll drops the workspace on its own; invalidating both keys is what
			// swaps this chat to its archived, read-only view now rather than in 2.5s.
			await queryClient.invalidateQueries({ queryKey: ['state'] })
			await queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] })
		} catch (e) {
			setError(e instanceof Error ? e.message : 'archiving failed')
		} finally {
			setBusy(null)
		}
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
					onClick={() => setError(null)}
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
