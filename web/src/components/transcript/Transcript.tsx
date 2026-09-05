import { useQueryClient } from '@tanstack/react-query'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useSendPrompt } from '../../hooks/send.ts'
import { useTranscript } from '../../hooks/transcript.ts'
import { client } from '../../lib/api.ts'
import { isUnconfirmed, pendingMatchesTranscript } from '../../lib/prompts/pending.ts'
import { assistantTurnEnds, latestAssistantForActions, turnOrigin } from '../../lib/transcript/actions.ts'
import { transcriptSubagents, transcriptTree } from '../../lib/transcript/tree.ts'
import type { BackgroundTask, DelegationProjection, PendingPrompt } from '../../lib/types.ts'
import { useApp } from '../../store.ts'
import { AgentSubtabStrip } from '../orchestration/AgentSubtabs.tsx'
import { DelegationBubbles } from '../orchestration/DelegationBubbles.tsx'
import { Empty, Spinner } from '../ui.tsx'
import { WaitingIndicator, WorkingIndicator } from './ActivityIndicator.tsx'
import { ChatActions } from './ChatActions.tsx'
import { NodeEntry, PendingEntry, QueuedEntry, StepGroup, SubagentResult, subagentFinal } from './entries.tsx'
import { groupSteps, rowKey } from './grouping.ts'
import { MessageNav } from './MessageNav.tsx'
import { TranscriptHistory } from './TranscriptHistory.tsx'
import type { SplitFormat } from './types.ts'

export function Transcript({
	sessionId,
	historySessionIds = [],
	workspaceId,
	working,
	workingSince,
	turnStartedAt,
	queued,
	waiting,
	delegations = [],
	poll,
	agentType,
	model,
	selectedSubagentId,
	onFork,
	onCompact,
	compactUnavailable,
	onSelectSession,
	onSelectSubagent,
	onDismissDelegation,
	onOpenRoles
}: {
	sessionId: string | null
	/** Prior real chats, oldest first, kept inline above the fresh context. */
	historySessionIds?: string[]
	workspaceId: string
	working?: boolean
	/**
	 * Background tasks the chat is waiting on (`Session.background_tasks`). Conductor
	 * reads the chat `idle` meanwhile, so `working` is off and this is the only sign
	 * the agent will be back.
	 */
	waiting?: BackgroundTask[]
	/** Active/failed delegated jobs involving this workspace. */
	delegations?: DelegationProjection[]
	/** Epoch ms the current answer started (see SessionView) — the elapsed timer's origin. */
	workingSince?: number | null
	/**
	 * `sessions.turn_started_at`: when the last turn was dispatched. The running clock
	 * uses `workingSince`, which folds in our own send's hint; this is the DB column
	 * alone, because a finished turn's duration has to be measured against a real
	 * dispatch and not against a hint left over from a send.
	 */
	turnStartedAt?: string | null
	/** The relay's undelivered first prompt for this workspace (src/delivery/firstprompt.ts). */
	queued?: PendingPrompt | null
	/** `false` for an archived chat: it is fetched once, because it has no next message. */
	poll?: boolean
	/** Provider identity inherited by native children unless their SDK says otherwise. */
	agentType?: string | null
	model?: string | null
	/** Spawning tool id for the native child transcript currently on screen. */
	selectedSubagentId?: string | null
	/** Opens a new chat or workspace with a selected transcript cut staged as an attachment. */
	onFork?: (format: SplitFormat) => Promise<void>
	/** Latest response only; same formats as Fork, keeping prior chats inline in this UI tab. */
	onCompact?: (format: SplitFormat) => Promise<void>
	compactUnavailable?: string
	onSelectSession?: (sessionId: string) => void
	/** Native children share this session; selection addresses their durable tool call instead. */
	onSelectSubagent?: (toolUseId: string | null) => void
	onDismissDelegation?: (delegationId: string) => void
	onOpenRoles?: () => void
}) {
	const { entries, loading, error } = useTranscript(sessionId, poll ?? true)
	const pending = useApp(s => s.pending)
	const removePending = useApp(s => s.removePending)
	const sendPrompt = useSendPrompt()
	const cannotCompact =
		compactUnavailable ?? (entries.some(e => e.queued) ? 'Send or dismiss queued prompts before compacting' : undefined)
	const queryClient = useQueryClient()
	const scroller = useRef<HTMLDivElement>(null)
	const atBottom = useRef(true)
	const historyLayout = useCallback(() => {
		const el = scroller.current
		if (el && atBottom.current) el.scrollTop = el.scrollHeight
	}, [])

	// Conductor interleaves a native agent's frames with its parent's, but gives every
	// child a durable pointer back to the spawning tool call. Rebuild that hierarchy,
	// then expose each call as the same second-level tab workflow children already use.
	const nodes = useMemo(() => transcriptTree(entries), [entries])
	const subagents = useMemo(() => transcriptSubagents(nodes), [nodes])
	const selectedSubagent = selectedSubagentId
		? subagents.find(subagent => subagent.id === selectedSubagentId)
		: undefined
	const showingSubagent = !!selectedSubagent
	const visibleNodes = selectedSubagent?.node.children ?? nodes
	const rootEntries = useMemo(() => nodes.map(node => node.e), [nodes])
	// Grouping is pure of `entries`, and `entries` only changes when a row actually
	// lands — so this holds the row list (and each group's slice) at the same identity
	// across the polls above, which is what lets the memoised rows below bail out.
	const rows = useMemo(() => groupSteps(visibleNodes), [visibleNodes])
	// The newest turn's Copy/Fork is drawn *after* every row rather than under its
	// response: an agent that speaks and then keeps working buries the buttons
	// mid-transcript, where they read as belonging to the step below them. Older turns
	// have nothing growing under them, so theirs sit where the cut they offer is.
	const actionTarget = useMemo(() => latestAssistantForActions(rootEntries), [rootEntries])
	const inlineActions = useMemo(() => {
		const ends = assistantTurnEnds(rootEntries).filter(e => e !== actionTarget)
		return new Set(ends.map(rowKey))
	}, [rootEntries, actionTarget])
	// Each turn's duration is measured from its own start, so the origins are resolved
	// once per transcript change rather than per render — every row here redraws on a
	// 1s poll, and a scan back through the chat per turn would ride along with it.
	const turnStarts = useMemo(
		() => new Map(assistantTurnEnds(rootEntries).map(e => [e, turnOrigin(rootEntries, e, turnStartedAt)])),
		[rootEntries, turnStartedAt]
	)
	const selectedSubagentFinal = selectedSubagent ? subagentFinal(selectedSubagent.node) : null

	// A copied/stale URL can name a tool call this transcript no longer contains. Wait
	// for the initial read before clearing it, then fail open to the real parent chat.
	useEffect(() => {
		if (selectedSubagentId && !loading && !selectedSubagent) onSelectSubagent?.(null)
	}, [selectedSubagentId, selectedSubagent, loading, onSelectSubagent])

	// The relay owns the entry, so dropping it is a request, not a local edit. A
	// parked prompt (lock screen) belongs to its chat, a first prompt to its workspace.
	const dismiss = async (q: PendingPrompt) => {
		await (q.sessionId ? client.dismissParked(q.sessionId) : client.dismissPrompt(q.workspaceId)).catch(() => undefined)
		queryClient.invalidateQueries({ queryKey: ['state'] })
	}

	// This session's optimistic prompts, hiding any still-unconfirmed one whose text
	// has already arrived as a real user row — the confirmed bubble replaces it.
	const delivered = new Set(entries.filter(e => e.role === 'user').map(e => e.text.trim()))
	const deliveredTexts = [...delivered]
	const mine = pending.filter(p => p.sessionId === sessionId)
	const visiblePending = mine.filter(
		p => !(isUnconfirmed(p) && deliveredTexts.some(text => pendingMatchesTranscript(p, text)))
	)

	// The relay keeps the entry until delivery is *confirmed*, and its own send lands as
	// a real user row up to a poll before /api/state drops it — so hide the queued bubble
	// as soon as the text shows up in the chat (or in a bubble of our own), or it doubles.
	const queuedText = queued?.text.trim() || null
	const showQueued =
		queuedText && !delivered.has(queuedText) && !mine.some(p => p.text.trim() === queuedText) ? queued : null
	const hasDelegations =
		!!sessionId && delegations.some(job => job.parentSessionId === sessionId || job.childSessionId === sessionId)

	// Purge confirmed optimistic bubbles from the store once the real row shows (the
	// send hook also purges on a timer; this catches the fast path so nothing lingers).
	// It is also the only thing that retires a bubble restored from storage, whose send
	// resolved while the app wasn't running to hear it (lib/prompts/pending.ts).
	useEffect(() => {
		const seen = entries.filter(e => e.role === 'user').map(e => e.text.trim())
		for (const p of pending) {
			if (p.sessionId === sessionId && isUnconfirmed(p) && seen.some(text => pendingMatchesTranscript(p, text))) {
				removePending(p.id)
			}
		}
	}, [entries, pending, sessionId, removePending])

	// Track whether the user is pinned to the bottom before new content lands.
	const onScroll = () => {
		const el = scroller.current
		if (!el) return
		atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
	}

	const waitingCount = waiting?.length ?? 0
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire on new entries, view selection, a new optimistic bubble, or an indicator toggling to keep the view pinned
	useLayoutEffect(() => {
		const el = scroller.current
		if (el && atBottom.current) el.scrollTop = el.scrollHeight
	}, [entries, visiblePending.length, working, waitingCount, selectedSubagentId])

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll intent when switching real or virtual sessions
	useEffect(() => {
		atBottom.current = true
	}, [sessionId, selectedSubagentId])

	// The scroller shrinks when the software keyboard opens (useVisualViewportHeight
	// resizes the whole column) and when the composer autogrows. Without this, its
	// scrollTop stays put and the newest messages slide out of view behind the
	// composer — re-pin instead, for anyone who was reading the bottom.
	useEffect(() => {
		const el = scroller.current
		if (!el) return
		const ro = new ResizeObserver(() => {
			if (atBottom.current) el.scrollTop = el.scrollHeight
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// A workspace still setting up has no chat yet — but if its first prompt is
	// waiting on that setup, showing it beats an empty pane that looks like a loss.
	if (!sessionId && !showQueued) return <Empty>No active session in this workspace.</Empty>

	const parentEmpty = entries.length === 0 && visiblePending.length === 0 && !showQueued && !hasDelegations
	const subagentEmpty = showingSubagent && visibleNodes.length === 0 && !selectedSubagentFinal
	const empty = showingSubagent ? subagentEmpty : parentEmpty
	const nativeTabs = subagents.map(subagent => {
		const failed = !!subagent.node.e.error
		const selected = subagent.id === selectedSubagent?.id
		return {
			key: subagent.id,
			label: subagent.label,
			model: model ?? null,
			agentType: agentType ?? null,
			...(failed ? { status: 'Failed', state: 'failed' as const } : {}),
			selected,
			...(onSelectSubagent ? { onSelect: () => onSelectSubagent(subagent.id) } : {})
		}
	})

	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<AgentSubtabStrip tabs={nativeTabs} label="Subagents" />
			<div className="relative flex min-h-0 min-w-0 flex-1">
				<div
					ref={scroller}
					onScroll={onScroll}
					className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
					data-subagent-transcript={selectedSubagent?.label}
				>
					{!showingSubagent
						? historySessionIds.map(id => (
								<TranscriptHistory key={id} sessionId={id} onLayout={historyLayout} onFork={onFork} />
							))
						: null}
					{loading && empty ? (
						<Spinner label="Loading transcript…" />
					) : error && empty ? (
						<Empty>{error}</Empty>
					) : subagentEmpty ? (
						<Empty>No activity from this agent yet.</Empty>
					) : empty && !working ? (
						<Empty>No messages yet.</Empty>
					) : (
						<div className="flex min-w-0 flex-col gap-2.5">
							{rows.map(row =>
								row.kind === 'steps' ? (
									<StepGroup key={row.key} nodes={row.nodes} />
								) : (
									<Fragment key={row.key}>
										<NodeEntry node={row.node} onSelectSubagent={onSelectSubagent} />
										{!showingSubagent && inlineActions.has(rowKey(row.node.e)) ? (
											<ChatActions
												text={row.node.e.text}
												entries={entries}
												at={row.node.e.ts}
												startedAt={turnStarts.get(row.node.e)}
												rowid={row.node.e.rowid}
												through={row.node.e.rowid}
												onFork={onFork}
											/>
										) : null}
									</Fragment>
								)
							)}
							{selectedSubagentFinal && selectedSubagent ? (
								<SubagentResult text={selectedSubagentFinal} failed={!!selectedSubagent.node.e.error} />
							) : null}
							{!showingSubagent && actionTarget ? (
								<ChatActions
									text={actionTarget.text}
									entries={entries}
									at={actionTarget.ts}
									startedAt={turnStarts.get(actionTarget)}
									rowid={actionTarget.rowid}
									working={working}
									onFork={onFork}
									onCompact={onCompact}
									compactUnavailable={cannotCompact}
								/>
							) : null}
							{!showingSubagent && delegations.length && onSelectSession && onDismissDelegation && onOpenRoles ? (
								<DelegationBubbles
									jobs={delegations}
									sessionId={sessionId}
									onSelectSession={onSelectSession}
									onDismiss={onDismissDelegation}
									onOpenRoles={onOpenRoles}
								/>
							) : null}
							{!showingSubagent
								? visiblePending.map(p => (
										<PendingEntry
											key={p.id}
											p={p}
											onRetry={() =>
												sendPrompt({
													id: p.id,
													sessionId: p.sessionId,
													workspaceId: p.workspaceId,
													text: p.text,
													queue: p.queue,
													workflow: p.workflow
												})
											}
											onDismiss={() => removePending(p.id)}
										/>
									))
								: null}
							{!showingSubagent && showQueued ? (
								<QueuedEntry
									queued={showQueued}
									// Keyed on the entry being retried, not re-rolled per tap, so a Retry whose
									// answer goes missing can be tapped again without sending twice — the same
									// identity a failed bubble gets from its own id (web/src/lib/api.ts).
									onRetry={
										sessionId
											? () =>
													sendPrompt({
														id: `queued:${showQueued.sessionId ?? showQueued.workspaceId}:${showQueued.createdAt}`,
														sessionId,
														workspaceId,
														text: showQueued.text
													})
											: undefined
									}
									onDismiss={() => dismiss(showQueued)}
								/>
							) : null}
							{!showingSubagent ? waiting?.map(task => <WaitingIndicator key={task.taskId} task={task} />) : null}
							{/* The agent can publish a short update, then carry on with tools. Keep its
							    live indicator after every transcript row so activity always reads as the
							    newest item, rather than attaching it to that earlier update. */}
							{!showingSubagent && working ? <WorkingIndicator since={workingSince} /> : null}
						</div>
					)}
				</div>
				{!showingSubagent ? (
					/* Reads the transcript's own DOM (`data-user-msg`), so it needs no entry list of its own. */
					<MessageNav scroller={scroller} />
				) : null}
			</div>
		</div>
	)
}
