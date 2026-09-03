import { cn } from '../lib/cn.ts'
import type { DiffStats } from '../lib/types.ts'

const COMPACT_COUNT = new Intl.NumberFormat('en', { notation: 'compact' })

/** Match Conductor's compact sidebar scale: 850, 6.1k, 23k. */
export function compactLineCount(value: number): string {
	return COMPACT_COUNT.format(Math.max(0, value)).toLowerCase()
}

function lineLabel(count: number, direction: 'added' | 'removed'): string {
	return `${count.toLocaleString('en')} ${count === 1 ? 'line' : 'lines'} ${direction}`
}

/** Inline git additions/deletions for the workspace row's primary scan line. */
export function ChangeStats({ stats, className }: { stats?: DiffStats | null; className?: string }) {
	if (!stats || (stats.added <= 0 && stats.removed <= 0)) return null
	const label = [
		stats.added > 0 ? lineLabel(stats.added, 'added') : null,
		stats.removed > 0 ? lineLabel(stats.removed, 'removed') : null
	]
		.filter(Boolean)
		.join(', ')
	return (
		<span
			className={cn(
				'flex shrink-0 items-center gap-1 font-mono text-[10px] font-medium leading-none tabular-nums',
				className
			)}
			title={label}
		>
			<span className="sr-only">{label}</span>
			{stats.added > 0 ? (
				<span className="text-add" aria-hidden="true">
					+{compactLineCount(stats.added)}
				</span>
			) : null}
			{stats.removed > 0 ? (
				<span className="text-del" aria-hidden="true">
					-{compactLineCount(stats.removed)}
				</span>
			) : null}
		</span>
	)
}
