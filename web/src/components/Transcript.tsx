import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, Copy, GitFork, Loader2 } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSendPrompt, useTranscript } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { elapsed, messagePreview, messageTime } from '../lib/format.ts'
import { isUnconfirmed, type PendingMessage } from '../lib/pending.ts'
import { latestAssistantForActions } from '../lib/transcript-actions.ts'
import type { PendingPrompt, TranscriptEntry } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { ChatLink, Markdown, sourceReference } from './Markdown.tsx'
import { MessageNav } from './MessageNav.tsx'
import { Patch } from './Patch.tsx'
import { Empty, Spinner } from './ui.tsx'

/** The three useful transcript cuts that `split_chat` exposes through MCP. */
export interface SplitFormat {
	thinking: boolean
	tools: boolean
}

export function Transcript({
	sessionId,
	workspaceId,
	working,
	workingSince,
	queued,
	poll,
	onFork
}: {
	sessionId: string | null
	workspaceId: string
	working?: boolean
	/** Epoch ms the current answer started (see SessionView) — the elapsed timer's origin. */
	workingSince?: number | null
	/** The relay's undelivered first prompt for this workspace (src/firstprompt.ts). */
	queued?: PendingPrompt | null
	/** `false` for an archived chat: it is fetched once, because it has no next message. */
	poll?: boolean
	/** Opens a new chat with a selected cut of this transcript staged as an attachment. */
	onFork?: (format: SplitFormat) => Promise<void>
}) {
	const { entries, loading, error } = useTranscript(sessionId, poll ?? true)
	const pending = useApp(s => s.pending)
	const removePending = useApp(s => s.removePending)
	const sendPrompt = useSendPrompt()
	const queryClient = useQueryClient()
	const scroller = useRef<HTMLDivElement>(null)
	const atBottom = useRef(true)

	// Grouping is pure of `entries`, and `entries` only changes when a row actually
	// lands — so this holds the row list (and each group's slice) at the same identity
	// across the polls above, which is what lets the memoised rows below bail out.
	const rows = useMemo(() => groupSteps(entries), [entries])
	const lastAssistantKey = useMemo(() => {
		const entry = latestAssistantForActions(entries)
		return entry ? rowKey(entry) : null
	}, [entries])

	// The relay owns the entry, so dropping it is a request, not a local edit. A
	// parked prompt (lock screen) belongs to its chat, a first prompt to its workspace.
	const dismiss = async (q: PendingPrompt) => {
		await (q.sessionId ? client.dismissParked(q.sessionId) : client.dismissPrompt(q.workspaceId)).catch(() => undefined)
		queryClient.invalidateQueries({ queryKey: ['state'] })
	}

	// This session's optimistic prompts, hiding any still-unconfirmed one whose text
	// has already arrived as a real user row — the confirmed bubble replaces it.
	const delivered = new Set(entries.filter(e => e.role === 'user').map(e => e.text.trim()))
	const mine = pending.filter(p => p.sessionId === sessionId)
	const visiblePending = mine.filter(p => !(isUnconfirmed(p) && delivered.has(p.text.trim())))

	// The relay keeps the entry until delivery is *confirmed*, and its own send lands as
	// a real user row up to a poll before /api/state drops it — so hide the queued bubble
	// as soon as the text shows up in the chat (or in a bubble of our own), or it doubles.
	const queuedText = queued?.text.trim() || null
	const showQueued =
		queuedText && !delivered.has(queuedText) && !mine.some(p => p.text.trim() === queuedText) ? queued : null

	// Purge confirmed optimistic bubbles from the store once the real row shows (the
	// send hook also purges on a timer; this catches the fast path so nothing lingers).
	// It is also the only thing that retires a bubble restored from storage, whose send
	// resolved while the app wasn't running to hear it (lib/pending.ts).
	useEffect(() => {
		const seen = new Set(entries.filter(e => e.role === 'user').map(e => e.text.trim()))
		for (const p of pending) {
			if (p.sessionId === sessionId && isUnconfirmed(p) && seen.has(p.text.trim())) removePending(p.id)
		}
	}, [entries, pending, sessionId, removePending])

	// Track whether the user is pinned to the bottom before new content lands.
	const onScroll = () => {
		const el = scroller.current
		if (!el) return
		atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: fire on new entries, a new optimistic bubble, or the working indicator toggling to keep the view pinned
	useLayoutEffect(() => {
		const el = scroller.current
		if (el && atBottom.current) el.scrollTop = el.scrollHeight
	}, [entries, visiblePending.length, working])

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll intent when switching sessions
	useEffect(() => {
		atBottom.current = true
	}, [sessionId])

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

	const empty = entries.length === 0 && visiblePending.length === 0 && !showQueued

	return (
		<div className="relative flex min-h-0 min-w-0 flex-1">
			<div ref={scroller} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
				{loading && empty ? (
					<Spinner label="Loading transcript…" />
				) : error && empty ? (
					<Empty>{error}</Empty>
				) : empty && !working ? (
					<Empty>No messages yet.</Empty>
				) : (
					<div className="flex min-w-0 flex-col gap-2.5">
						{rows.map(row =>
							row.kind === 'steps' ? (
								<StepGroup key={row.key} entries={row.entries} />
							) : (
								<Entry
									key={row.key}
									e={row.e}
									showChatActions={row.key === lastAssistantKey}
									onFork={row.key === lastAssistantKey ? onFork : undefined}
								/>
							)
						)}
						{visiblePending.map(p => (
							<PendingEntry
								key={p.id}
								p={p}
								onRetry={() =>
									sendPrompt({
										id: p.id,
										sessionId: p.sessionId,
										workspaceId: p.workspaceId,
										text: p.text,
										queue: p.queue
									})
								}
								onDismiss={() => removePending(p.id)}
							/>
						))}
						{showQueued ? (
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
						{/* The agent can publish a short update, then carry on with tools. Keep its
					    live indicator after every transcript row so activity always reads as the
					    newest item, rather than attaching it to that earlier update. */}
						{working ? <WorkingIndicator since={workingSince} /> : null}
					</div>
				)}
			</div>
			{/* Reads the transcript's own DOM (`data-user-msg`), so it needs no entry list of its own. */}
			<MessageNav scroller={scroller} />
		</div>
	)
}

type Row =
	| { kind: 'entry'; key: string; e: TranscriptEntry }
	| { kind: 'steps'; key: string; entries: TranscriptEntry[] }

const rowKey = (e: TranscriptEntry) => `${e.rowid}-${e.id}`

/** Element-wise identity, for the memoised rows below — a row list is rebuilt, its rows aren't. */
const sameEntries = (a: { entries: TranscriptEntry[] }, b: { entries: TranscriptEntry[] }) =>
	a.entries.length === b.entries.length && a.entries.every((e, i) => e === b.entries[i])

/**
 * Fold each run of the agent's own work (thinking + tool calls) between two
 * spoken messages into one collapsible group — a turn is mostly plumbing, and on
 * a phone that plumbing buries the prose. A run of one stays inline: wrapping a
 * single row in a disclosure hides it without saving anything.
 */
function groupSteps(entries: TranscriptEntry[]): Row[] {
	const rows: Row[] = []
	let run: TranscriptEntry[] = []
	const flush = () => {
		if (run.length > 1) rows.push({ kind: 'steps', key: `steps-${rowKey(run[0])}`, entries: run })
		else for (const e of run) rows.push({ kind: 'entry', key: rowKey(e), e })
		run = []
	}
	for (const e of entries) {
		if (e.role === 'tool' || e.role === 'thinking') {
			run.push(e)
			continue
		}
		flush()
		rows.push({ kind: 'entry', key: rowKey(e), e })
	}
	flush()
	return rows
}

/**
 * The collapsed run of steps. Closed by default, but the header carries the last
 * step's label — which keeps updating while the agent works — so the group reads
 * as live activity without being opened, and any tool failure inside is counted
 * on the header rather than hidden behind it.
 *
 * Memoised on the rows themselves rather than on the array: a new row rebuilds every
 * group's slice, so the default shallow compare would re-render the whole backlog
 * each time the live group grows by one step.
 */
const StepGroup = memo(function StepGroup({ entries }: { entries: TranscriptEntry[] }) {
	const failed = entries.filter(e => e.error).length
	const last = entries[entries.length - 1]
	const lastLabel = last.role === 'thinking' ? 'Thinking' : last.text
	return (
		<details className="group/steps min-w-0 overflow-hidden rounded-xl border border-border-soft bg-surface/40">
			<summary className="flex cursor-pointer select-none list-none items-baseline gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 font-mono text-[11px] text-faint transition-transform group-open/steps:rotate-90">
					▸
				</span>
				<span className="shrink-0 text-[12.5px] text-muted">{entries.length} steps</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-faint group-open/steps:invisible">{lastLabel}</span>
				{failed ? <span className="shrink-0 text-[11px] text-del">{failed} failed</span> : null}
			</summary>
			<div className="flex min-w-0 flex-col gap-2.5 border-t border-border-soft px-2 py-2.5">
				{entries.map(e => (
					<Entry key={rowKey(e)} e={e} />
				))}
			</div>
		</details>
	)
}, sameEntries)

/**
 * A prompt still with the relay: the workspace's first prompt waiting on setup, or
 * one parked for the lock screen (`reason` says which). Not a `PendingMessage` —
 * it outlives this app being open, and delivery belongs to the relay.
 *
 * `failed` is the relay saying it gave up, so the text is offered back rather than
 * lost: Retry sends it as an ordinary prompt (which also clears the entry), Dismiss
 * drops it. A first prompt is still pre-filled in Conductor's composer either way.
 */
function QueuedEntry({
	queued,
	onRetry,
	onDismiss
}: {
	queued: PendingPrompt
	onRetry?: () => void
	onDismiss: () => void
}) {
	const failed = queued.status === 'failed'
	// A parked entry names its chat, a first prompt carries no `sessionId` (src/wire.ts) — and only
	// the parked one is held by the lock screen, only for as long as it hasn't given up.
	const unlock = !failed && queued.sessionId ? unlockUrl() : null
	return (
		<div className="flex flex-col items-end gap-1" data-user-msg={messagePreview(queued.text)} data-msg-state="queued">
			<Bubble className={cn('max-w-[85%] bg-accent-soft text-text opacity-60', failed && 'border border-del/40')}>
				<Markdown>{queued.text}</Markdown>
			</Bubble>
			{failed ? (
				<div className="flex items-center gap-2 pr-1 text-[11px] text-del">
					<AlertTriangle size={11} className="shrink-0" />
					<span className="max-w-[55vw] truncate">{queued.error || 'Didn’t send'}</span>
					{onRetry ? (
						<button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
							Retry
						</button>
					) : null}
					<button type="button" onClick={onDismiss} className="text-faint underline underline-offset-2">
						Dismiss
					</button>
				</div>
			) : (
				<span className="flex items-center gap-1 pr-1 text-[11px] text-faint">
					<Loader2 size={11} className="animate-spin" />
					{queued.reason ?? 'The relay is sending this'}
					{unlock ? (
						<a href={unlock} className="ml-1 font-semibold text-accent underline underline-offset-2">
							Unlock the Mac
						</a>
					) : null}
				</span>
			)}
		</div>
	)
}

/**
 * Screen Sharing on the relay's Mac, addressed the way this phone already reaches it: the PWA is
 * served from that Mac's own MagicDNS name, so `location.hostname` is the host to unlock and no
 * relay round trip is needed to learn it. `vnc://` is the scheme the iOS clients register (Screens,
 * RealVNC, Jump), and it is the only remote path there is: macOS exposes no unlock API, the lock
 * screen refuses synthetic keystrokes, and Apple's own Screen Sharing server is the one input
 * channel it still accepts. So the button carries you to the password prompt; it doesn't answer it.
 * Loopback returns null because a dev checkout serves this same UI from 127.0.0.1.
 */
function unlockUrl(): string | null {
	const host = location.hostname
	if (!host || host === 'localhost' || host.startsWith('127.')) return null
	return `vnc://${host}`
}

/** An optimistic user prompt: greyed while `sending`, or a red bubble with Retry/Dismiss on failure. */
function PendingEntry({ p, onRetry, onDismiss }: { p: PendingMessage; onRetry: () => void; onDismiss: () => void }) {
	if (p.status === 'error') {
		return (
			<div className="flex flex-col items-end gap-1" data-user-msg={messagePreview(p.text)} data-msg-state="failed">
				<Bubble className="max-w-[85%] border border-del/40 bg-accent-soft text-text">
					<Markdown>{p.text}</Markdown>
				</Bubble>
				<div className="flex items-center gap-2 pr-1 text-[11px] text-del">
					<AlertTriangle size={11} className="shrink-0" />
					<span className="max-w-[55vw] truncate">{p.error || 'Didn’t send'}</span>
					<button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
						Retry
					</button>
					<button type="button" onClick={onDismiss} className="text-faint underline underline-offset-2">
						Dismiss
					</button>
				</div>
			</div>
		)
	}
	return (
		<div className="flex flex-col items-end gap-1" data-user-msg={messagePreview(p.text)} data-msg-state="sending">
			<Bubble className="max-w-[85%] bg-accent-soft text-text opacity-60">
				<Markdown>{p.text}</Markdown>
			</Bubble>
			<span className="flex items-center gap-1 pr-1 text-[11px] text-faint">
				<Loader2 size={11} className="animate-spin" />
				Sending…
			</span>
		</div>
	)
}

/** One transcript row. Memoised on the entry, which the poll appends to rather than rebuilds. */
const Entry = memo(function Entry({
	e,
	showChatActions = false,
	onFork
}: {
	e: TranscriptEntry
	showChatActions?: boolean
	onFork?: (format: SplitFormat) => Promise<void>
}) {
	if (e.role === 'user') {
		// `data-user-msg` is what MessageNav reads: the entry's position is this node's, and
		// the attributes are the row it draws in the sheet. Every user-side bubble carries
		// one — an optimistic send and the relay's queued prompt are your messages too, and
		// they're exactly the ones you scroll back to check on.
		return (
			<div className="flex flex-col items-end gap-0.5" data-user-msg={messagePreview(e.text)} data-msg-ts={e.ts}>
				<Bubble className={cn('max-w-[85%] bg-accent-soft text-text', e.queued && 'opacity-60')}>
					{e.queued ? <Label>queued</Label> : null}
					<Markdown>{e.text}</Markdown>
				</Bubble>
				<span className="pr-1 text-[11px] text-faint">{messageTime(e.ts)}</span>
			</div>
		)
	}
	if (e.role === 'tool') return <ToolEntry e={e} />
	if (e.role === 'thinking') {
		// Named group: a plain `group` would also answer to the enclosing StepGroup's open state.
		return (
			<details className="group/think px-1">
				<summary className="cursor-pointer select-none list-none text-[11px] font-semibold uppercase tracking-wide text-faint [&::-webkit-details-marker]:hidden">
					<span className="mr-1 inline-block transition-transform group-open/think:rotate-90">▸</span>
					Thinking
				</summary>
				<div className="mt-1 border-l-2 border-border-soft pl-3 text-[13px] italic leading-relaxed text-muted">
					<Markdown>{e.text}</Markdown>
				</div>
			</details>
		)
	}
	if (e.role === 'system') {
		return <div className="px-2 text-center text-[11px] text-faint">{e.text}</div>
	}
	// assistant
	return (
		<div className="flex flex-col items-start">
			{/* No fill on the agent's side — it's the bulk of the transcript, so the user's
		    tinted bubbles read as the reply and this reads as the page. Padding drops with
		    the background or the text would sit inset from everything around it. */}
			<Bubble className="max-w-[92%] px-0.5">
				<Markdown>{e.text}</Markdown>
			</Bubble>
			{showChatActions ? <ChatActions text={e.text} onFork={onFork} /> : null}
		</div>
	)
})

/** Copy the latest response, or branch the whole chat from a transcript attachment. */
function ChatActions({ text, onFork }: { text: string; onFork?: (format: SplitFormat) => Promise<void> }) {
	const [copied, setCopied] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const [forking, setForking] = useState(false)
	const [forkError, setForkError] = useState<string | null>(null)

	const copy = async () => {
		try {
			await copyText(text)
			setCopied(true)
			window.setTimeout(() => setCopied(false), 1800)
		} catch {
			setCopied(false)
		}
	}

	const fork = async (format: SplitFormat) => {
		if (!onFork || forking) return
		setForking(true)
		setForkError(null)
		setMenuOpen(false)
		try {
			await onFork(format)
		} catch (err) {
			setForkError(err instanceof Error ? err.message : 'Could not fork this chat')
		} finally {
			setForking(false)
		}
	}

	return (
		<div className="mt-1.5 flex max-w-full flex-col items-start gap-1">
			<div className="flex items-center gap-3">
				<div className="relative">
					<div className="flex items-center overflow-hidden rounded-lg border border-border-soft bg-surface/70 text-muted">
						<button
							type="button"
							onClick={() => void copy()}
							aria-label={copied ? 'Copied response' : 'Copy response'}
							className="flex size-7 items-center justify-center transition active:bg-surface-2"
						>
							{copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
						</button>
						{onFork ? (
							<>
								<span className="h-4 w-px bg-border-soft" aria-hidden />
								<button
									type="button"
									onClick={() => void fork({ thinking: true, tools: false })}
									disabled={forking}
									aria-label="Fork chat with reasoning"
									className="flex h-7 items-center gap-1 px-2 text-[11px] font-medium transition active:bg-surface-2 disabled:opacity-50"
								>
									{forking ? <Loader2 size={13} className="animate-spin" /> : <GitFork size={13} />}
									Fork
								</button>
								<button
									type="button"
									onClick={() => setMenuOpen(open => !open)}
									disabled={forking}
									aria-label="Choose fork transcript type"
									aria-haspopup="menu"
									aria-expanded={menuOpen}
									className="flex size-7 items-center justify-center border-l border-border-soft transition active:bg-surface-2 disabled:opacity-50"
								>
									<ChevronDown size={14} className={cn('transition-transform', menuOpen && 'rotate-180')} />
								</button>
							</>
						) : null}
					</div>
					{menuOpen ? (
						<>
							<div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden />
							<div
								role="menu"
								aria-label="Fork transcript type"
								className="absolute bottom-full left-0 z-30 mb-1 w-60 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
							>
								<ForkOption
									label="Concise"
									detail="Messages only"
									onClick={() => void fork({ thinking: false, tools: false })}
								/>
								<ForkOption
									label="With reasoning"
									detail="Messages and reasoning"
									onClick={() => void fork({ thinking: true, tools: false })}
								/>
								<ForkOption
									label="Full transcript"
									detail="Messages, reasoning, and tools"
									onClick={() => void fork({ thinking: true, tools: true })}
								/>
							</div>
						</>
					) : null}
				</div>
			</div>
			{forkError ? <span className="max-w-[85vw] text-[11px] text-del">{forkError}</span> : null}
		</div>
	)
}

function ForkOption({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className="flex w-full flex-col px-3 py-2 text-left active:bg-surface-2"
		>
			<span className="text-[12px] font-medium text-text">{label}</span>
			<span className="text-[11px] text-faint">{detail}</span>
		</button>
	)
}

/** Clipboard's async API is unavailable in a few embedded browsers, so keep a small fallback. */
async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
	const input = document.createElement('textarea')
	input.value = text
	input.setAttribute('readonly', '')
	input.style.cssText = 'position:fixed;opacity:0'
	document.body.append(input)
	input.select()
	const copied = document.execCommand('copy')
	input.remove()
	if (!copied) throw new Error('Clipboard unavailable')
}

/**
 * The classic three-dot "typing" bubble, shown under the last message while the agent
 * works — with how long the current answer has been running beside it. `since` is the
 * turn's dispatch time, so steering the agent mid-answer keeps the clock running and
 * only a fresh prompt starts it over (see `turn_started_at` in src/reads.ts).
 */
function WorkingIndicator({ since }: { since?: number | null }) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!since) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [since])
	return (
		<div className="fade-in flex items-center justify-start gap-2">
			<div className="flex items-center gap-1 px-0.5 py-3">
				<span className="typing-dot" />
				<span className="typing-dot" />
				<span className="typing-dot" />
			</div>
			{since ? <span className="text-[11px] tabular-nums text-faint">{elapsed(now - since)}</span> : null}
		</div>
	)
}

/**
 * One tool step: what ran, and what came back.
 *
 * Closed it is a single line, which is what a run of forty of them has to stay. Open it
 * carries the call's input and the result the relay paired with it — plain text, a
 * coloured diff for an edit, and any images the tool returned. The images are the reason
 * this holds open state rather than leaving `<details>` to itself: their bytes are a
 * request each (`client.toolImage`), and a closed step must not make it.
 */
const ToolEntry = memo(function ToolEntry({ e }: { e: TranscriptEntry }) {
	const [open, setOpen] = useState(false)

	// A failure with no call to sit on: the relay never paired it (lib/transcript-merge.ts),
	// so it stands alone as the step that failed rather than disappearing.
	if (e.error && !e.tool) {
		return (
			<div className="overflow-hidden rounded-xl border border-del/30 bg-del/5 px-3 py-2">
				<Mono text={e.text} className="line-clamp-4 text-del/80" />
			</div>
		)
	}
	const source = sourceReference(e.detail)
	const images = e.images ?? []
	// Nothing to open: no input worth a second line, and no output yet — a call still
	// running has none. A disclosure that reveals nothing is worse than a plain row.
	if (!e.detail && !e.output && !images.length) {
		return (
			<div className="flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap rounded-xl border border-border-soft bg-surface/60 px-3 py-1.5">
				<span className="shrink-0 font-mono text-[11px] text-faint">·</span>
				<span className="max-w-full truncate text-[12.5px] text-muted">{e.text}</span>
			</div>
		)
	}
	return (
		<details
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
			className={cn(
				'group/tool min-w-0 overflow-hidden rounded-xl border',
				e.error ? 'border-del/30 bg-del/5' : 'border-border-soft bg-surface/60'
			)}
		>
			<summary className="flex cursor-pointer select-none list-none items-baseline gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 font-mono text-[11px] text-faint transition-transform group-open/tool:rotate-90">
					▸
				</span>
				<span className="max-w-full truncate text-[12.5px] text-muted">{e.text}</span>
				{e.detail ? (
					source ? (
						<ChatLink
							href={source}
							title={`Open ${e.detail}`}
							onClick={event => event.stopPropagation()}
							className="min-w-0 flex-1 truncate font-mono text-[11px] text-accent underline underline-offset-2 group-open/tool:invisible"
						>
							{e.detail}
						</ChatLink>
					) : (
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint group-open/tool:invisible">
							{e.detail}
						</span>
					)
				) : null}
				{e.error ? <span className="ml-auto shrink-0 text-[11px] text-del">failed</span> : null}
			</summary>
			<div className="flex min-w-0 flex-col gap-2 border-t border-border-soft px-3 py-2">
				{e.detail ? (
					source ? (
						<ChatLink
							href={source}
							title={`Open ${e.detail}`}
							className="block whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
						>
							{e.detail}
						</ChatLink>
					) : (
						<Mono text={e.detail} className="text-muted" />
					)
				) : null}
				{e.output ? (
					<div className={cn('min-w-0', e.detail && 'border-t border-border-soft pt-2')}>
						<Label>{e.error ? 'error' : e.diff ? 'changes' : 'output'}</Label>
						{e.diff ? (
							<Patch patch={e.output} />
						) : (
							<Mono text={e.output} className={e.error ? 'text-del/80' : 'text-muted'} />
						)}
					</div>
				) : null}
				{open && images.length ? (
					<div
						className={cn('flex min-w-0 flex-col gap-2', (e.detail || e.output) && 'border-t border-border-soft pt-2')}
					>
						<Label>{plural(images.length, 'image')}</Label>
						{images.map(reference => (
							<ToolImage key={reference} reference={reference} />
						))}
					</div>
				) : null}
			</div>
		</details>
	)
})

/** Shared by every mono block in a tool row: the call's input, its output, an error. */
const MONO = 'whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]'

/** Output as it was printed. `text` stays inline, or <pre> would render this file's indentation. */
function Mono({ text, className }: { text: string; className?: string }) {
	return <pre className={cn(MONO, className)}>{text}</pre>
}

/** A tool's image, pulled through the relay so the token stays in the header, not the URL. */
function ToolImage({ reference }: { reference: string }) {
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let disposed = false
		client
			.toolImage(reference)
			.then(objectUrl => !disposed && setUrl(objectUrl))
			.catch(() => !disposed && setFailed(true))
		return () => {
			disposed = true
		}
	}, [reference])

	if (failed) return <span className="text-[11px] text-faint">Image unavailable.</span>
	if (!url) return <Spinner label="Loading image…" />
	return <img src={url} alt="Tool output" className="max-w-full rounded-lg border border-border-soft" />
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function Bubble({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				'min-w-0 rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed [overflow-wrap:anywhere]',
				className
			)}
		>
			{children}
		</div>
	)
}

function Label({ children }: { children: string }) {
	return <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">{children}</div>
}
