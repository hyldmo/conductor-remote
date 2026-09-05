import { Waypoints } from 'lucide-react'
import { memo } from 'react'
import { cn } from '../../lib/cn.ts'
import { messagePreview, messageTime } from '../../lib/format.ts'
import type { PendingMessage } from '../../lib/prompts/pending.ts'
import type { TranscriptNode } from '../../lib/transcript/tree.ts'
import type { PendingPrompt, TranscriptEntry } from '../../lib/types.ts'
import { UnlockLink } from '../ui.tsx'
import { Bubble, Label } from './Bubble.tsx'
import { rowKey } from './grouping.ts'
import { Markdown } from './Markdown.tsx'
import { QueueBubble } from './QueueBubble.tsx'
import { ToolEntry } from './ToolEntry.tsx'

/** Element-wise identity, for the memoised rows below — a row list is rebuilt, its rows aren't. */
const sameNodes = (a: { nodes: TranscriptNode[] }, b: { nodes: TranscriptNode[] }) =>
	a.nodes.length === b.nodes.length && a.nodes.every((node, i) => node.e === b.nodes[i]?.e)

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
export const StepGroup = memo(function StepGroup({ nodes }: { nodes: TranscriptNode[] }) {
	const failed = nodes.filter(node => node.e.error).length
	const last = nodes[nodes.length - 1].e
	const lastLabel = last.role === 'thinking' ? 'Thinking' : last.text
	return (
		<details className="group/steps min-w-0 overflow-hidden rounded-xl border border-border-soft bg-surface/40">
			<summary className="flex cursor-pointer select-none list-none items-baseline gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 font-mono text-[11px] text-faint transition-transform group-open/steps:rotate-90">
					▸
				</span>
				<span className="shrink-0 text-[12.5px] text-muted">{nodes.length} steps</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-faint group-open/steps:invisible">{lastLabel}</span>
				{failed ? <span className="shrink-0 text-[11px] text-del">{failed} failed</span> : null}
			</summary>
			<div className="flex min-w-0 flex-col gap-2.5 border-t border-border-soft px-2 py-2.5">
				{nodes.map(node => (
					<NodeEntry key={rowKey(node.e)} node={node} />
				))}
			</div>
		</details>
	)
}, sameNodes)

/** Render a node as either an ordinary transcript row or a doorway to its agent subtab. */
export function NodeEntry({
	node,
	onSelectSubagent
}: {
	node: TranscriptNode
	onSelectSubagent?: (toolUseId: string | null) => void
}) {
	const toolUseId = node.e.toolUseId
	return node.e.subagentLabel ? (
		<SubagentEntry node={node} onOpen={toolUseId && onSelectSubagent ? () => onSelectSubagent(toolUseId) : undefined} />
	) : (
		<Entry e={node.e} />
	)
}

/**
 * The spawning call remains in its parent's chronology, but its potentially enormous
 * child transcript lives behind the matching subtab above. This is the native-agent
 * equivalent of a workflow's delegation bubble: enough context to explain what the
 * parent did, without rendering the same child work in two places.
 *
 * Child frames may have been interleaved with parent messages in SQLite. `transcriptTree`
 * has already pulled them out of the parent view by durable id, so the parent can keep
 * speaking below this row without impersonating the subagent.
 */
export function SubagentEntry({ node, onOpen }: { node: TranscriptNode; onOpen?: () => void }) {
	const { e } = node
	const contents = (
		<>
			<Waypoints size={14} strokeWidth={1.7} className="shrink-0 text-faint" aria-hidden />
			<span className="shrink-0 font-medium text-text">Agent</span>
			<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{e.subagentLabel}</span>
			{e.error ? <span className="shrink-0 text-[11px] text-del">failed</span> : null}
			{onOpen ? <span className="shrink-0 text-[11px] text-faint">Open</span> : null}
		</>
	)
	return (
		<section className="min-w-0 px-0.5" data-subagent={e.subagentLabel}>
			{onOpen ? (
				<button
					type="button"
					onClick={onOpen}
					aria-label={`Open agent ${e.subagentLabel}`}
					className="flex w-full min-w-0 items-center gap-2 rounded-lg py-1 text-left text-[12.5px] transition active:bg-surface-2"
				>
					{contents}
				</button>
			) : (
				<div className="flex min-w-0 items-center gap-2 py-1 text-[12.5px]">{contents}</div>
			)}
		</section>
	)
}

/** Claude returns a synchronous Agent/Task report on the call; Codex's output is transport bookkeeping. */
export function subagentFinal(node: TranscriptNode): string | null {
	const { e } = node
	return e.output && (e.error || e.tool === 'Agent' || e.tool === 'Task') ? e.output : null
}

/** A synchronous child's final report, rendered only inside its selected virtual transcript. */
export function SubagentResult({ text, failed }: { text: string; failed?: boolean }) {
	return (
		<div className="flex flex-col items-start" data-subagent-result>
			<Bubble className={cn('max-w-[92%] px-0.5', failed && 'text-del/80')}>
				<Markdown>{text}</Markdown>
			</Bubble>
		</div>
	)
}

/**
 * A prompt still with the relay: the workspace's first prompt waiting on setup, or
 * one parked for the lock screen (`reason` says which). Not a `PendingMessage` —
 * it outlives this app being open, and delivery belongs to the relay.
 *
 * `failed` is the relay saying it gave up, so the text is offered back rather than
 * lost: Retry sends it as an ordinary prompt (which also clears the entry), Dismiss
 * drops it. A first prompt is still pre-filled in Conductor's composer either way.
 */
export function QueuedEntry({
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
	const unlock = !failed && !!queued.sessionId
	return (
		<QueueBubble
			state={failed ? 'failed' : 'pending'}
			meta={
				failed ? (
					queued.error || 'Didn’t send'
				) : (
					<>
						{queued.reason ?? 'The relay is sending this'}
						{unlock ? <UnlockLink className="ml-1" /> : null}
					</>
				)
			}
			actions={
				failed
					? [
							...(onRetry ? [{ label: 'Retry', onClick: onRetry, primary: true }] : []),
							{ label: 'Dismiss prompt', onClick: onDismiss }
						]
					: []
			}
			dataUserMessage={messagePreview(queued.text)}
			dataMessageState="queued"
		>
			<div>
				<Markdown>{queued.text}</Markdown>
			</div>
		</QueueBubble>
	)
}

/** An optimistic user prompt: greyed while `sending`, or a red bubble with Retry/Dismiss on failure. */
export function PendingEntry({
	p,
	onRetry,
	onDismiss
}: {
	p: PendingMessage
	onRetry: () => void
	onDismiss: () => void
}) {
	const failed = p.status === 'error'
	return (
		<QueueBubble
			state={failed ? 'failed' : 'pending'}
			meta={failed ? p.error || 'Didn’t send' : 'Sending…'}
			actions={
				failed
					? [
							{ label: 'Retry', onClick: onRetry, primary: true },
							{ label: 'Dismiss message', onClick: onDismiss }
						]
					: []
			}
			dataUserMessage={messagePreview(p.text)}
			dataMessageState={failed ? 'failed' : 'sending'}
		>
			<div>
				<Markdown>{p.text}</Markdown>
			</div>
		</QueueBubble>
	)
}

/** One transcript row. Memoised on the entry, which the poll appends to rather than rebuilds. */
const Entry = memo(function Entry({ e }: { e: TranscriptEntry }) {
	if (e.role === 'user') {
		// `data-user-msg` is what MessageNav reads: the entry's position is this node's, and
		// the attributes are the row it draws in the sheet. Every user-side bubble carries
		// one — an optimistic send and the relay's queued prompt are your messages too, and
		// they're exactly the ones you scroll back to check on.
		return (
			<div
				className="flex flex-col items-end gap-0.5"
				data-user-msg={messagePreview(e.text)}
				data-msg-ts={e.ts}
				data-msg-state={e.queued ? 'queued' : undefined}
			>
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
		</div>
	)
})
