import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Info, LoaderCircle, Minimize2, PhoneCall, Snowflake, Square, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useContextBreakdown, useWorkflowRoleReadiness } from '../../hooks/agents.ts'
import { useSendPrompt } from '../../hooks/send.ts'
import { client } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { contextRingSegments } from '../../lib/context.ts'
import { enterSubmits } from '../../lib/keys.ts'
import { isLockedError } from '../../lib/lock.ts'
import { requestPrefsFlush } from '../../lib/prefs.ts'
import { coldPromptCache } from '../../lib/prompts/cache.ts'
import { compactDraftLabel, DEFAULT_COMPACT } from '../../lib/prompts/compact-draft.ts'
import type { ActuatorInfo, Session, WorkflowRoleName, WorkflowRunWire } from '../../lib/types.ts'
import { useApp } from '../../store.ts'
import { AgentBar } from '../agents/AgentBar.tsx'
import { UnlockLink } from '../ui.tsx'
import {
	AttachmentPickerButton,
	AttachmentTray,
	EMPTY_ATTACHMENTS,
	useAttachmentUploads
} from './AttachmentUploads.tsx'

/**
 * The draft lives in the store (persisted per chat — see lib/prompts/draft.ts), not in
 * local state. Fork context is a separate saved attachment: it stays out of the
 * composer and joins the first message the user sends, including its retries.
 *
 * The agent controls live *inside* the card, under the text and sharing the send
 * button's row — one border, one left edge (card padding 8px + control padding
 * 8px = the textarea's own text inset, so labels and prompt line up on the same
 * rule). They used to be a separate strip above it, which read as a second
 * toolbar and lined up with nothing.
 *
 * Stop sits beside Send rather than replacing it, which is what the desktop
 * composer does and is not merely a style choice: Conductor lets you type into a
 * running turn (steering), so a working chat with a draft in the box shows both
 * buttons — stop left, send right — and one with an empty box shows only stop.
 */
export function Composer({
	session,
	sessionId,
	workspaceId,
	working,
	actuator,
	onCompact,
	preparingCompact = false,
	compactUnavailable,
	onCall,
	callActive = false,
	onContext,
	workflowStarted = false,
	hasPendingPrompt = false,
	workflow,
	workflowRole,
	focusDraft = false,
	onDraftFocused
}: {
	/** The chat the controls act on; absent while the workspace has no session yet. */
	session?: Session
	sessionId: string | null
	workspaceId: string
	/** Is this chat mid-answer? Conductor's status, or our own optimistic hint (see SessionView). */
	working: boolean
	actuator?: ActuatorInfo
	/** On Send, create fresh context and deliver the draft through that chat. */
	onCompact?: (queue: boolean) => Promise<void>
	/** Covers the source and destination while the parent prepares and sends a compacted draft. */
	preparingCompact?: boolean
	compactUnavailable?: string
	/** Start a call with this pane's active chat as its initial context. */
	onCall?: () => void
	callActive?: boolean
	/** Open the active chat's context composition and fork-size breakdown. */
	onContext?: () => void
	/** A Workflow or delegation already owns this otherwise-pristine composer. */
	workflowStarted?: boolean
	/** A relay-owned first or parked prompt already has a claim on the first send. */
	hasPendingPrompt?: boolean
	/** The run that owns this exact chat, never a workspace-level display fallback. */
	workflow?: WorkflowRunWire
	/** This session's frozen role inside `workflow`, when it is the root or a tracked child. */
	workflowRole?: WorkflowRoleName
	/** Focus the user's draft after opening a fork. */
	focusDraft?: boolean
	onDraftFocused?: () => void
}) {
	const draftKey = sessionId ?? workspaceId
	const text = useApp(s => s.drafts[draftKey] ?? '')
	const readyAttachments = useApp(s => s.draftAttachments[draftKey] ?? EMPTY_ATTACHMENTS)
	const visibleAttachments = readyAttachments.filter(attachment => attachment.source !== 'fork')
	const setDraft = useApp(s => s.setDraft)
	const addDraftAttachment = useApp(s => s.addDraftAttachment)
	const removeDraftAttachment = useApp(s => s.removeDraftAttachment)
	const clearDraftContent = useApp(s => s.clearDraftContent)
	const moveDraft = useApp(s => s.moveDraft)
	const setFocusedDraft = useApp(s => s.setFocusedDraft)
	const online = useApp(s => s.online)
	const clearWorking = useApp(s => s.clearWorking)
	const compactChoice = useApp(s => (sessionId ? s.compactDrafts[sessionId] : undefined))
	const setCompactDraft = useApp(s => s.setCompactDraft)
	const sendPrompt = useSendPrompt()
	const queryClient = useQueryClient()
	const [stopping, setStopping] = useState(false)
	const [stopError, setStopError] = useState<string | null>(null)
	const [compactingKey, setCompactingKey] = useState<string | null>(null)
	const compacting = preparingCompact || compactingKey === draftKey
	const [compactFailure, setCompactFailure] = useState<{ draftKey: string; message: string } | null>(null)
	const compactError = compactFailure?.draftKey === draftKey ? compactFailure.message : null
	const workflowMode = useApp(s => !!sessionId && s.workflowDrafts[sessionId] === true)
	const setWorkflowDraft = useApp(s => s.setWorkflowDraft)
	const setWorkflowMode = (active: boolean) => {
		if (sessionId) setWorkflowDraft(sessionId, active)
	}
	const ref = useRef<HTMLTextAreaElement>(null)
	const attachmentUploads = useAttachmentUploads({
		draftKey,
		ready: visibleAttachments,
		enabled: !!sessionId && online,
		upload: async (key, file) => (await client.uploadAttachment(key, workspaceId, file)).attachment,
		accept: addDraftAttachment,
		removeReady: removeDraftAttachment
	})
	const uploading = attachmentUploads.uploading
	const attachmentError = attachmentUploads.hasError
	const prompt = [...readyAttachments.map(attachment => attachment.token), text.trim()].filter(Boolean).join('\n')
	const hasMessage = !!text.trim() || visibleAttachments.length > 0
	const workflowSendPending = useApp(s => s.pending.some(p => p.sessionId === sessionId && !!p.workflow))
	const localPromptPending = useApp(s => s.pending.some(p => p.sessionId === sessionId))
	const workflowEligibilityProblem = !session
		? 'No active tab.'
		: workflowStarted || workflow
			? 'This tab already belongs to a Workflow or delegation.'
			: session.last_user_message_at
				? 'Workflow is available before this tab’s first message.'
				: hasPendingPrompt || localPromptPending
					? 'Resolve or dismiss the pending prompt before starting a Workflow.'
					: working || session.status !== 'idle' || session.background_tasks.length
						? 'Wait until this tab is idle before starting a Workflow.'
						: undefined
	const workflowPristine = !workflowEligibilityProblem
	const workflowVisible = workflowMode || workflowPristine
	const {
		roles,
		planningRole,
		problem: workflowRoleProblem,
		ready: workflowRolesReady
	} = useWorkflowRoleReadiness(workflowVisible)
	const workflowProblem =
		workflowEligibilityProblem ??
		(session?.permission_mode === 'plan'
			? 'Workflow needs ordinary chat mode. Turn Plan off first.'
			: workflowRoleProblem)
	const workflowReady = workflowRolesReady && !workflowProblem

	// Before chats had tabs, drafts used their workspace id. Move one across when
	// that workspace first opens a chat, so an upgrade keeps text the user had typed.
	useEffect(() => {
		if (sessionId) moveDraft(workspaceId, sessionId)
	}, [workspaceId, sessionId, moveDraft])

	// This component survives chat-tab switches. Keep the sync guard pointed at the
	// textarea's current key if the switch happens while it still owns focus.
	useEffect(() => {
		if (document.activeElement === ref.current) setFocusedDraft(draftKey)
		return () => {
			if (useApp.getState().focusedDraft === draftKey) setFocusedDraft(null)
		}
	}, [draftKey, setFocusedDraft])

	const autosize = () => {
		const el = ref.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`
	}

	// Fit a restored — or externally stashed — draft, not just what's being typed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes, however it changed
	useEffect(autosize, [text])

	// A fork has just switched to a blank chat with its context staged. Focus only
	// that explicit request — selecting an ordinary existing chat must not steal focus.
	useEffect(() => {
		if (!focusDraft) return
		const textarea = ref.current
		if (!textarea) return
		textarea.focus({ preventScroll: true })
		textarea.setSelectionRange(textarea.value.length, textarea.value.length)
		onDraftFocused?.()
	}, [focusDraft, onDraftFocused])

	// Ordinary sends hand the only copy to their persisted optimistic bubble and
	// clear immediately. A Workflow start is different: its draft stays authoritative
	// until the dedicated route returns the 202 durable-acceptance receipt.
	const send = (queue = false) => {
		if (
			!hasMessage ||
			uploading ||
			attachmentError ||
			compacting ||
			!sessionId ||
			!online ||
			workflowSendPending ||
			(workflowMode && !workflowReady)
		)
			return
		if (compactChoice) {
			void sendCompacted(queue)
			return
		}
		const startingWorkflow = workflowMode
		void sendPrompt({
			sessionId,
			workspaceId,
			text: prompt,
			queue: startingWorkflow ? false : queue,
			workflow: startingWorkflow
		}).then(accepted => {
			if (accepted && startingWorkflow) {
				// The hook clears the synced draft after the 202, including when this
				// acceptance came from the transcript's persisted Retry control.
				attachmentUploads.clearPending()
			}
		})
		if (!startingWorkflow) {
			clearDraftContent(draftKey)
			attachmentUploads.clearPending()
		}
	}

	const sendCompacted = async (queue: boolean) => {
		if (!onCompact || compactUnavailable) {
			setCompactFailure({ draftKey, message: compactUnavailable ?? 'Compacting is unavailable in this chat' })
			return
		}
		setCompactingKey(draftKey)
		setCompactFailure(null)
		try {
			await onCompact(queue)
			attachmentUploads.clearPending()
		} catch (err) {
			setCompactFailure({ draftKey, message: err instanceof Error ? err.message : 'Could not compact this chat' })
		} finally {
			setCompactingKey(null)
		}
	}

	/**
	 * No optimism: the relay drives Conductor's own Cancel agent and only answers
	 * once `sessions.status` has left `working`, so the button stays busy for the
	 * few seconds that takes rather than clearing a spinner the desktop hasn't
	 * stopped. `alreadyIdle` comes back when the turn ended between the render and
	 * the tap, which is a success — the chat is stopped either way.
	 */
	const stop = async () => {
		if (!sessionId || stopping || !online) return
		setStopping(true)
		setStopError(null)
		try {
			const r = await client.stop(sessionId, workspaceId)
			if (r.ok) {
				clearWorking(sessionId)
				await queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] })
				queryClient.invalidateQueries({ queryKey: ['state'] })
			} else {
				setStopError(r.error || 'Stop failed')
			}
		} catch (e) {
			setStopError(e instanceof Error ? e.message : 'Stop failed')
		} finally {
			setStopping(false)
		}
	}

	const disabled = !sessionId
	const precise = actuator?.precise && actuator.available
	const canStop = working && !!sessionId
	const canSend =
		hasMessage &&
		!uploading &&
		!attachmentError &&
		!workflowSendPending &&
		(!workflowMode || workflowReady) &&
		(!compactChoice || (!!onCompact && !compactUnavailable))
	const coldCache = !working && canSend && session && onCompact ? coldPromptCache(session) : null

	return (
		<div className="pb-safe border-t border-border-soft bg-bg px-3 pt-2">
			{!online ? (
				<div className="mb-2 flex items-center gap-1.5 rounded-lg bg-del/10 px-3 py-1.5 text-xs text-del">
					<WifiOff size={12} />
					Offline — drafts are saved, sending resumes when the relay is back
				</div>
			) : (
				!precise && (
					<div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-faint">
						<Info size={12} />
						{actuator?.caveat || 'Sends to the focused session'}
					</div>
				)
			)}
			{stopError ? (
				<div className="mb-2 rounded-lg border border-del/40 bg-del/10 px-3 py-1.5 text-xs text-del">
					<button type="button" onClick={() => setStopError(null)} className="block w-full text-left">
						{stopError}
					</button>
					{isLockedError(stopError) ? <UnlockLink className="mt-1 inline-block" /> : null}
				</div>
			) : null}
			{compactChoice || preparingCompact ? (
				<div
					className="mb-2 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-soft px-2.5 py-2 text-accent"
					role="status"
				>
					{compacting ? (
						<LoaderCircle size={14} className="shrink-0 animate-spin" />
					) : (
						<Minimize2 size={14} className="shrink-0" />
					)}
					<div className="min-w-0 flex-1">
						<div className="text-xs font-medium">
							{compacting ? 'Compacting and sending…' : 'Will compact before sending'}
						</div>
						<div className="text-[11px] text-muted">{compactDraftLabel(compactChoice ?? DEFAULT_COMPACT)}</div>
						{!compacting && (compactError || compactUnavailable) ? (
							<div className="mt-0.5 text-[11px] text-del" role="alert">
								{compactError || compactUnavailable}
								{isLockedError(compactError || compactUnavailable || '') ? <UnlockLink className="ml-1" /> : null}
							</div>
						) : null}
					</div>
					<button
						type="button"
						aria-label="Cancel compact before sending"
						title="Keep the current context"
						disabled={compacting}
						onClick={() => {
							if (sessionId) setCompactDraft(sessionId, null)
							setCompactFailure(null)
						}}
						className="flex size-8 shrink-0 items-center justify-center rounded-lg active:bg-accent/10 disabled:opacity-50"
					>
						<X size={15} />
					</button>
				</div>
			) : coldCache ? (
				<div className="mb-2 flex items-center gap-2 rounded-xl border border-cold-cache/20 bg-cold-cache/8 px-2.5 py-2 text-cold-cache">
					<Snowflake size={14} className="shrink-0" />
					<div className="min-w-0 flex-1">
						<div className="text-xs font-medium">Prompt cache may be cold</div>
						<div className="text-[11px] text-muted">Idle past its {coldCache.ttlLabel} window</div>
					</div>
					<button
						type="button"
						aria-label="Compact before sending"
						onClick={() => {
							if (sessionId) setCompactDraft(sessionId, DEFAULT_COMPACT)
						}}
						disabled={compacting || !!compactUnavailable || !online}
						title={compactUnavailable ?? 'Use fresh context when you send this message'}
						className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cold-cache/12 px-2.5 text-xs font-semibold transition active:scale-[0.97] active:bg-cold-cache/20 disabled:opacity-50"
					>
						{compacting ? <LoaderCircle size={13} className="animate-spin" /> : <Minimize2 size={13} />}
						Compact
					</button>
				</div>
			) : null}
			{/* `has-[textarea:focus]`, not `focus-within`: the controls inside the card take
			    focus too, and lighting the whole card up on a Plan tap reads as a typo. */}
			<fieldset
				aria-label="Message composer"
				{...attachmentUploads.dropTargetProps}
				className={`m-0 min-w-0 rounded-2xl border border-border bg-surface p-2 has-[textarea:focus]:border-accent/60 ${attachmentUploads.dragging ? 'border-accent bg-accent-soft' : ''}`}
			>
				<AttachmentTray uploads={attachmentUploads} />
				<textarea
					ref={ref}
					rows={1}
					value={text}
					disabled={disabled || compacting}
					placeholder={
						disabled ? 'No active session' : workflowMode ? 'What should the workflow accomplish?' : 'Send a prompt…'
					}
					// text-base is load-bearing: iOS auto-zooms the page when a field under 16px
					// takes focus, and never zooms back out on blur.
					className="block max-h-40 w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-faint disabled:opacity-50"
					onChange={e => setDraft(draftKey, e.target.value)}
					onFocus={() => setFocusedDraft(draftKey)}
					onBlur={() => {
						if (useApp.getState().focusedDraft === draftKey) setFocusedDraft(null)
						requestPrefsFlush()
					}}
					onPaste={attachmentUploads.onPaste}
					// On a touch keyboard Enter breaks the line instead (lib/keys.ts): there is
					// no Shift+Enter on a phone, and the Send button is right there.
					onKeyDown={e => {
						if (enterSubmits(e)) {
							e.preventDefault()
							send(e.metaKey || e.ctrlKey)
						}
					}}
				/>
				<div className="mt-1 flex items-start gap-1">
					{session ? (
						<AgentBar
							session={session}
							workspaceId={workspaceId}
							frozenWorkflow={
								workflow && workflowRole ? { name: workflowRole, role: workflow.roles[workflowRole] } : undefined
							}
							workflow={
								workflowVisible
									? {
											active: workflowMode,
											role: planningRole,
											loading: roles.isLoading,
											problem: workflowProblem,
											onChange: setWorkflowMode
										}
									: undefined
							}
						/>
					) : (
						<span className="flex-1" />
					)}
					{session && onCall ? (
						<button
							type="button"
							onClick={onCall}
							aria-label={callActive ? 'Open active call' : 'Call this chat'}
							aria-haspopup="dialog"
							title={callActive ? 'Open active call' : 'Call with the current chat’s context'}
							className={cn(
								'flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition active:bg-surface-2',
								callActive && 'bg-voice-soft text-voice'
							)}
						>
							<PhoneCall size={16} />
						</button>
					) : null}
					{session && onContext ? <ContextDonutButton session={session} onOpen={onContext} /> : null}
					<AttachmentPickerButton uploads={attachmentUploads} disabled={disabled || compacting || !online} />
					{canStop ? (
						<button
							type="button"
							onClick={stop}
							disabled={stopping || !online}
							aria-label="Stop the agent"
							className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-text transition active:bg-surface-2 disabled:text-faint"
						>
							{stopping ? (
								<span className="size-4 animate-spin rounded-full border-2 border-border border-t-text" />
							) : (
								<Square size={14} fill="currentColor" />
							)}
						</button>
					) : null}
					{/* Send hides while a working chat has nothing to steer with — the same
					    empty-box rule the desktop composer uses, so the two never disagree
					    about what a tap in that corner does. */}
					{canStop && !canSend ? null : (
						<button
							type="button"
							onClick={() => send()}
							disabled={disabled || !canSend || compacting || !online}
							aria-label="Send"
							className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-on-solid transition active:scale-95 disabled:bg-surface-2 disabled:text-faint"
						>
							<ArrowUp size={18} />
						</button>
					)}
				</div>
			</fieldset>
		</div>
	)
}

/** A glanceable context-pressure gauge beside the controls that can add more context. */
export function ContextDonutButton({ session, onOpen }: { session: Session; onOpen: () => void }) {
	const used = session.context_used_percent
	const breakdown = useContextBreakdown(session.id, typeof used === 'number' && used > 0, session.updated_at)
	if (typeof used !== 'number' || used <= 0) return null
	const progress = Math.min(100, Math.max(0, used))
	const shown = Math.round(used)
	const segments = contextRingSegments(progress, breakdown.data)
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Context for ${session.title || 'Untitled'}: ${shown}% used`}
			aria-haspopup="dialog"
			title={`Context: ${shown}% used`}
			className="flex size-8 shrink-0 items-center justify-center rounded-md transition active:bg-surface-2"
		>
			<svg viewBox="0 0 18 18" aria-hidden="true" className="size-[18px] -rotate-90">
				<circle cx="9" cy="9" r="6.5" fill="none" strokeWidth="3" className="stroke-border" />
				{segments.length ? (
					segments.map(segment => (
						<circle
							key={segment.key}
							cx="9"
							cy="9"
							r="6.5"
							fill="none"
							strokeWidth="3"
							pathLength="100"
							strokeDasharray={`${segment.length} ${100 - segment.length}`}
							strokeDashoffset={-segment.offset}
							data-context-segment={segment.key}
							className={segment.ringClass}
						/>
					))
				) : (
					<circle
						cx="9"
						cy="9"
						r="6.5"
						fill="none"
						strokeWidth="3"
						pathLength="100"
						strokeDasharray={`${progress} ${100 - progress}`}
						strokeLinecap="round"
						className={used >= 80 ? 'stroke-working' : 'stroke-accent'}
					/>
				)}
			</svg>
		</button>
	)
}
