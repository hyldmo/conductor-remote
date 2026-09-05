import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History, LoaderCircle, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { client } from '../lib/api.ts'
import { shortModel, timeAgo } from '../lib/format.ts'
import { isLockedError } from '../lib/lock.ts'
import type { ClosedSession, SessionsResponse } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { Spinner, UnlockLink } from './ui.tsx'

export function ClosedTabsList({
	sessions,
	filter,
	restoringId,
	online,
	onRestore
}: {
	sessions: ClosedSession[]
	filter: string
	restoringId: string | null
	online: boolean
	onRestore: (id: string) => void
}) {
	const terms = filter.trim().toLowerCase().split(/\s+/)
	const shown = sessions.filter(session => {
		const label = `${session.title || 'Untitled'} ${session.model ?? ''}`.toLowerCase()
		return terms.every(term => label.includes(term))
	})
	if (!shown.length) {
		return (
			<div className="px-4 py-10 text-center text-sm text-muted">
				{sessions.length ? 'No closed tabs match your search.' : 'No closed tabs in this workspace.'}
			</div>
		)
	}
	return (
		<ul className="divide-y divide-border-soft">
			{shown.map(session => (
				<li key={session.id} className="flex items-center gap-3 px-4 py-3">
					<div className="min-w-0 flex-1">
						<p className="break-words text-sm font-medium">{session.title || 'Untitled'}</p>
						<p className="mt-1 text-xs text-muted">
							{session.model ? `${shortModel(session.model)} · ` : ''}
							Updated {timeAgo(session.updated_at)}
						</p>
					</div>
					<button
						type="button"
						onClick={() => onRestore(session.id)}
						disabled={!online || restoringId !== null}
						aria-label={`Restore ${session.title || 'Untitled'} chat`}
						className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-surface-2 px-3 text-xs font-semibold transition active:scale-95 disabled:opacity-40"
					>
						{restoringId === session.id ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}
						{restoringId === session.id ? 'Restoring…' : 'Restore'}
					</button>
				</li>
			))}
		</ul>
	)
}

export function ClosedTabsSheet({
	workspaceId,
	onClose,
	onRestored
}: {
	workspaceId: string
	onClose: () => void
	onRestored: (id: string) => void
}) {
	const dialog = useRef<HTMLDialogElement>(null)
	const mounted = useRef(false)
	const [filter, setFilter] = useState('')
	const [restoringId, setRestoringId] = useState<string | null>(null)
	const [restoreError, setRestoreError] = useState<string | null>(null)
	const online = useApp(state => state.online)
	const queryClient = useQueryClient()
	const query = useQuery({
		queryKey: ['closed-sessions', workspaceId],
		queryFn: () => client.closedSessions(workspaceId),
		refetchInterval: 5000
	})

	useEffect(() => {
		mounted.current = true
		const element = dialog.current
		element?.showModal()
		return () => {
			mounted.current = false
			element?.close()
		}
	}, [])

	const restore = async (id: string) => {
		if (restoringId || !online) return
		setRestoringId(id)
		setRestoreError(null)
		try {
			const result = await client.restoreChat(id, workspaceId)
			if (!result.ok || !result.session) throw new Error(result.error ?? 'Could not restore this chat')
			const restored = result.session
			// Cancel a pre-restore poll so it cannot overwrite the confirmed tab with an
			// older list. Seed it before navigation, even if the next network read fails.
			await queryClient.cancelQueries({ queryKey: ['sessions', workspaceId] })
			queryClient.setQueryData<SessionsResponse>(['sessions', workspaceId], previous => ({
				...previous,
				sessions: [...(previous?.sessions ?? []).filter(session => session.id !== id), restored].sort((a, b) =>
					a.created_at.localeCompare(b.created_at)
				)
			}))
			void queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] })
			void queryClient.invalidateQueries({ queryKey: ['closed-sessions', workspaceId] })
			void queryClient.invalidateQueries({ queryKey: ['state'] })
			// Closing the sheet or switching workspace while it waits must not navigate
			// the reader back when the Mac eventually answers.
			if (mounted.current) onRestored(id)
		} catch (error) {
			if (mounted.current) setRestoreError(error instanceof Error ? error.message : 'Could not restore this chat')
		} finally {
			if (mounted.current) setRestoringId(null)
		}
	}

	const error = restoreError ?? (query.isError ? query.error.message : null)
	return createPortal(
		<dialog
			ref={dialog}
			onCancel={onClose}
			onKeyDown={event => event.stopPropagation()}
			aria-label="Closed tabs"
			className="fade-in m-auto max-h-[85%] w-[calc(100%-1.5rem)] max-w-lg flex-col overflow-hidden rounded-2xl border border-border-soft bg-bg p-0 text-text shadow-xl backdrop:bg-black/60 open:flex"
		>
			<div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3">
				<History size={19} className="text-muted" />
				<div className="min-w-0 flex-1">
					<h2 className="text-base font-semibold">Closed tabs</h2>
					<p className="text-xs text-muted">Restore a conversation in this workspace.</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close closed tabs"
					className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={18} />
				</button>
			</div>
			<div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
				<Search size={16} className="text-faint" />
				<input
					type="search"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					placeholder="Find a closed tab…"
					aria-label="Find a closed tab"
					className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
				/>
			</div>
			{!online ? <p className="px-4 py-2 text-xs text-muted">Reconnect to restore a tab.</p> : null}
			{error ? (
				<div
					role="alert"
					className="flex shrink-0 items-center gap-2 border-b border-del/30 bg-del/5 px-4 py-3 text-xs text-del"
				>
					<span className="min-w-0 flex-1">{error}</span>
					{isLockedError(error) ? <UnlockLink /> : null}
					{query.isError ? (
						<button type="button" onClick={() => void query.refetch()} className="rounded-lg bg-surface-2 px-2 py-1">
							Retry
						</button>
					) : null}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{query.isPending ? (
					<Spinner />
				) : query.data ? (
					<ClosedTabsList
						sessions={query.data.sessions}
						filter={filter}
						restoringId={restoringId}
						online={online}
						onRestore={id => void restore(id)}
					/>
				) : null}
			</div>
		</dialog>,
		document.body
	)
}
