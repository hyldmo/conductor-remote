import { useQueryClient } from '@tanstack/react-query'
import { FileDiff, FolderTree, Hourglass, LoaderCircle, Plus, Workflow, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
	useAnyWorkspace,
	useClearChatNotification,
	useDiff,
	useFileDiff,
	useSessions,
	useWorkspaceFiles,
	useWorkspaces
} from '../hooks.ts'
import { ApiError, client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import type { DiffFileScope } from '../lib/diff.ts'
import { buildResolver, MentionResolverProvider } from '../lib/fileMentions.ts'
import { shortModel, timestampMs, workspaceTitle } from '../lib/format.ts'
import { isLockedError } from '../lib/lock.ts'
import { type PromptIndicatorState, promptIndicator } from '../lib/pending.ts'
import { isUnread, type ReadMarks } from '../lib/read.ts'
import type {
	DelegationProjection,
	DiffStats,
	Session,
	SessionRoleAssignment,
	WorkflowRoleName,
	WorkflowRunWire
} from '../lib/types.ts'
import { useApp, WORKING_HINT_MS } from '../store.ts'
import { ArchivedChat } from './ArchivedChat.tsx'
import { Composer } from './Composer.tsx'
import { ContextBreakdownSheet } from './ContextBreakdownSheet.tsx'
import { DelegationPipeline } from './DelegationPipeline.tsx'
import { DevServerControls } from './DevServerControls.tsx'
import { DiffFileViewer, type DiffReviewState, DiffView } from './DiffView.tsx'
import { Header } from './Header.tsx'
import { RoleChip, RolesSettings } from './RolesSettings.tsx'
import type { SplitFormat } from './Transcript.tsx'
import { Transcript } from './Transcript.tsx'
import { PromptStatusDot, Spinner, UnlockLink } from './ui.tsx'
import { WorkspaceMenu } from './WorkspaceMenu.tsx'

/** Resolve Workflow ownership from the exact chat, never from a workspace-level display fallback. */
export function workflowForActiveSession(
	workflows: readonly WorkflowRunWire[],
	sessionId: string | null,
	roles: Readonly<Record<string, SessionRoleAssignment>>,
	jobs: readonly DelegationProjection[]
): WorkflowRunWire | undefined {
	if (!sessionId) return undefined
	const root = workflows.find(workflow => workflow.rootSessionId === sessionId)
	if (root) return root
	const assignedWorkflowId = roles[sessionId]?.workflowId
	if (assignedWorkflowId) {
		const assigned = workflows.find(workflow => workflow.id === assignedWorkflowId)
		if (assigned) return assigned
	}
	const jobWorkflowId = jobs.find(job => job.childSessionId === sessionId && job.workflowId)?.workflowId
	return jobWorkflowId ? workflows.find(workflow => workflow.id === jobWorkflowId) : undefined
}

interface DelegationPipelineSelection {
	workflow?: WorkflowRunWire
	jobs: DelegationProjection[]
	roles: Record<string, SessionRoleAssignment>
}

/** Child tabs belong beneath their parent chat, never whichever top-level tab happens to be open. */
export function delegationPipelineForParentSession(
	workflows: readonly WorkflowRunWire[],
	jobs: readonly DelegationProjection[],
	roles: Readonly<Record<string, SessionRoleAssignment>>,
	sessionId: string | null
): DelegationPipelineSelection | undefined {
	if (!sessionId) return undefined
	const workflow = workflows.find(candidate => candidate.rootSessionId === sessionId)
	const parentJobs = jobs.filter(job => job.parentSessionId === sessionId)
	const activeAssignment = roles[sessionId]
	const hasPersistedLegacyChildren = Object.values(roles).some(
		assignment => assignment.delegationId && !assignment.workflowId
	)
	// Legacy jobs were deleted after returning, while their role assignments survived.
	// Their old role document did not record the parent id, but did mark that parent as
	// planning; keep those completed children reachable only from that parent tab.
	const isLegacyParent =
		activeAssignment?.role === 'planning' &&
		!activeAssignment.delegationId &&
		!activeAssignment.workflowId &&
		hasPersistedLegacyChildren
	if (!workflow && !parentJobs.length && !isLegacyParent) return undefined

	const parentLegacyJobIds = new Set(parentJobs.filter(job => !job.workflowId).map(job => job.id))
	const scopedRoles = Object.fromEntries(
		Object.entries(roles).filter(([candidateId, assignment]) => {
			if (candidateId === sessionId) return true
			if (assignment.workflowId) return assignment.workflowId === workflow?.id
			if (!assignment.delegationId) return false
			return isLegacyParent || parentLegacyJobIds.has(assignment.delegationId)
		})
	)

	return { workflow, jobs: parentJobs, roles: scopedRoles }
}

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
	const [diffFileScope, setDiffFileScope] = useState<DiffFileScope>('changed')
	const [selectedDiff, setSelectedDiff] = useState<{ workspaceId: string; path: string } | null>(null)
	const [diffNavigatorOpen, setDiffNavigatorOpen] = useState(false)
	const selectedDiffFile = selectedDiff && selectedDiff.workspaceId === workspaceId ? selectedDiff.path : null
	const [rolesOpen, setRolesOpen] = useState(false)
	const [delegationError, setDelegationError] = useState<string | null>(null)
	const [creatingChat, setCreatingChat] = useState(false)
	const [closingChat, setClosingChat] = useState<string | null>(null)
	const [confirmingClose, setConfirmingClose] = useState<string | null>(null)
	const [closeError, setCloseError] = useState<string | null>(null)
	const [focusComposerFor, setFocusComposerFor] = useState<string | null>(null)
	const [contextSession, setContextSession] = useState<{
		workspaceId: string
		id: string
		title: string | null
	} | null>(null)
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const { data, isLoading } = useWorkspaces()
	const liveWorkspace = data?.workspaces.find(w => w.id === workspaceId)
	const diffQuery = useDiff(workspaceId, diffOpen && !!liveWorkspace)
	const fileDiffQuery = useFileDiff(
		workspaceId,
		selectedDiffFile,
		diffOpen && diffFileScope === 'changed' && !!liveWorkspace && !!diffQuery.data?.truncated
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
	const setDraft = useApp(s => s.setDraft)
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
		diffOpen && diffFileScope === 'all'
	)
	const { data: workspaceFiles } = workspaceFilesQuery
	const worktree = liveWorkspace?.worktree ?? null
	const files = workspaceFiles?.files
	const fileReferences = useMemo(
		() => ({ resolveMention: buildResolver(worktree, files), worktree }),
		[worktree, files]
	)

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
	const sessionRoles = { ...(sessionsData?.session_roles ?? {}), ...(ws?.session_roles ?? {}) }
	const delegations = ws?.delegations ?? []
	const legacyDelegations = delegations.filter(job => !job.workflowId)
	const workspaceWorkflows = (data?.workflows ?? []).filter(run => run.workspaceId === workspaceId)
	if (ws?.workflow && !workspaceWorkflows.some(run => run.id === ws.workflow?.id)) workspaceWorkflows.push(ws.workflow)
	const sessionWorkflow = workflowForActiveSession(workspaceWorkflows, sessionId, sessionRoles, delegations)
	const delegationPipeline = delegationPipelineForParentSession(
		workspaceWorkflows,
		delegations,
		sessionRoles,
		sessionId
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
	const closeDiff = () => {
		setDiffOpen(false)
		setSelectedDiff(null)
		setDiffNavigatorOpen(false)
	}
	const closeDiffFile = () => {
		// The file viewer sits beside the changed-files rail on desktop. Its close
		// button dismisses only that file; the rail's own close button owns closing
		// the whole review. On mobile, reopening the navigator is the equivalent
		// "back to changed files" destination.
		setSelectedDiff(null)
		setDiffNavigatorOpen(true)
	}

	const toggleDiff = () => {
		if (diffOpen) closeDiff()
		else {
			setDiffOpen(true)
			setDiffNavigatorOpen(true)
		}
	}

	const selectDiffFile = (path: string) => {
		setSelectedDiff({ workspaceId: ws.id, path })
		// The file rail stays mounted on desktop. On a phone it is an overlay,
		// so selecting a row dismisses it to reveal this file in the transcript's slot.
		setDiffNavigatorOpen(false)
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
								<WorkspaceMenu workspace={ws} agentsRunning={sessions.filter(s => s.status === 'working').length} />
								<DiffButton stats={ws.change_stats} open={diffOpen} onToggle={toggleDiff} />
							</>
						}
					/>
					{sessions.length > 0 || ws.state === 'ready' ? (
						<SessionTabs
							sessions={sessions}
							activeId={sessionId}
							readMarks={readMarks}
							promptStates={promptStates}
							roles={sessionRoles}
							subtabSessionIds={delegationSubtabSessionIds}
							onSelect={pickSession}
							onContext={session => setContextSession({ workspaceId: ws.id, id: session.id, title: session.title })}
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
					{delegationPipeline ? (
						<DelegationPipeline
							workflow={delegationPipeline.workflow}
							jobs={delegationPipeline.jobs}
							sessions={sessions}
							roles={delegationPipeline.roles}
							activeSessionId={sessionId}
							onSelectSession={pickSession}
						/>
					) : null}
					{ws.delegation_warning || delegationError ? (
						<div className="shrink-0 border-b border-del/30 bg-del/5 px-3 py-1.5 text-xs text-del">
							{delegationError ?? ws.delegation_warning}
						</div>
					) : null}
					<div className="relative min-h-0 flex flex-1 flex-col">
						{/* The relay's undelivered prompt for this chat: one parked for the lock screen
							    wins (it names its session; oldest first, since delivery is FIFO), else the
							    workspace's first prompt still waiting on setup. */}
						{selectedDiffFile ? (
							<DiffFileViewer
								key={selectedDiffFile}
								review={diffReview}
								filePath={selectedDiffFile}
								scope={diffFileScope}
								showFolders={showFolders}
								onSelectFile={selectDiffFile}
								onShowFiles={() => setDiffNavigatorOpen(true)}
								onClose={closeDiffFile}
							/>
						) : (
							<Transcript
								sessionId={sessionId}
								workspaceId={ws.id}
								working={working}
								workingSince={workingSince}
								turnStartedAt={activeSession?.turn_started_at}
								waiting={activeSession?.background_tasks}
								delegations={legacyDelegations}
								queued={ws.parked_prompts?.find(p => p.sessionId === sessionId) ?? ws.pending_prompt}
								onFork={forkChat}
								onSelectSession={pickSession}
								onDismissDelegation={delegationId => void dismissDelegation(delegationId)}
								onOpenRoles={() => setRolesOpen(true)}
							/>
						)}
						{diffOpen && (diffNavigatorOpen || !selectedDiffFile) ? (
							<MobileDiffNavigator
								review={diffReview}
								sessionId={sessionId}
								scope={diffFileScope}
								onScopeChange={changeDiffFileScope}
								showFolders={showFolders}
								onShowFoldersChange={value => setView({ showFolders: value })}
								selectedFile={selectedDiffFile}
								onSelectFile={selectDiffFile}
								onClose={closeDiff}
							/>
						) : null}
					</div>
					{/* The agent controls — and the Stop button — render inside the composer card. */}
					<Composer
						key={ws.id}
						session={activeSession}
						sessionId={sessionId}
						workspaceId={ws.id}
						working={working}
						actuator={actuator}
						onFork={prompt => forkChat({ thinking: true, tools: false }, prompt)}
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
				</div>

				{diffOpen ? (
					<DiffPanel
						review={diffReview}
						sessionId={sessionId}
						scope={diffFileScope}
						onScopeChange={changeDiffFileScope}
						showFolders={showFolders}
						onShowFoldersChange={value => setView({ showFolders: value })}
						selectedFile={selectedDiffFile}
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

/** Header shortcut to the workspace diff, with a glanceable hint when changes exist. */
export function DiffButton({
	stats,
	open,
	onToggle
}: {
	stats?: DiffStats | null
	open: boolean
	onToggle: () => void
}) {
	const hasDiff = !!stats && (stats.added > 0 || stats.removed > 0)
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={hasDiff ? 'Toggle diff panel, changes available' : 'Toggle diff panel'}
			aria-pressed={open}
			className={cn(
				'relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2',
				open && 'bg-surface-2 text-text'
			)}
		>
			<FileDiff size={19} />
			{hasDiff ? (
				<span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />
			) : null}
		</button>
	)
}

/** Conductor workspaces can hold several sessions — render them as tabs like the desktop app,
 *  with a trailing "+" (new chat, same files) pinned past the scrollable tabs. */
export function SessionTabs({
	sessions,
	activeId,
	readMarks,
	promptStates,
	roles = {},
	subtabSessionIds,
	onSelect,
	onContext,
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
	roles?: Record<string, SessionRoleAssignment>
	/** Live delegated children not yet present in the durable role snapshot. */
	subtabSessionIds?: ReadonlySet<string>
	onSelect: (id: string) => void
	onContext: (session: Session) => void
	onNewChat: () => void
	onClose: (id: string) => void
	creating: boolean
	closingId: string | null
	online: boolean
}) {
	const activeTab = useRef<HTMLDivElement>(null)
	const primarySessions = sessions.filter(
		session => !roles[session.id]?.delegationId && !subtabSessionIds?.has(session.id)
	)
	const activeHasPrimaryTab = primarySessions.some(session => session.id === activeId)

	// Opening a workspace can restore a session near the end of a long tab row. Keep its
	// selected tab visible on first paint and after each tab change, without moving the
	// transcript or the rest of the page.
	useLayoutEffect(() => {
		if (!(activeId && activeHasPrimaryTab)) return
		activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [activeId, activeHasPrimaryTab])

	return (
		<nav className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-bg px-3 py-2">
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				{primarySessions.map(s => {
					const promptState = promptStates[s.id]
					const hasContext = typeof s.context_used_percent === 'number' && s.context_used_percent > 0
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
								className={cn(
									'flex min-w-0 items-center gap-1.5 py-1.5 pl-3.5',
									sessions.length > 1 || hasContext ? 'pr-1' : 'pr-3.5'
								)}
							>
								{promptState ? (
									<PromptStatusDot state={promptState} className="size-3" />
								) : s.status === 'working' ? (
									<span className="dot-spinner size-3" />
								) : s.background_tasks?.length ? (
									<Hourglass size={11} className="shrink-0 text-faint" aria-label="Waiting for a background task" />
								) : null}
								<span className="whitespace-nowrap">{s.title || 'Untitled'}</span>
								{roles[s.id] ? <RoleChip name={roles[s.id].role} /> : null}
								{/* `unread_count` is a 0/1 flag, so a dot — not the meaningless number "1". */}
								{isUnread(s, readMarks) ? <span className="dot size-1.5 bg-accent" /> : null}
							</button>
							<ContextButton session={s} onOpen={() => onContext(s)} />
							{sessions.length > 1 ? (
								<button
									type="button"
									onClick={() => onClose(s.id)}
									disabled={!online || closingId !== null}
									aria-label={`Close ${s.title || 'Untitled'} chat`}
									className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-bg/70 active:text-text disabled:opacity-40"
								>
									{closingId === s.id ? <LoaderCircle size={12} className="animate-spin" /> : <X size={12} />}
								</button>
							) : null}
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
function ContextButton({ session, onOpen }: { session: Session; onOpen: () => void }) {
	const used = session.context_used_percent
	if (typeof used !== 'number' || used <= 0) return null
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Context for ${session.title || 'Untitled'}: ${Math.round(used)}% used`}
			aria-haspopup="dialog"
			className={cn(
				'flex h-7 min-w-10 shrink-0 items-center justify-center rounded-full px-2 text-[11px] tabular-nums transition active:bg-bg/70',
				used >= 80 ? 'text-working' : 'text-faint'
			)}
		>
			{Math.round(used)}%
		</button>
	)
}

/** One shared segmented control for the desktop rail and mobile file navigator. */
export function DiffFileScopeToggle({
	scope,
	onChange
}: {
	scope: DiffFileScope
	onChange: (scope: DiffFileScope) => void
}) {
	return (
		<fieldset aria-label="Files shown" className="flex shrink-0 rounded-full bg-surface-2 p-0.5 text-xs">
			{(['changed', 'all'] as const).map(value => (
				<button
					key={value}
					type="button"
					onClick={() => onChange(value)}
					aria-label={value === 'changed' ? 'Changed files' : 'All files'}
					aria-pressed={scope === value}
					className={cn(
						'rounded-full px-2.5 py-1 font-medium text-muted transition',
						scope === value && 'bg-bg text-text shadow-sm'
					)}
				>
					{value === 'changed' ? 'Changed' : 'All'}
				</button>
			))}
		</fieldset>
	)
}

/** One persisted switch shared by the desktop rail and mobile file navigator. */
export function DiffFolderToggle({
	showFolders,
	onChange
}: {
	showFolders: boolean
	onChange: (showFolders: boolean) => void
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!showFolders)}
			aria-label="Group files into folders"
			aria-pressed={showFolders}
			title="Group files into folders"
			className={cn(
				'flex size-8 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-surface-2',
				showFolders && 'bg-surface-2 text-text'
			)}
		>
			<FolderTree size={16} />
		</button>
	)
}

/** Workspace files stay as the right rail on lg+. */
function DiffPanel({
	review,
	sessionId,
	scope,
	onScopeChange,
	showFolders,
	onShowFoldersChange,
	selectedFile,
	onSelectFile,
	onClose
}: {
	review: DiffReviewState
	sessionId: string | null
	scope: DiffFileScope
	onScopeChange: (scope: DiffFileScope) => void
	showFolders: boolean
	onShowFoldersChange: (showFolders: boolean) => void
	selectedFile: string | null
	onSelectFile: (path: string) => void
	onClose: () => void
}) {
	return (
		<aside className="hidden flex-col bg-bg lg:flex lg:w-[380px] lg:shrink-0 lg:border-l lg:border-border-soft xl:w-[460px]">
			<header className="flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
				<span className="flex-1 text-[15px] font-semibold">Files</span>
				<DiffFileScopeToggle scope={scope} onChange={onScopeChange} />
				<DiffFolderToggle showFolders={showFolders} onChange={onShowFoldersChange} />
				<button
					type="button"
					onClick={onClose}
					aria-label="Close diff panel"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<DiffView
				review={review}
				sessionId={sessionId}
				scope={scope}
				showFolders={showFolders}
				selectedFile={selectedFile}
				onSelectFile={onSelectFile}
			/>
		</aside>
	)
}

/** On narrow screens the same file rail replaces only the transcript, never the composer. */
function MobileDiffNavigator({
	review,
	sessionId,
	scope,
	onScopeChange,
	showFolders,
	onShowFoldersChange,
	selectedFile,
	onSelectFile,
	onClose
}: {
	review: DiffReviewState
	sessionId: string | null
	scope: DiffFileScope
	onScopeChange: (scope: DiffFileScope) => void
	showFolders: boolean
	onShowFoldersChange: (showFolders: boolean) => void
	selectedFile: string | null
	onSelectFile: (path: string) => void
	onClose: () => void
}) {
	return (
		<section className="absolute inset-0 z-20 flex flex-col bg-bg lg:hidden" aria-label="Workspace files">
			<header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2.5">
				<span className="flex-1 text-[15px] font-semibold">Files</span>
				<DiffFileScopeToggle scope={scope} onChange={onScopeChange} />
				<DiffFolderToggle showFolders={showFolders} onChange={onShowFoldersChange} />
				<button
					type="button"
					onClick={onClose}
					aria-label="Close diff panel"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<DiffView
				review={review}
				sessionId={sessionId}
				scope={scope}
				showFolders={showFolders}
				selectedFile={selectedFile}
				onSelectFile={onSelectFile}
			/>
		</section>
	)
}
