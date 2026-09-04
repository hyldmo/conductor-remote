import { LoaderCircle, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useContextBreakdown } from '../hooks.ts'
import { CONTEXT_CATEGORY_META } from '../lib/context.ts'
import { formatContextShare, formatContextTokens } from '../lib/format.ts'
import type { ContextBreakdownResponse } from '../lib/types.ts'

interface ForkLayer {
	key: 'chat' | 'thinking' | 'tools'
	tokens: number
	color: string
}

function forkLayers(total: number, concise: number, reasoning: number): ForkLayer[] {
	let remaining = total
	const chat = Math.min(remaining, concise)
	remaining -= chat
	const thinking = Math.min(remaining, Math.max(0, reasoning - concise))
	remaining -= thinking
	return [
		{ key: 'chat', tokens: chat, color: 'bg-context-chat' },
		{ key: 'thinking', tokens: thinking, color: 'bg-working' },
		{ key: 'tools', tokens: remaining, color: 'bg-context-tools' }
	]
}

function ForkPayloadBar({ label, layers, scale }: { label: string; layers: ForkLayer[]; scale: number }) {
	return (
		<div
			role="img"
			aria-label={`${label}: ${formatContextTokens(layers.reduce((sum, layer) => sum + layer.tokens, 0))} estimated tokens`}
			className="flex h-1.5 overflow-hidden rounded-full bg-surface-2"
		>
			{layers.map(layer =>
				layer.tokens > 0 ? (
					<span key={layer.key} className={layer.color} style={{ width: `${(layer.tokens / scale) * 100}%` }} />
				) : null
			)}
		</div>
	)
}

/** The data-only body is exported so the estimates remain testable without a browser portal. */
export function ContextBreakdownContent({ data }: { data: ContextBreakdownResponse }) {
	const used = typeof data.usedPercent === 'number' ? `${Math.round(data.usedPercent)}% used` : null
	const categories = CONTEXT_CATEGORY_META.map(item => ({
		...item,
		color: item.barClass,
		tokens: data.categories[item.key]
	}))
	const forkScale = Math.max(data.forkTokens.concise, data.forkTokens.reasoning, data.forkTokens.full, 1)
	const forks = [
		{
			label: 'Concise',
			detail: 'Messages only',
			tokens: data.forkTokens.concise,
			layers: forkLayers(data.forkTokens.concise, data.forkTokens.concise, data.forkTokens.reasoning)
		},
		{
			label: 'With reasoning',
			detail: 'Messages and reasoning',
			tokens: data.forkTokens.reasoning,
			layers: forkLayers(data.forkTokens.reasoning, data.forkTokens.concise, data.forkTokens.reasoning)
		},
		{
			label: 'Full transcript',
			detail: 'Messages, reasoning, and tools',
			tokens: data.forkTokens.full,
			layers: forkLayers(data.forkTokens.full, data.forkTokens.concise, data.forkTokens.reasoning)
		}
	]

	return (
		<div className="space-y-5">
			<section aria-labelledby="context-composition-heading">
				<div className="mb-3 flex items-baseline gap-2">
					<h3 id="context-composition-heading" className="min-w-0 flex-1 text-sm font-semibold">
						Inside this context
					</h3>
					<span className="text-sm font-semibold tabular-nums">{formatContextTokens(data.totalTokens)} tokens</span>
					{used ? <span className="text-xs tabular-nums text-muted">{used}</span> : null}
				</div>

				<div
					role="img"
					aria-label={categories
						.map(item => `${item.label} ${formatContextShare(item.tokens, data.totalTokens)}`)
						.join(', ')}
					className="flex h-2.5 overflow-hidden rounded-full bg-surface-2"
				>
					{categories.map(item =>
						item.tokens > 0 && data.totalTokens > 0 ? (
							<span
								key={item.key}
								className={item.color}
								style={{ width: `${(item.tokens / data.totalTokens) * 100}%` }}
							/>
						) : null
					)}
				</div>

				<div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5">
					{categories.map(item => {
						const share = formatContextShare(item.tokens, data.totalTokens)
						return (
							<div key={item.key} className="min-w-0 text-xs">
								<div className="flex items-center gap-2 text-muted">
									<span className={`size-2 shrink-0 rounded-full ${item.color}`} />
									<span>{item.label}</span>
								</div>
								<div className="mt-0.5 pl-4 tabular-nums">
									{item.tokens ? '≈' : ''}
									{formatContextTokens(item.tokens)} · {share}
								</div>
							</div>
						)
					})}
				</div>

				<p className="mt-3 text-[11px] leading-relaxed text-faint">
					Categories are estimated from the last completed turn. Chat is user prompts and visible replies. Initial
					context is the remainder: system and developer prompts, project instructions, skills, tool definitions,
					attachments, {data.compacted ? 'compacted summaries, ' : ''}and provider overhead.
				</p>
			</section>

			<section aria-labelledby="fork-size-heading" className="border-t border-border-soft pt-4">
				<h3 id="fork-size-heading" className="mb-2 text-sm font-semibold">
					Estimated fork payload
				</h3>
				<div className="divide-y divide-border-soft overflow-hidden rounded-xl border border-border-soft">
					<div className="flex items-center gap-3 px-3 py-2.5">
						<span className="min-w-0 flex-1">
							<span className="block text-xs font-medium">Last message only</span>
							<span className="block text-[11px] text-faint">This response, without history</span>
						</span>
						<span className="text-[11px] text-faint">Depends on message</span>
					</div>
					{forks.map(fork => (
						<div key={fork.label} className="space-y-2 px-3 py-2.5">
							<div className="flex items-center gap-3">
								<span className="min-w-0 flex-1">
									<span className="block text-xs font-medium">{fork.label}</span>
									<span className="block text-[11px] text-faint">{fork.detail}</span>
								</span>
								<span className="shrink-0 text-xs font-medium tabular-nums">≈{formatContextTokens(fork.tokens)}</span>
							</div>
							<ForkPayloadBar label={fork.label} layers={fork.layers} scale={forkScale} />
						</div>
					))}
				</div>
				{data.forkTokens.reasoning === data.forkTokens.concise ? (
					<p className="mt-2 text-[11px] leading-relaxed text-muted">
						No saved reasoning is available to copy, so Concise and With reasoning are the same size.
					</p>
				) : null}
				<p className="mt-2 text-[11px] leading-relaxed text-faint">
					The bars reuse the context colors; the source's initial context is not copied. Fork sizes use the full saved
					transcript{data.compacted ? ', including history before compaction' : ''}.
				</p>
			</section>
		</div>
	)
}

export function ContextBreakdownSheet({
	sessionId,
	title,
	revision,
	onClose
}: {
	sessionId: string
	title: string | null
	/** The session's last-message timestamp keeps the always-visible donut and this sheet on one cache entry. */
	revision?: string | null
	onClose: () => void
}) {
	const query = useContextBreakdown(sessionId, true, revision)
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Context breakdown"
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-md flex-col rounded-t-3xl border border-border-soft bg-surface shadow-xl md:inset-0 md:m-auto md:h-fit md:rounded-3xl"
			>
				<div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
					<div className="min-w-0 flex-1">
						<h2 className="text-base font-semibold">Context</h2>
						<p className="truncate text-xs text-muted">{title || 'Untitled'}</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close context breakdown"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
					>
						<X size={18} />
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
					{query.data ? (
						<ContextBreakdownContent data={query.data} />
					) : query.isError ? (
						<div className="flex flex-col items-center gap-3 py-8 text-center">
							<p className="text-sm text-del">
								{query.error instanceof Error ? query.error.message : 'Could not read this context.'}
							</p>
							<button
								type="button"
								onClick={() => void query.refetch()}
								className="rounded-full border border-border px-3 py-1.5 text-xs font-medium active:bg-surface-2"
							>
								Try again
							</button>
						</div>
					) : (
						<div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
							<LoaderCircle size={16} className="animate-spin" />
							Reading context…
						</div>
					)}
				</div>
			</div>
		</>,
		document.body
	)
}
