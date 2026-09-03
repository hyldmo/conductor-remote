import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, GitFork, Info, LoaderCircle, Paperclip, Snowflake, Square, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSendPrompt } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { enterSubmits } from '../lib/keys.ts'
import { isLockedError } from '../lib/lock.ts'
import { requestPrefsFlush } from '../lib/prefs.ts'
import { coldPromptCache } from '../lib/prompt-cache.ts'
import type { ActuatorInfo, DraftAttachment, Session } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { AgentBar } from './AgentBar.tsx'
import { UnlockLink } from './ui.tsx'

type PendingAttachment = {
	id: string
	sessionId: string
	name: string
	status: 'uploading' | 'error'
	error?: string
}

type DisplayAttachment = (DraftAttachment & { id: string; status: 'ready'; error?: never }) | PendingAttachment

const NO_ATTACHMENTS: DraftAttachment[] = []

/**
 * The draft lives in the store (persisted per chat — see lib/draft.ts), not in
 * local state. A fork stages its transcript attachment in the new chat before
 * this component mounts, so the box has to show it without waiting for a remount.
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
	onFork,
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
	/** Fork this full chat and keep the composed prompt in the new chat's draft. */
	onFork?: (prompt: string) => Promise<void>
	/** A newly forked chat asks to continue from the end of its staged handoff. */
	focusDraft?: boolean
	onDraftFocused?: () => void
}) {
	const draftKey = sessionId ?? workspaceId
	const text = useApp(s => s.drafts[draftKey] ?? '')
	const readyAttachments = useApp(s => s.draftAttachments[draftKey] ?? NO_ATTACHMENTS)
	const setDraft = useApp(s => s.setDraft)
	const addDraftAttachment = useApp(s => s.addDraftAttachment)
	const removeDraftAttachment = useApp(s => s.removeDraftAttachment)
	const clearDraftContent = useApp(s => s.clearDraftContent)
	const moveDraft = useApp(s => s.moveDraft)
	const setFocusedDraft = useApp(s => s.setFocusedDraft)
	const online = useApp(s => s.online)
	const clearWorking = useApp(s => s.clearWorking)
	const sendPrompt = useSendPrompt()
	const queryClient = useQueryClient()
	const [stopping, setStopping] = useState(false)
	const [stopError, setStopError] = useState<string | null>(null)
	const [forking, setForking] = useState(false)
	const [forkError, setForkError] = useState<string | null>(null)
	const ref = useRef<HTMLTextAreaElement>(null)
	const fileInput = useRef<HTMLInputElement>(null)
	const cancelledUploads = useRef(new Set<string>())
	const dragDepth = useRef(0)
	const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
	const [draggingFiles, setDraggingFiles] = useState(false)
	const activePendingAttachments = pendingAttachments.filter(attachment => attachment.sessionId === sessionId)
	const activeAttachments: DisplayAttachment[] = [
		...readyAttachments.map(attachment => ({ ...attachment, id: attachment.path, status: 'ready' as const })),
		...activePendingAttachments
	]
	const uploading = activePendingAttachments.some(attachment => attachment.status === 'uploading')
	const prompt = [...readyAttachments.map(attachment => attachment.token), text.trim()].filter(Boolean).join('\n')

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

	// A fork has just switched to a blank chat with its handoff in the draft. Focus only
	// that explicit request — selecting an ordinary existing chat must not steal focus.
	useEffect(() => {
		if (!focusDraft) return
		const textarea = ref.current
		if (!textarea) return
		textarea.focus({ preventScroll: true })
		textarea.setSelectionRange(textarea.value.length, textarea.value.length)
		onDraftFocused?.()
	}, [focusDraft, onDraftFocused])

	// Fire-and-forget: the optimistic bubble (and its inline error on failure) is the
	// feedback now, so we clear the box immediately instead of awaiting the send.
	const send = (queue = false) => {
		if (!prompt || uploading || forking || !sessionId || !online) return
		void sendPrompt({ sessionId, workspaceId, text: prompt, queue })
		clearDraftContent(draftKey)
		setPendingAttachments(current => current.filter(attachment => attachment.sessionId !== sessionId))
	}

	const forkDraft = async () => {
		if (!(onFork && prompt) || uploading || forking || !online) return
		setForking(true)
		setForkError(null)
		try {
			await onFork(prompt)
			clearDraftContent(draftKey)
			setPendingAttachments(current => current.filter(attachment => attachment.sessionId !== sessionId))
		} catch (err) {
			setForkError(err instanceof Error ? err.message : 'Could not fork this chat')
		} finally {
			setForking(false)
		}
	}

	const removeAttachment = (id: string) => {
		if (readyAttachments.some(attachment => attachment.path === id)) {
			removeDraftAttachment(draftKey, id)
			return
		}
		cancelledUploads.current.add(id)
		setPendingAttachments(current => current.filter(attachment => attachment.id !== id))
	}

	const addFiles = async (picked: FileList | File[]) => {
		if (!sessionId || !online) return
		for (const file of Array.from(picked)) {
			const id = crypto.randomUUID()
			setPendingAttachments(current => [
				...current,
				{
					id,
					sessionId,
					name: file.name || 'attachment',
					status: 'uploading'
				}
			])
			try {
				const uploaded = await client.uploadAttachment(sessionId, workspaceId, file)
				if (cancelledUploads.current.delete(id)) continue
				addDraftAttachment(sessionId, uploaded.attachment)
				setPendingAttachments(current => current.filter(attachment => attachment.id !== id))
			} catch (err) {
				if (cancelledUploads.current.delete(id)) continue
				setPendingAttachments(current =>
					current.map(attachment =>
						attachment.id === id
							? { ...attachment, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
							: attachment
					)
				)
			}
		}
	}

	const chooseFiles = (files: FileList | null) => {
		if (files?.length) void addFiles(files)
	}

	const isFileDrag = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes('Files')

	const dragEnter = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		dragDepth.current += 1
		setDraggingFiles(true)
	}

	const dragLeave = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		dragDepth.current -= 1
		if (dragDepth.current <= 0) {
			dragDepth.current = 0
			setDraggingFiles(false)
		}
	}

	const dragOver = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		event.dataTransfer.dropEffect = 'copy'
	}

	const drop = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		dragDepth.current = 0
		setDraggingFiles(false)
		chooseFiles(event.dataTransfer.files)
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
	const canSend = (!!text.trim() || readyAttachments.length > 0) && !uploading
	const coldCache = !working && canSend && session && onFork ? coldPromptCache(session) : null

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
			{coldCache ? (
				<div className="mb-2 flex items-center gap-2 rounded-xl border border-cold-cache/20 bg-cold-cache/8 px-2.5 py-2 text-cold-cache">
					<Snowflake size={14} className="shrink-0" />
					<div className="min-w-0 flex-1">
						<div className="text-xs font-medium">Prompt cache may be cold</div>
						<div className="text-[11px] text-muted">Idle past its {coldCache.ttlLabel} window</div>
						{forkError ? (
							<div className="mt-0.5 text-[11px] text-del" role="alert">
								{forkError}
								{isLockedError(forkError) ? <UnlockLink className="ml-1" /> : null}
							</div>
						) : null}
					</div>
					<button
						type="button"
						onClick={() => void forkDraft()}
						disabled={forking || !online}
						title="Start a fresh chat with this transcript attached and keep the draft"
						className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cold-cache/12 px-2.5 text-xs font-semibold transition active:scale-[0.97] active:bg-cold-cache/20 disabled:opacity-50"
					>
						{forking ? <LoaderCircle size={13} className="animate-spin" /> : <GitFork size={13} />}
						Fork draft
					</button>
				</div>
			) : null}
			{/* `has-[textarea:focus]`, not `focus-within`: the controls inside the card take
			    focus too, and lighting the whole card up on a Plan tap reads as a typo. */}
			<fieldset
				aria-label="Message composer"
				onDragEnter={dragEnter}
				onDragLeave={dragLeave}
				onDragOver={dragOver}
				onDrop={drop}
				className={`m-0 min-w-0 rounded-2xl border border-border bg-surface p-2 has-[textarea:focus]:border-accent/60 ${draggingFiles ? 'border-accent bg-accent-soft' : ''}`}
			>
				<input
					ref={fileInput}
					type="file"
					multiple
					className="hidden"
					onChange={event => {
						chooseFiles(event.target.files)
						event.target.value = ''
					}}
				/>
				{activeAttachments.length ? (
					<div className="flex flex-wrap gap-1 px-2 pb-1">
						{activeAttachments.map(attachment => (
							<div
								key={attachment.id}
								title={attachment.error ?? attachment.name}
								className="flex max-w-full items-center gap-1 rounded-lg bg-surface-2 py-1 pl-2 pr-1 text-xs text-muted"
							>
								{attachment.status === 'uploading' ? (
									<LoaderCircle size={12} className="shrink-0 animate-spin" />
								) : null}
								<span className="truncate">
									{attachment.status === 'error' ? `${attachment.name}: ${attachment.error}` : attachment.name}
								</span>
								<button
									type="button"
									onClick={() => removeAttachment(attachment.id)}
									aria-label={`Remove ${attachment.name}`}
									className="flex size-5 shrink-0 items-center justify-center rounded active:bg-surface"
								>
									<X size={13} />
								</button>
							</div>
						))}
					</div>
				) : null}
				{draggingFiles ? (
					<div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border border-dashed border-accent bg-accent-soft/90 text-sm font-medium text-accent">
						Drop files to attach
					</div>
				) : null}
				<textarea
					ref={ref}
					rows={1}
					value={text}
					disabled={disabled || forking}
					placeholder={disabled ? 'No active session' : 'Send a prompt…'}
					// text-base is load-bearing: iOS auto-zooms the page when a field under 16px
					// takes focus, and never zooms back out on blur.
					className="block max-h-40 w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-faint disabled:opacity-50"
					onChange={e => setDraft(draftKey, e.target.value)}
					onFocus={() => setFocusedDraft(draftKey)}
					onBlur={() => {
						if (useApp.getState().focusedDraft === draftKey) setFocusedDraft(null)
						requestPrefsFlush()
					}}
					onPaste={event => {
						const files = event.clipboardData.files
						if (!files.length) return
						event.preventDefault()
						chooseFiles(files)
					}}
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
					{session ? <AgentBar session={session} workspaceId={workspaceId} /> : <span className="flex-1" />}
					<button
						type="button"
						onClick={() => fileInput.current?.click()}
						disabled={disabled || forking || !online}
						aria-label="Attach files"
						className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition active:bg-surface-2 active:text-text disabled:text-faint"
					>
						<Paperclip size={17} />
					</button>
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
							disabled={disabled || !canSend || forking || !online}
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
