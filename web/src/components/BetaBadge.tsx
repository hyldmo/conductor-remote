import { cn } from '../lib/cn.ts'

/** Quiet marker for features that are useful now but still carry a changing contract. */
export function BetaBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				'inline-flex h-4 shrink-0 items-center rounded bg-accent/10 px-1.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-accent',
				className
			)}
		>
			Beta
		</span>
	)
}
