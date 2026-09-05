import { useQueryClient } from '@tanstack/react-query'
import { Workflow, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useClearChatNotification } from '../../hooks/push.ts'
import { useDiff, useFileDiff, useWorkspaceFiles } from '../../hooks/review.ts'
import { useWorkspaceCommands } from '../../hooks/workspace-commands.ts'
import { useAnyWorkspace, useSessions, useWorkspaces } from '../../hooks/workspaces.ts'
import { ApiError, client } from '../../lib/api.ts'
import type { DiffFileScope } from '../../lib/diff.ts'
import { buildResolver, MentionResolverProvider } from '../../lib/fileMentions.ts'
import { shortModel, timestampMs, workspaceStatus, workspaceTitle } from '../../lib/format.ts'
import { isLockedError } from '../../lib/lock.ts'
import { type PromptIndicatorState, promptIndicator } from '../../lib/prompts/pending.ts'
import { conversationTabs, latestChat, previousChats } from '../../lib/transcript/history.ts'
import type { WorkflowRoleName } from '../../lib/types.ts'
import { useApp, WORKING_HINT_MS } from '../../store.ts'
import { ContextBreakdownSheet } from '../agents/ContextBreakdownSheet.tsx'
import { Header } from '../Header.tsx'
import { DelegationPipeline } from '../orchestration/DelegationPipeline.tsx'
import { RolesSettings } from '../orchestration/RolesSettings.tsx'
import { DiffFileViewer, type DiffReviewState } from '../review/DiffView.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import type { SplitFormat } from '../transcript/types.ts'
import { Spinner, UnlockLink } from '../ui.tsx'
import { useVoiceCall } from '../voice/VoiceProvider.tsx'
import { DevServerControls } from '../workspaces/DevServerControls.tsx'
import { useWorkspaceActions, WorkspaceMenu } from '../workspaces/WorkspaceMenu.tsx'
import { ArchivedChat } from './ArchivedChat.tsx'
import { ClosedTabsSheet } from './ClosedTabsSheet.tsx'
import { Composer } from './Composer.tsx'
import { type ChatHistoryRetry, handoffChat, joinChatHistory } from './chat-handoff.ts'
import { DiffButton, DiffPanel, MobileDiffNavigator } from './DiffPanel.tsx'
import { SubagentReplyNotice } from './SessionNotices.tsx'
import { SessionTabs, TabCloseNotice } from './SessionTabs.tsx'
import { delegationPipelinesForSession, workflowForActiveSession } from './selection.ts'

export function SessionView() {
	const { workspaceId } = useParams<{ workspaceId: string }>()
	const voice = useVoiceCall()
	// Which chat is on screen lives in the URL, because two things set it: the tab strip
	// here, and a tapped notification, which names the chat that just finished
	// (src/notifications/notify.ts ▸ chatRoute). Holding it in state instead loses that race — a repeat
	// notification for a chat you had tabbed away from arrives as the *same* URL, so
	// nothing would tell the state to give way. One source of truth, last writer wins.
	const [searchParams, setSearchParams] = useSearchParams()
	const location = useLocation()
	const pickedSession = searchParams.get('session')
	const pickedSubagent = searchParams.get('subagent')
	const pickSession = (id: string) => setSearchParams({ session: id }, { replace: true })
	const [diffOpen, setDiffOpen] = useState(false)
	const [diffFileScope, setDiffFileScope] = useState<DiffFileScope>('changed')
	const [selectedDiff, setSelectedDiff] = useState<{
		workspaceId: string
		path: string
		locationKey: string
	} | null>(null)
	const [diffNavigatorLocation, setDiffNavigatorLocation] = useState<string | null>(null)
	const selectedDiffFile = selectedDiff && selectedDiff.workspaceId === workspaceId ? selectedDiff.path : null
	// A file stays in its temporary tab when a chat is selected. Every navigation,
	// including a notification for the same chat, returns the pane to the transcript.
	const activeDiffFile = selectedDiff?.locationKey === location.key ? selectedDiffFile : null
	const diffNavigatorOpen = diffNavigatorLocation === location.key
	const [rolesOpen, setRolesOpen] = useState(false)
	const [delegationError, setDelegationError] = useState<string | null>(null)
	const [creatingChat, setCreatingChat] = useState(false)
	const [closingChat, setClosingChat] = useState<string | null>(null)
	const [confirmingClose, setConfirmingClose] = useState<string | null>(null)
	const [closeError, setCloseError] = useState<string | null>(null)
	const [closeRetryId, setCloseRetryId] = useState<string | null>(null)
	const [compactingChat, setCompactingChat] = useState<string | null>(null)
	const compactInFlight = useRef(false)
	const [historyError, setHistoryError] = useState<ChatHistoryRetry | null>(null)
	const [joiningHistory, setJoiningHistory] = useState(false)
	const [closedTabsFor, setClosedTabsFor] = useState<string | null>(null)
	const [focusComposerFor, setFocusComposerFor] = useState<string | null>(null)
	const [contextSession, setContextSession] = useState<{
		workspaceId: string
		id: string
		title: string | null
	} | null>(null)
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const workspaceActions = useWorkspaceActions(workspaceId)
	const { data, isLoading } = useWorkspaces()
	const liveWorkspace = data?.workspaces.find(w => w.id === workspaceId)
	const diffQuery = useDiff(workspaceId, (diffOpen || !!activeDiffFile) && !!liveWorkspace)
	const fileDiffQuery = useFileDiff(
		workspaceId,
		activeDiffFile,
		!!activeDiffFile && diffFileScope === 'changed' && !!liveWorkspace && !!diffQuery.data?.truncated
	)
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
	const online = useApp(s => s.online)
	const showFolders = useApp(s => s.view.showFolders)
	const setView = useApp(s => s.setView)

	const ws = liveWorkspace
	const actuator = data?.actuator
	const { data: anyWorkspace, isLoading: loadingAny } = useAnyWorkspace(workspaceId, missing)

	// One previewable worktree list serves the All-files rail and turns a file an agent
	// named in a message into a source link. It belongs to the workspace on screen rather
	// than to a chat, and the resolver is memoised because every inline code span in the
	// transcript reads it — a new one per render would undo the bail-outs the whole
	// transcript depends on.
	const workspaceFilesQuery = useWorkspaceFiles(
		workspaceId,
		!!liveWorkspace?.worktree,
		(diffOpen || !!activeDiffFile) && diffFileScope === 'all'
	)
	const { data: workspaceFiles } = workspaceFilesQuery
	const worktree = liveWorkspace?.worktree ?? null
	const files = workspaceFiles?.files
	const fileReferences = useMemo(
		() => ({ resolveMention: buildResolver(worktree, files), worktree }),
		[worktree, files]
	)

	const chatHistory = sessionsData?.chat_history ?? {}
	const sessions = conversationTabs(sessionsData?.sessions ?? [], chatHistory)
	const pickedChat = latestChat(pickedSession, chatHistory)
	const desktopChat = latestChat(ws?.active_session_id ?? null, chatHistory)
	const visibleActiveSession = desktopChat && sessions.some(s => s.id === desktopChat) ? desktopChat : null
	const sessionId =
		// A named chat that isn't here — hidden, or a stale link from an old notification —
		// falls through to the usual pick rather than showing an empty pane. Switching
		// workspace drops the parameter with the rest of the URL, so no pick outlives it.
		(pickedChat && sessions.some(s => s.id === pickedChat) ? pickedChat : null) ??
		visibleActiveSession ??
		sessions[0]?.id ??
		null
	const activeSession = sessions.find(s => s.id === sessionId)
	const historySessionIds = previousChats(sessionId, chatHistory)
	const pickSubagent = (toolUseId: string | null) => {
		if (!sessionId) return
		setSearchParams(toolUseId ? { session: sessionId, subagent: toolUseId } : { session: sessionId }, { replace: true })
	}
	const sessionRoles = { ...(sessionsData?.session_roles ?? {}), ...(ws?.session_roles ?? {}) }
	const delegations = ws?.delegations ?? []
	const adHocDelegations = delegations.filter(job => !job.workflowId)
	const workspaceWorkflows = (data?.workflows ?? []).filter(run => run.workspaceId === workspaceId)
	if (ws?.workflow && !workspaceWorkflows.some(run => run.id === ws.workflow?.id)) workspaceWorkflows.push(ws.workflow)
	const sessionWorkflow = workflowForActiveSession(workspaceWorkflows, sessionId, sessionRoles, delegations)
	const delegationPipelines = delegationPipelinesForSession(
		workspaceWorkflows,
		delegations,
		sessionRoles,
		activeDiffFile ? null : sessionId
	)
	const activeWorkflowAssignment = sessionId ? sessionRoles[sessionId] : undefined
	const activeWorkflowJob = sessionId
		? delegations.find(job => job.workflowId === sessionWorkflow?.id && job.childSessionId === sessionId)
		: undefined
	const assignedWorkflowRole =
		activeWorkflowAssignment && activeWorkflowAssignment.workflowId === sessionWorkflow?.id
			? activeWorkflowAssignment.role
			: activeWorkflowJob?.role
	const workflowOwnsAgent = sessionWorkflow?.phase !== 'completed' && sessionWorkflow?.phase !== 'cancelled'
	const workflowRole: WorkflowRoleName | undefined =
		sessionWorkflow && workflowOwnsAgent && sessionId === sessionWorkflow.rootSessionId
			? 'planning'
			: assignedWorkflowRole === 'planning' ||
					assignedWorkflowRole === 'exploration' ||
					assignedWorkflowRole === 'implementation'
				? assignedWorkflowRole
				: undefined
	const delegationSubtabSessionIds = useMemo(
		() => new Set(delegations.flatMap(job => (job.childSessionId ? [job.childSessionId] : []))),
		[delegations]
	)

	// Reading here can't clear Conductor's own unread flag (the relay's DB handle is
	// read-only), so record what this phone has seen: the chat on screen is marked up to
	// its current `updated_at`, and the poll keeps the mark moving while you watch it.
	// Only the chat you're actually on — a sibling tab's badge is not yours to clear.
	const activeUpdatedAt = activeSession?.updated_at
	useEffect(() => {
		// Not for an archived chat: its unread flag is read off the live list, which no
		// longer holds it, so a mark here would only grow the store with dead ids.
		if (!(ws && sessionId && activeUpdatedAt) || activeDiffFile) return
		if (document.visibilityState !== 'visible') return
		markRead(sessionId, activeUpdatedAt)
	}, [ws, sessionId, activeUpdatedAt, activeDiffFile, markRead])
	// And take down the notification this chat already put on the lock screen: the relay
	// keeps quiet about a chat being read, which cannot reach one delivered before it was
	// opened.
	useClearChatNotification(activeDiffFile ? null : sessionId, activeUpdatedAt)

	// The palette's rows for this workspace (`lib/commands.ts`). Keyed on the few facts
	// that decide what is offered and checked, with the handlers behind a ref: the poll
	// re-reads the workspace every 2.5s and must not re-register anything.

	const statusNow = ws ? workspaceStatus(ws) : null
	const canCreateChat = !!ws && ws.state === 'ready' && online && !creatingChat
	const canSetStatus = !!ws && online && !workspaceActions.busy
	const hasChat = !!activeSession
	const voiceActive = voice.status !== 'idle'
	const canCall = voiceActive || (hasChat && !pickedSubagent)
	const setStatus = workspaceActions.setStatus
	const latest = useWorkspaceCommands({
		statusNow,
		diffOpen,
		canCreateChat,
		canSetStatus,
		hasChat,
		canCall,
		voiceActive,
		setStatus
	})

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
		setCloseRetryId(null)
		try {
			const result = await client.closeChat(id, ws.id, closeRunning)
			if (!result.ok) throw new Error(result.error ?? 'Could not close this chat')
			// The Mac chooses the previously viewed surviving tab. Follow that choice only
			// when the phone was showing the tab that disappeared; a background close must
			// not pull this reader away from its own current chat.
			if (sessionId === id && !activeDiffFile) {
				if (result.activeSessionId) pickSession(result.activeSessionId)
				else setSearchParams({}, { replace: true })
			}
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ['sessions', ws.id] }),
				queryClient.invalidateQueries({ queryKey: ['closed-sessions', ws.id] }),
				queryClient.invalidateQueries({ queryKey: ['state'] })
			])
		} catch (error) {
			// The tab can start working after the phone rendered it idle. Turn that named
			// refusal into the same confirmation instead of a dead-end error banner.
			if (error instanceof ApiError && error.status === 409 && /still working/i.test(error.message)) {
				setConfirmingClose(id)
			} else {
				setCloseError(error instanceof Error ? error.message : 'Could not close this chat')
				setCloseRetryId(id)
			}
		} finally {
			setClosingChat(null)
		}
	}

	// Compact keeps Fork's context handoff and joins the real chats only in our UI.
	const forkChat = async (format: SplitFormat, continuation?: string, replace = false) => {
		if (!sessionId) return
		const result = await handoffChat({ sessionId, workspaceId: ws.id }, format, {
			replace,
			continuation,
			onReady: async split => {
				if (split.sessionId) setFocusComposerFor(split.sessionId)
				if (split.destination === 'workspace') {
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
		})
		if (replace) {
			setHistoryError(result.historyError ?? null)
		}
	}
	const retryHistory = async () => {
		if (!historyError || joiningHistory) return
		setJoiningHistory(true)
		try {
			await joinChatHistory(historyError)
			await queryClient.invalidateQueries({ queryKey: ['sessions', historyError.workspaceId] })
			setHistoryError(null)
		} catch (error) {
			setHistoryError({ ...historyError, message: error instanceof Error ? error.message : 'Could not join history' })
		} finally {
			setJoiningHistory(false)
		}
	}
	const compactUnavailable = !online
		? 'Reconnect to compact this chat'
		: working || activeSession?.background_tasks.length
			? 'Wait for this turn to finish before compacting'
			: pending.some(p => p.sessionId === sessionId) || ws.parked_prompts?.some(p => p.sessionId === sessionId)
				? 'Send or dismiss pending prompts before compacting'
				: historyError?.workspaceId === ws.id
					? 'Retry joining conversation history first'
					: compactingChat || closingChat
						? 'A tab action is already in progress'
						: undefined
	const compactChat = async (format: SplitFormat) => {
		if (!sessionId || compactInFlight.current) return
		if (compactUnavailable) throw new Error(compactUnavailable)
		compactInFlight.current = true
		setCompactingChat(sessionId)
		try {
			await forkChat(format, undefined, true)
		} finally {
			compactInFlight.current = false
			setCompactingChat(null)
		}
	}
	const closeDiff = () => {
		setDiffOpen(false)
		setDiffNavigatorLocation(null)
	}
	const closeDiffFile = () => {
		// Closing the temporary tab returns to the chat; the file rail is independent.
		setSelectedDiff(null)
		setDiffNavigatorLocation(null)
	}

	const toggleDiff = () => {
		// On a phone the rail is hidden after choosing a tab, so reopen its navigator
		// on the first tap. On desktop the same control toggles the visible side rail.
		if (diffOpen && (diffNavigatorOpen || window.matchMedia('(min-width: 1024px)').matches)) closeDiff()
		else {
			setDiffOpen(true)
			setDiffNavigatorLocation(location.key)
		}
	}
	const openCall = () => {
		if (voiceActive) return voice.openPanel()
		if (!activeSession || pickedSubagent) return
		voice.openWorkspacePanel({
			workspaceId: ws.id,
			sessionId: activeSession.id,
			workspaceTitle: workspaceTitle(ws),
			chatTitle: activeSession.title || 'Untitled chat'
		})
	}
	latest.current = {
		toggleDiff,
		createChat,
		openCall,
		openContext: () => {
			if (activeSession) setContextSession({ workspaceId: ws.id, id: activeSession.id, title: activeSession.title })
		}
	}

	const selectDiffFile = (path: string) => {
		setSelectedDiff({ workspaceId: ws.id, path, locationKey: location.key })
		// The file rail stays mounted on desktop. On a phone it is an overlay,
		// so selecting a row dismisses it to reveal this file in the transcript's slot.
		setDiffNavigatorLocation(null)
	}
	const changeDiffFileScope = (scope: DiffFileScope) => {
		setDiffFileScope(scope)
		if (scope === 'all' && ws.worktree) void workspaceFilesQuery.refetch()
	}
	const diffReview: DiffReviewState = {
		workspace: ws,
		query: diffQuery,
		filesQuery: workspaceFilesQuery,
		fileQuery: fileDiffQuery
	}

	const dismissDelegation = async (delegationId: string) => {
		setDelegationError(null)
		try {
			const result = await client.dismissDelegation(delegationId)
			if (!result.ok) throw new Error(result.error.message)
			await queryClient.invalidateQueries({ queryKey: ['state'] })
		} catch (err) {
			setDelegationError(err instanceof Error ? err.message : String(err))
		}
	}

	return (
		<MentionResolverProvider value={fileReferences}>
			{closedTabsFor === ws.id ? (
				<ClosedTabsSheet
					key={ws.id}
					workspaceId={ws.id}
					onClose={() => setClosedTabsFor(null)}
					onRestored={id => {
						pickSession(id)
						setClosedTabsFor(null)
					}}
				/>
			) : null}
			<div className="flex h-full min-w-0 overflow-hidden">
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					<Header
						title={workspaceTitle(ws)}
						subtitle={subtitle}
						menu
						right={
							<>
								<DevServerControls workspaceId={ws.id} />
								<button
									type="button"
									onClick={() => setRolesOpen(true)}
									aria-label="Open delegated roles"
									className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2"
								>
									<Workflow size={18} />
								</button>
								<WorkspaceMenu
									workspace={ws}
									agentsRunning={sessions.filter(s => s.status === 'working').length}
									actions={workspaceActions}
								/>
								<DiffButton stats={ws.change_stats} open={diffOpen} onToggle={toggleDiff} />
							</>
						}
					/>
					{sessions.length > 0 || ws.state === 'ready' || selectedDiffFile ? (
						<SessionTabs
							sessions={sessions}
							activeId={pickedSubagent ? null : sessionId}
							readMarks={readMarks}
							promptStates={promptStates}
							roles={sessionRoles}
							subtabSessionIds={delegationSubtabSessionIds}
							fileTab={
								selectedDiffFile
									? {
											path: selectedDiffFile,
											active: !!activeDiffFile,
											onSelect: () => selectDiffFile(selectedDiffFile),
											onClose: closeDiffFile
										}
									: undefined
							}
							onSelect={pickSession}
							onContext={session => setContextSession({ workspaceId: ws.id, id: session.id, title: session.title })}
							onNewChat={createChat}
							onClose={id => void closeChat(id)}
							onClosedTabs={() => setClosedTabsFor(ws.id)}
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
							{closeRetryId ? (
								<button
									type="button"
									onClick={() => void closeChat(closeRetryId)}
									disabled={!!closingChat || !online}
									className="shrink-0 rounded-lg px-2 py-1 font-medium active:bg-surface-2 disabled:opacity-50"
								>
									Retry close
								</button>
							) : null}
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
					{historyError?.workspaceId === ws.id ? (
						<div className="flex shrink-0 items-center gap-2 border-b border-del/30 bg-del/5 px-3 py-2 text-xs text-del">
							<span className="min-w-0 flex-1">
								The new chat is ready, but joining its history failed. {historyError.message}
							</span>
							<button
								type="button"
								className="shrink-0 rounded-lg px-2 py-1 font-medium disabled:opacity-50"
								onClick={() => void retryHistory()}
								disabled={joiningHistory || !online}
							>
								{joiningHistory ? 'Joining…' : 'Retry joining history'}
							</button>
						</div>
					) : null}
					{delegationPipelines.map(delegationPipeline => (
						<DelegationPipeline
							key={delegationPipeline.parentSessionId}
							workflow={delegationPipeline.workflow}
							jobs={delegationPipeline.jobs}
							sessions={sessions}
							roles={delegationPipeline.roles}
							activeSessionId={pickedSubagent ? null : sessionId}
							onSelectSession={pickSession}
						/>
					))}
					{ws.delegation_warning || delegationError ? (
						<div className="shrink-0 border-b border-del/30 bg-del/5 px-3 py-1.5 text-xs text-del">
							{delegationError ?? ws.delegation_warning}
						</div>
					) : null}
					<div className="relative min-h-0 flex flex-1 flex-col">
						{/* The relay's undelivered prompt for this chat: one parked for the lock screen
							    wins (it names its session; oldest first, since delivery is FIFO), else the
							    workspace's first prompt still waiting on setup. */}
						{activeDiffFile ? (
							<DiffFileViewer
								key={activeDiffFile}
								review={diffReview}
								filePath={activeDiffFile}
								scope={diffFileScope}
								showFolders={showFolders}
								onSelectFile={selectDiffFile}
								onShowFiles={() => {
									setDiffOpen(true)
									setDiffNavigatorLocation(location.key)
								}}
								onClose={closeDiffFile}
							/>
						) : (
							<Transcript
								sessionId={sessionId}
								historySessionIds={historySessionIds}
								workspaceId={ws.id}
								working={working}
								workingSince={workingSince}
								turnStartedAt={activeSession?.turn_started_at}
								waiting={activeSession?.background_tasks}
								delegations={adHocDelegations}
								agentType={activeSession?.agent_type}
								model={activeSession?.model}
								selectedSubagentId={pickedSubagent}
								queued={ws.parked_prompts?.find(p => p.sessionId === sessionId) ?? ws.pending_prompt}
								onFork={forkChat}
								onCompact={compactChat}
								compactUnavailable={compactUnavailable}
								onSelectSession={pickSession}
								onSelectSubagent={pickSubagent}
								onDismissDelegation={delegationId => void dismissDelegation(delegationId)}
								onOpenRoles={() => setRolesOpen(true)}
							/>
						)}
						{diffOpen && diffNavigatorOpen ? (
							<MobileDiffNavigator
								review={diffReview}
								sessionId={sessionId}
								scope={diffFileScope}
								onScopeChange={changeDiffFileScope}
								showFolders={showFolders}
								onShowFoldersChange={value => setView({ showFolders: value })}
								selectedFile={activeDiffFile}
								onSelectFile={selectDiffFile}
								onClose={closeDiff}
							/>
						) : null}
					</div>
					{/* A native child is only a transcript slice, never a promptable Conductor
					    session. Keep the parent composer out of that view so a reply cannot look
					    like it is being sent to the child. */}
					{pickedSubagent ? (
						<SubagentReplyNotice title={activeSession?.title} onReturn={() => pickSubagent(null)} />
					) : (
						<Composer
							key={ws.id}
							session={activeSession}
							sessionId={sessionId}
							workspaceId={ws.id}
							working={working}
							actuator={actuator}
							onCompact={() => compactChat({ thinking: true, tools: false })}
							compactUnavailable={compactUnavailable}
							onCall={canCall ? openCall : undefined}
							callActive={voiceActive}
							onContext={
								activeSession
									? () =>
											setContextSession({
												workspaceId: ws.id,
												id: activeSession.id,
												title: activeSession.title
											})
									: undefined
							}
							workflowStarted={
								!!(sessionId && sessionRoles[sessionId]) || !!(ws.pending_prompt && sessionId === ws.active_session_id)
							}
							workflow={sessionWorkflow}
							workflowRole={workflowRole}
							focusDraft={sessionId === focusComposerFor}
							onDraftFocused={() => setFocusComposerFor(null)}
						/>
					)}
				</div>

				{diffOpen ? (
					<DiffPanel
						review={diffReview}
						sessionId={sessionId}
						scope={diffFileScope}
						onScopeChange={changeDiffFileScope}
						showFolders={showFolders}
						onShowFoldersChange={value => setView({ showFolders: value })}
						selectedFile={activeDiffFile}
						onSelectFile={selectDiffFile}
						onClose={closeDiff}
					/>
				) : null}
				{rolesOpen ? <RolesSettings onClose={() => setRolesOpen(false)} /> : null}
				{contextSession && contextSession.workspaceId === workspaceId ? (
					<ContextBreakdownSheet
						sessionId={contextSession.id}
						title={contextSession.title}
						revision={sessions.find(session => session.id === contextSession.id)?.updated_at}
						onClose={() => setContextSession(null)}
					/>
				) : null}
			</div>
		</MentionResolverProvider>
	)
}
