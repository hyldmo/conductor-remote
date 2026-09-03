import { useQueryClient } from '@tanstack/react-query'
import { FileDiff, Hourglass, LoaderCircle, Plus, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useAnyWorkspace, useClearChatNotification, useSessions, useWorkspaceFiles, useWorkspaces } from '../hooks.ts'
import { ApiError, client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { buildResolver, MentionResolverProvider } from '../lib/fileMentions.ts'
import { shortModel, timestampMs, workspaceTitle } from '../lib/format.ts'
import { isLockedError } from '../lib/lock.ts'
import { type PromptIndicatorState, promptIndicator } from '../lib/pending.ts'
import { isUnread, type ReadMarks } from '../lib/read.ts'
import type { Session } from '../lib/types.ts'
import { useApp, WORKING_HINT_MS } from '../store.ts'
import { ArchivedChat } from './ArchivedChat.tsx'
import { Composer } from './Composer.tsx'
import { DevServerControls } from './DevServerControls.tsx'
import { DiffView } from './DiffView.tsx'
import { Header } from './Header.tsx'
import type { SplitFormat } from './Transcript.tsx'
import { Transcript } from './Transcript.tsx'
import { PromptStatusDot, Spinner, UnlockLink } from './ui.tsx'
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
	const [closingChat, setClosingChat] = useState<string | null>(null)
	const [confirmingClose, setConfirmingClose] = useState<string | null>(null)
	const [closeError, setCloseError] = useState<string | null>(null)
	const [focusComposerFor, setFocusComposerFor] = useState<string | null>(null)
	const queryClient = useQueryClient()
	const navigate = useNavigate()
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
	const pending = useApp(s => s.pending)
	const readMarks = useApp(s => s.readMarks)
	const markRead = useApp(s => s.markRead)
	const setDraft = useApp(s => s.setDraft)
	const online = useApp(s => s.online)

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
	const visibleActiveSession =
		ws?.active_session_id && sessions.some(s => s.id === ws.active_session_id) ? ws.active_session_id : null
	const sessionId =
		// A named chat that isn't here — hidden, or a stale link from an old notification —
		// falls through to the usual pick rather than showing an empty pane. Switching
		// workspace drops the parameter with the rest of the URL, so no pick outlives it.
		(pickedSession && sessions.some(s => s.id === pickedSession) ? pickedSession : null) ??
		visibleActiveSession ??
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
		activeSession?.status === 'working' || (workingHint !== undefined && Date.now() - workingHint < WORKING_HINT_MS)

	// What the indicator's elapsed timer counts from. Whichever source says we're working
	// is the one that knows when it started: once Conductor's status agrees, its dispatch
	// time is exact (and survives a reload); until then only the hint from our own send
	// exists, and the DB's `turn_started_at` is still the *previous* answer's.
	const turnStart = activeSession?.turn_started_at ? timestampMs(activeSession.turn_started_at) : null
	const workingSince =
		(activeSession?.status === 'working' ? (turnStart ?? workingHint) : (workingHint ?? turnStart)) ?? null
	const indicatorNow = Date.now()
	const promptStates = Object.fromEntries(
		sessions.map(s => {
			const hint = workingHints[s.id]
			const relayPrompts = [
				...(s.id === sessionId && ws.pending_prompt ? [ws.pending_prompt] : []),
				...(ws.parked_prompts ?? []).filter(p => p.sessionId === s.id)
			]
			return [
				s.id,
				promptIndicator(
					pending.filter(p => p.sessionId === s.id),
					relayPrompts,
					hint !== undefined && indicatorNow - hint < WORKING_HINT_MS
				)
			]
		})
	) as Record<string, PromptIndicatorState>

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

	// Close tab is reversible in Conductor, but it confirms when that tab is still
	// working. Mirror the question on the phone and carry the answer to the relay;
	// a status race is caught again by Conductor's own dialog in the AppleScript.
	const closeChat = async (id: string, closeRunning = false) => {
		if (closingChat || !online) return
		const target = sessions.find(s => s.id === id)
		if ((target?.status === 'working' || target?.background_tasks.length) && !closeRunning) {
			setConfirmingClose(id)
			setCloseError(null)
			return
		}
		setClosingChat(id)
		setConfirmingClose(null)
		setCloseError(null)
		try {
			const result = await client.closeChat(id, ws.id, closeRunning)
			if (!result.ok) throw new Error(result.error ?? 'Could not close this chat')
			// The Mac chooses the previously viewed surviving tab. Follow that choice only
			// when the phone was showing the tab that disappeared; a background close must
			// not pull this reader away from its own current chat.
			if (sessionId === id) {
				if (result.activeSessionId) pickSession(result.activeSessionId)
				else setSearchParams({}, { replace: true })
			}
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ['sessions', ws.id] }),
				queryClient.invalidateQueries({ queryKey: ['state'] })
			])
		} catch (error) {
			// The tab can start working after the phone rendered it idle. Turn that named
			// refusal into the same confirmation instead of a dead-end error banner.
			if (error instanceof ApiError && error.status === 409 && /still working/i.test(error.message)) {
				setConfirmingClose(id)
			} else {
				setCloseError(error instanceof Error ? error.message : 'Could not close this chat')
			}
		} finally {
			setClosingChat(null)
		}
	}

	// The relay writes the transcript and opens the selected destination. Its returned
	// text contains Conductor's attachment token, which belongs in the new composer
	// until the user adds the question that starts the fork.
	const forkChat = async (
		{ thinking, tools, through, only, destination = 'chat' }: SplitFormat,
		continuation?: string
	) => {
		if (!sessionId) return
		const split = await client.splitChat(sessionId, ws.id, thinking, tools, through, only, destination)
		if (!split.ok) throw new Error(split.error ?? 'Could not fork this chat')
		const draftKey = split.sessionId ?? (destination === 'workspace' ? split.workspaceId : null)
		if (!draftKey) throw new Error('The new chat opened, but its id was not available')
		setDraft(draftKey, [split.text, continuation?.trim()].filter(Boolean).join('\n'))
		if (split.sessionId) setFocusComposerFor(split.sessionId)
		if (destination === 'workspace') {
			await queryClient.invalidateQueries({ queryKey: ['state'] })
			navigate(
				split.sessionId
					? `/w/${split.workspaceId}?session=${encodeURIComponent(split.sessionId)}`
					: `/w/${split.workspaceId}`
			)
			return
		}
		await queryClient.invalidateQueries({ queryKey: ['sessions', ws.id] })
		if (split.sessionId) pickSession(split.sessionId)
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
					{sessions.length > 0 || ws.state === 'ready' ? (
						<SessionTabs
							sessions={sessions}
							activeId={sessionId}
							readMarks={readMarks}
							promptStates={promptStates}
							onSelect={pickSession}
							onNewChat={createChat}
							onClose={id => void closeChat(id)}
							creating={creatingChat}
							closingId={closingChat}
							online={online}
						/>
					) : null}
					{confirmingClose ? (
						<TabCloseNotice
							title={sessions.find(s => s.id === confirmingClose)?.title ?? 'Untitled'}
							busy={closingChat === confirmingClose}
							onCancel={() => setConfirmingClose(null)}
							onConfirm={() => void closeChat(confirmingClose, true)}
						/>
					) : closeError ? (
						<div className="flex shrink-0 items-center gap-2 border-b border-del/30 bg-del/5 px-3 py-2 text-xs text-del">
							<span className="min-w-0 flex-1">{closeError}</span>
							{isLockedError(closeError) ? <UnlockLink /> : null}
							<button
								type="button"
								onClick={() => setCloseError(null)}
								aria-label="Dismiss close error"
								className="p-1"
							>
								<X size={14} />
							</button>
						</div>
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
						waiting={activeSession?.background_tasks}
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
						onFork={prompt => forkChat({ thinking: true, tools: false }, prompt)}
						focusDraft={sessionId === focusComposerFor}
						onDraftFocused={() => setFocusComposerFor(null)}
					/>
				</div>

				{diffOpen ? <DiffPanel workspaceId={ws.id} sessionId={sessionId} onClose={() => setDiffOpen(false)} /> : null}
			</div>
		</MentionResolverProvider>
	)
}

/** Conductor workspaces can hold several sessions — render them as tabs like the desktop app,
 *  with a trailing "+" (new chat, same files) pinned past the scrollable tabs. */
export function SessionTabs({
	sessions,
	activeId,
	readMarks,
	promptStates,
	onSelect,
	onNewChat,
	onClose,
	creating,
	closingId,
	online
}: {
	sessions: Session[]
	activeId: string | null
	readMarks: ReadMarks
	promptStates: Record<string, PromptIndicatorState>
	onSelect: (id: string) => void
	onNewChat: () => void
	onClose: (id: string) => void
	creating: boolean
	closingId: string | null
	online: boolean
}) {
	const activeTab = useRef<HTMLDivElement>(null)

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
				{sessions.map(s => {
					const promptState = promptStates[s.id]
					return (
						<div
							key={s.id}
							ref={s.id === activeId ? activeTab : undefined}
							className={cn(
								'flex shrink-0 items-center rounded-full text-sm font-medium text-muted transition',
								s.id === activeId && 'bg-surface-2 text-text'
							)}
						>
							<button
								type="button"
								onClick={() => onSelect(s.id)}
								className="flex min-w-0 items-center gap-1.5 py-1.5 pl-3.5 pr-1"
							>
								{promptState ? (
									<PromptStatusDot state={promptState} className="size-3" />
								) : s.status === 'working' ? (
									<span className="dot-spinner size-3" />
								) : s.background_tasks?.length ? (
									<Hourglass size={11} className="shrink-0 text-faint" aria-label="Waiting for a background task" />
								) : null}
								<span className="max-w-36 truncate">{s.title || 'Untitled'}</span>
								<ContextPercent used={s.context_used_percent} />
								{/* `unread_count` is a 0/1 flag, so a dot — not the meaningless number "1". */}
								{isUnread(s, readMarks) ? <span className="dot size-1.5 bg-accent" /> : null}
							</button>
							<button
								type="button"
								onClick={() => onClose(s.id)}
								disabled={!online || closingId !== null}
								aria-label={`Close ${s.title || 'Untitled'} chat`}
								className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-bg/70 active:text-text disabled:opacity-40"
							>
								{closingId === s.id ? <LoaderCircle size={12} className="animate-spin" /> : <X size={12} />}
							</button>
						</div>
					)
				})}
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

function TabCloseNotice({
	title,
	busy,
	onCancel,
	onConfirm
}: {
	title: string
	busy: boolean
	onCancel: () => void
	onConfirm: () => void
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-working/30 bg-working/5 px-3 py-2 text-xs">
			<span className="min-w-0 flex-1 truncate">
				<span className="font-semibold">{title}</span> is still working. Close the tab anyway?
			</span>
			<button
				type="button"
				onClick={onCancel}
				disabled={busy}
				className="rounded-lg px-2 py-1 text-muted active:bg-surface-2"
			>
				Cancel
			</button>
			<button
				type="button"
				onClick={onConfirm}
				disabled={busy}
				className="flex items-center gap-1 rounded-lg bg-del px-2 py-1 font-semibold text-black active:scale-95 disabled:opacity-50"
			>
				{busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
				Close anyway
			</button>
		</div>
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
function DiffPanel({
	workspaceId,
	sessionId,
	onClose
}: {
	workspaceId: string
	sessionId: string | null
	onClose: () => void
}) {
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
			<DiffView workspaceId={workspaceId} sessionId={sessionId} />
		</aside>
	)
}
