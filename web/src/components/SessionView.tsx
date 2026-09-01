import { useQueryClient } from '@tanstack/react-query'
import { FileDiff, Plus, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useAnyWorkspace, useClearChatNotification, useSessions, useWorkspaceFiles, useWorkspaces } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { buildResolver, MentionResolverProvider } from '../lib/fileMentions.ts'
import { shortModel, workspaceTitle } from '../lib/format.ts'
import { isUnread, type ReadMarks } from '../lib/read.ts'
import type { Session } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { ArchivedChat } from './ArchivedChat.tsx'
import { Composer } from './Composer.tsx'
import { DevServerControls } from './DevServerControls.tsx'
import { DiffView } from './DiffView.tsx'
import { Header } from './Header.tsx'
import type { SplitFormat } from './Transcript.tsx'
import { Transcript } from './Transcript.tsx'
import { Spinner } from './ui.tsx'
import { WorkspaceMenu } from './WorkspaceMenu.tsx'

export function SessionView() {
	const { workspaceId } = useParams<{ workspaceId: string }>()
	// Which chat is on screen lives in the URL, because two things set it: the tab strip
	// here, and a tapped notification, which names the chat that just finished
	// (src/notify.ts ▸ chatRoute). Holding it in state instead loses that race — a repeat
	// notification for a chat you had tabbed away from arrives as the *same* URL, so
	// nothing would tell the state to give way. One source of truth, last writer wins.
	const [searchParams, setSearchParams] = useSearchParams()
	const pickedSession = searchParams.get('session')
	const pickSession = (id: string) => setSearchParams({ session: id }, { replace: true })
	const [diffOpen, setDiffOpen] = useState(false)
	const [creatingChat, setCreatingChat] = useState(false)
	const [focusComposerFor, setFocusComposerFor] = useState<string | null>(null)
	const queryClient = useQueryClient()
	const { data, isLoading } = useWorkspaces()
	const liveWorkspace = data?.workspaces.find(w => w.id === workspaceId)
	// `/api/state` lists only live workspaces, so an id that isn't in it is either archived
	// or gone. Ask by id before saying "not found": the worktree is deleted on archive, the
	// transcript is not, and search reaches those chats — 1,846 of the 1,886 here.
	const missing = !!data && !liveWorkspace
	// The tab list stops polling for an archived workspace — nothing in it can change, and
	// the query is shared by key with the reader below, so the interval has to come off here.
	const { data: sessionsData } = useSessions(workspaceId, !missing)
	const workingHints = useApp(s => s.workingHints)
	const readMarks = useApp(s => s.readMarks)
	const markRead = useApp(s => s.markRead)
	const setDraft = useApp(s => s.setDraft)

	const ws = liveWorkspace
	const actuator = data?.actuator
	const { data: anyWorkspace, isLoading: loadingAny } = useAnyWorkspace(workspaceId, missing)

	// What turns a file an agent named in a message into a source link. The list is the
	// worktree's own, so it belongs to the workspace on screen rather than to a chat, and
	// the resolver is memoised because every inline code span in the transcript reads it —
	// a new one per render would undo the bail-outs the whole transcript depends on.
	const { data: workspaceFiles } = useWorkspaceFiles(workspaceId, !!liveWorkspace?.worktree)
	const worktree = liveWorkspace?.worktree ?? null
	const files = workspaceFiles?.files
	const resolveMention = useMemo(() => buildResolver(worktree, files), [worktree, files])

	const sessions = sessionsData?.sessions ?? []
	const sessionId =
		// A named chat that isn't here — hidden, or a stale link from an old notification —
		// falls through to the usual pick rather than showing an empty pane. Switching
		// workspace drops the parameter with the rest of the URL, so no pick outlives it.
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
		// Not for an archived chat: its unread flag is read off the live list, which no
		// longer holds it, so a mark here would only grow the store with dead ids.
		if (!(ws && sessionId && activeUpdatedAt)) return
		if (document.visibilityState !== 'visible') return
		markRead(sessionId, activeUpdatedAt)
	}, [ws, sessionId, activeUpdatedAt, markRead])
	// And take down the notification this chat already put on the lock screen: the relay
	// keeps quiet about a chat being read, which cannot reach one delivered before it was
	// opened.
	useClearChatNotification(sessionId, activeUpdatedAt)

	if (!ws) {
		if (anyWorkspace) return <ArchivedChat workspace={anyWorkspace.workspace} />
		return (
			<div className="flex h-full flex-col overflow-hidden">
				<Header title="Session" menu />
				{isLoading || (missing && loadingAny) ? (
					<Spinner />
				) : (
					<div className="p-6 text-center text-sm text-muted">Workspace not found.</div>
				)}
			</div>
		)
	}

	// A fresh send flips the indicator on instantly (the hint); the DB status poll
	// confirms or, if the send never landed, the hint expires and it drops back off.
	const workingHint = sessionId ? workingHints[sessionId] : undefined
	const working =
		activeSession?.status === 'working' || (workingHint !== undefined && Date.now() - workingHint < 15_000)

	// What the indicator's elapsed timer counts from. Whichever source says we're working
	// is the one that knows when it started: once Conductor's status agrees, its dispatch
	// time is exact (and survives a reload); until then only the hint from our own send
	// exists, and the DB's `turn_started_at` is still the *previous* answer's.
	const turnStart = activeSession?.turn_started_at ? Date.parse(activeSession.turn_started_at) : null
	const workingSince =
		(activeSession?.status === 'working' ? (turnStart ?? workingHint) : (workingHint ?? turnStart)) ?? null

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
				if (r.sessionId) pickSession(r.sessionId)
			}
		} finally {
			setCreatingChat(false)
		}
	}

	// The relay writes the transcript and opens the tab. Its returned text contains
	// Conductor's attachment token, which belongs in the new chat's composer until
	// the user adds the question that starts the fork.
	const forkChat = async ({ thinking, tools, through }: SplitFormat) => {
		if (!sessionId) return
		const split = await client.splitChat(sessionId, ws.id, thinking, tools, through)
		if (!split.ok) throw new Error(split.error ?? 'Could not fork this chat')
		if (!split.sessionId) throw new Error('The new chat opened, but its id was not available')
		setDraft(split.sessionId, split.text)
		setFocusComposerFor(split.sessionId)
		await queryClient.invalidateQueries({ queryKey: ['sessions', ws.id] })
		pickSession(split.sessionId)
	}

	return (
		<MentionResolverProvider value={resolveMention}>
			<div className="flex h-full min-w-0 overflow-hidden">
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					<Header
						title={workspaceTitle(ws)}
						subtitle={subtitle}
						menu
						right={
							<>
								<DevServerControls workspaceId={ws.id} />
								<WorkspaceMenu workspace={ws} agentsRunning={sessions.filter(s => s.status === 'working').length} />
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
							</>
						}
					/>
					{sessions.length > 0 ? (
						<SessionTabs
							sessions={sessions}
							activeId={sessionId}
							readMarks={readMarks}
							onSelect={pickSession}
							onNewChat={createChat}
							creating={creatingChat}
						/>
					) : null}
					{/* The relay's undelivered prompt for this chat: one parked for the lock screen
				    wins (it names its session; oldest first, since delivery is FIFO), else the
				    workspace's first prompt still waiting on setup. */}
					<Transcript
						sessionId={sessionId}
						workspaceId={ws.id}
						working={working}
						workingSince={workingSince}
						turnStartedAt={activeSession?.turn_started_at}
						queued={ws.parked_prompts?.find(p => p.sessionId === sessionId) ?? ws.pending_prompt}
						onFork={forkChat}
					/>
					{/* The agent controls — and the Stop button — render inside the composer card. */}
					<Composer
						key={ws.id}
						session={activeSession}
						sessionId={sessionId}
						workspaceId={ws.id}
						working={working}
						actuator={actuator}
						focusDraft={sessionId === focusComposerFor}
						onDraftFocused={() => setFocusComposerFor(null)}
					/>
				</div>

				{diffOpen ? <DiffPanel workspaceId={ws.id} onClose={() => setDiffOpen(false)} /> : null}
			</div>
		</MentionResolverProvider>
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
	const activeTab = useRef<HTMLButtonElement>(null)

	// Opening a workspace can restore a session near the end of a long tab row. Keep its
	// selected tab visible on first paint and after each tab change, without moving the
	// transcript or the rest of the page.
	useLayoutEffect(() => {
		if (!activeId) return
		activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [activeId])

	return (
		<nav className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-bg px-3 py-2">
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				{sessions.map(s => (
					<button
						type="button"
						key={s.id}
						ref={s.id === activeId ? activeTab : undefined}
						onClick={() => onSelect(s.id)}
						className={cn('pill flex shrink-0 items-center gap-1.5', s.id === activeId && 'pill-active')}
					>
						{s.status === 'working' ? <span className="dot-spinner size-3" /> : null}
						<span className="max-w-36 truncate">{s.title || 'Untitled'}</span>
						<ContextPercent used={s.context_used_percent} />
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

/**
 * How full this chat's context window is, on the tab that owns it.
 *
 * It sits here rather than on the workspace card because a workspace holds several
 * chats and the card could only ever print the *active* one's number, which then read
 * as the workspace's: one workspace here runs four tabs at 28 / 85 / 49 / 29 at once.
 * Amber from 80 on, where compaction is close enough to be worth reading.
 */
function ContextPercent({ used }: { used: number | null }) {
	if (typeof used !== 'number' || used <= 0) return null
	return (
		<span className={cn('shrink-0 text-[11px] tabular-nums', used >= 80 ? 'text-working' : 'text-faint')}>
			{Math.round(used)}%
		</span>
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
