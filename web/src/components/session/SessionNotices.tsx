import { ArrowLeft } from 'lucide-react'
import { cn } from '../../lib/cn.ts'
import type { Session } from '../../lib/types.ts'

/** Native children cannot receive a phone prompt; return to their real parent first. */
export function SubagentReplyNotice({ title, onReturn }: { title?: string | null; onReturn: () => void }) {
	return (
		<div className="pb-safe flex shrink-0 items-center justify-center border-t border-border-soft px-4 py-3">
			<button
				type="button"
				onClick={onReturn}
				className="flex min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-accent transition active:bg-surface-2"
			>
				<ArrowLeft size={14} className="shrink-0" />
				<span className="truncate">Return to {title || 'parent chat'} to reply</span>
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
export function ContextButton({ session, onOpen }: { session: Session; onOpen: () => void }) {
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
