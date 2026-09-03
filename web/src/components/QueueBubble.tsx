import { AlertTriangle, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'

export interface QueueBubbleAction {
	label: string
	onClick: () => void
	primary?: boolean
}

/**
 * Shared presentation for work that has been accepted but has not become an
 * ordinary transcript row yet. The owner supplies the action semantics: a local
 * optimistic send, a relay-held prompt, and a delegated job are different wire
 * objects and must never accidentally dismiss one another.
 */
export function QueueBubble({
	state,
	label,
	meta,
	actions = [],
	align = 'right',
	children,
	className,
	dataUserMessage,
	dataMessageState
}: {
	state: 'pending' | 'failed'
	label?: string
	meta?: ReactNode
	actions?: QueueBubbleAction[]
	align?: 'left' | 'right' | 'wide'
	children: ReactNode
	className?: string
	dataUserMessage?: string
	dataMessageState?: string
}) {
	const failed = state === 'failed'
	return (
		<div
			className={cn(
				'flex min-w-0 flex-col gap-1',
				align === 'right' && 'items-end',
				align === 'left' && 'items-start',
				align === 'wide' && 'items-stretch'
			)}
			{...(dataUserMessage ? { 'data-user-msg': dataUserMessage } : {})}
			{...(dataMessageState ? { 'data-msg-state': dataMessageState } : {})}
		>
			<div
				className={cn(
					'min-w-0 rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed [overflow-wrap:anywhere]',
					align === 'wide' ? 'w-full' : 'max-w-[85%]',
					align === 'right' ? 'bg-accent-soft text-text' : 'bg-surface/60 text-text',
					failed ? 'border border-del/40' : 'opacity-60',
					className
				)}
			>
				{label ? (
					<div
						className={cn('mb-1 text-[10px] font-semibold uppercase tracking-wide', failed ? 'text-del' : 'text-faint')}
					>
						{label}
					</div>
				) : null}
				{children}
			</div>
			{failed ? (
				<div
					className={cn(
						'flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-del',
						align === 'right' && 'justify-end'
					)}
				>
					<AlertTriangle size={11} className="shrink-0" />
					{meta ? <span className="min-w-0 max-w-[70vw] truncate">{meta}</span> : <span>Didn’t finish</span>}
					{actions.map(action => (
						<button
							type="button"
							key={action.label}
							onClick={action.onClick}
							className={cn('underline underline-offset-2', action.primary ? 'font-semibold text-del' : 'text-faint')}
						>
							{action.label}
						</button>
					))}
				</div>
			) : (
				<div
					className={cn(
						'flex min-w-0 items-center gap-1 px-1 text-[11px] text-faint',
						align === 'right' && 'justify-end'
					)}
				>
					<Loader2 size={11} className="shrink-0 animate-spin" />
					<span className="min-w-0 truncate">{meta ?? 'Queued'}</span>
					{actions.map(action => (
						<button
							type="button"
							key={action.label}
							onClick={action.onClick}
							className={cn('ml-1 underline underline-offset-2', action.primary && 'font-semibold text-accent')}
						>
							{action.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
