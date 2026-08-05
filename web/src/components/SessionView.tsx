import { useQueryClient } from '@tanstack/react-query'
import { FileDiff, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { useSessions, useWorkspaces } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { shortModel, workspaceLabel } from '../lib/format.ts'
import { isUnread, type ReadMarks } from '../lib/read.ts'
import type { Session } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { AgentBar } from './AgentBar.tsx'
import { Composer } from './Composer.tsx'
import { DiffView } from './DiffView.tsx'
import { Header } from './Header.tsx'
import { Transcript } from './Transcript.tsx'
import { Spinner } from './ui.tsx'

export function SessionView() {
	const { workspaceId } = useParams<{ workspaceId: string }>()
	const [diffOpen, setDiffOpen] = useState(false)
	const [pickedSession, setPickedSession] = useState<string | null>(null)
	const [creatingChat, setCreatingChat] = useState(false)
	const queryClient = useQueryClient()
	const { data, isLoading } = useWorkspaces()
	const { data: sessionsData } = useSessions(workspaceId)
	const workingHints = useApp(s => s.workingHints)
	const readMarks = useApp(s => s.readMarks)
	const markRead = useApp(s => s.markRead)

	// A manual tab pick only applies to the workspace it was made in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the pick when switching workspaces
	useEffect(() => setPickedSession(null), [workspaceId])

	const ws = data?.workspaces.find(w => w.id === workspaceId)
	const actuator = data?.actuator

	const sessions = sessionsData?.sessions ?? []
	const sessionId =
		(pickedSession && sessions.some(s => s.id === pickedSession) ? pickedSession : null) ??
		ws?.active_session_id ??
		sessions[0]?.id ??
		null
	const activeSession = sessions.find(s => s.id === sessionId)

	// Reading here can't clear Conductor's own unread flag (the relay's DB handle is
	// read-only), so record what this phone has seen: the chat on screen is marked up to
	// its current `updated_at`, and the poll keeps the mark moving while you watch it.
	// Only the chat you're actually on — a sibling tab's badge is not yours to clear.
	const activeUpdatedAt = activeSession?.updated_at
	useEffect(() => {
		if (!(sessionId && activeUpdatedAt)) return
		if (document.visibilityState !== 'visible') return
		markRead(sessionId, activeUpdatedAt)
	}, [sessionId, activeUpdatedAt, markRead])

	if (!ws) {
		return (
			<div className="flex h-full flex-col overflow-hidden">
				<Header title="Session" menu />
				{isLoading ? <Spinner /> : <div className="p-6 text-center text-sm text-muted">Workspace not found.</div>}
			</div>
		)
	}

	// A fresh send flips the indicator on instantly (the hint); the DB status poll
	// confirms or, if the send never landed, the hint expires and it drops back off.
	const workingHint = sessionId ? workingHints[sessionId] : undefined
	const working =
		activeSession?.status === 'working' || (workingHint !== undefined && Date.now() - workingHint < 15_000)

	const subtitle = [ws.repo_name, ws.branch, shortModel(ws.model)].filter(Boolean).join(' · ')

	// "New chat, same files" (Cmd+T): the relay focuses this workspace, opens a new
	// session, and returns its id; refresh the tab list and switch to it.
	const createChat = async () => {
		if (creatingChat) return
		setCreatingChat(true)
		try {
			const r = await client.newChat(ws.id)
			if (r.ok) {
				await queryClient.invalidateQueries({ queryKey: ['sessions', ws.id] })
				if (r.sessionId) setPickedSession(r.sessionId)
			}
		} finally {
			setCreatingChat(false)
		}
	}

	return (
		<div className="flex h-full min-w-0 overflow-hidden">
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<Header
					title={workspaceLabel(ws)}
					subtitle={subtitle}
					menu
					right={
						<button
							type="button"
							onClick={() => setDiffOpen(o => !o)}
							aria-label="Toggle diff panel"
							aria-pressed={diffOpen}
							className={cn(
								'flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2',
								diffOpen && 'bg-surface-2 text-text'
							)}
						>
							<FileDiff size={19} />
						</button>
					}
				/>
				{sessions.length > 0 ? (
					<SessionTabs
						sessions={sessions}
						activeId={sessionId}
						readMarks={readMarks}
						onSelect={setPickedSession}
						onNewChat={createChat}
						creating={creatingChat}
					/>
				) : null}
				{/* `pending_prompt` is the relay's undelivered first prompt for this workspace. */}
				<Transcript sessionId={sessionId} workspaceId={ws.id} working={working} queued={ws.pending_prompt} />
				{activeSession ? <AgentBar session={activeSession} workspaceId={ws.id} /> : null}
				<Composer key={ws.id} sessionId={sessionId} workspaceId={ws.id} actuator={actuator} />
			</div>

			{diffOpen ? <DiffPanel workspaceId={ws.id} onClose={() => setDiffOpen(false)} /> : null}
		</div>
	)
}

/** Conductor workspaces can hold several sessions — render them as tabs like the desktop app,
 *  with a trailing "+" (new chat, same files) pinned past the scrollable tabs. */
function SessionTabs({
	sessions,
	activeId,
	readMarks,
	onSelect,
	onNewChat,
	creating
}: {
	sessions: Session[]
	activeId: string | null
	readMarks: ReadMarks
	onSelect: (id: string) => void
	onNewChat: () => void
	creating: boolean
}) {
	return (
		<nav className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-bg px-3 py-2">
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				{sessions.map(s => (
					<button
						type="button"
						key={s.id}
						onClick={() => onSelect(s.id)}
						className={cn('pill flex shrink-0 items-center gap-1.5', s.id === activeId && 'pill-active')}
					>
						{s.status === 'working' ? <span className="dot-spinner size-3" /> : null}
						<span className="max-w-36 truncate">{s.title || 'Untitled'}</span>
						{/* `unread_count` is a 0/1 flag, so a dot — not the meaningless number "1". */}
						{isUnread(s, readMarks) ? <span className="dot size-1.5 bg-accent" /> : null}
					</button>
				))}
			</div>
			<button
				type="button"
				onClick={onNewChat}
				disabled={creating}
				aria-label="New chat, same files"
				className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-40"
			>
				<Plus size={18} />
			</button>
		</nav>
	)
}

/** Diff as a side panel: static right column on lg+, full-screen overlay below that. */
function DiffPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	return (
		<aside className="fixed inset-0 z-40 flex flex-col bg-bg lg:static lg:z-auto lg:w-[380px] lg:shrink-0 lg:border-l lg:border-border-soft xl:w-[460px]">
			<header className="pt-safe flex items-center gap-2 border-b border-border-soft px-3 pb-2.5">
				<span className="flex-1 text-[15px] font-semibold">Diff</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close diff panel"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<DiffView workspaceId={workspaceId} />
		</aside>
	)
}
