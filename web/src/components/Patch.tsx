import { useMemo } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * A unified diff, coloured by line.
 *
 * Two screens show one: the workspace diff (DiffView) and an edit step inside a chat,
 * whose result Conductor stores as a `diffString` (src/transcript.ts). They were the
 * same fifteen lines twice over, and a patch that reads differently in two places reads
 * as two different changes.
 */
export function Patch({ patch, truncated, className }: { patch: string; truncated?: boolean; className?: string }) {
	const lines = useMemo(() => patch.split('\n'), [patch])
	return (
		<pre className={cn('overflow-x-auto font-mono text-[11.5px] leading-[1.5]', className)}>
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: patch lines are a static render list
				<div key={i} className={cn('whitespace-pre', lineClass(line))}>
					{line || ' '}
				</div>
			))}
			{truncated ? <div className="mt-2 text-faint">… diff truncated …</div> : null}
		</pre>
	)
}

function lineClass(line: string): string {
	if (line.startsWith('+') && !line.startsWith('+++')) return 'text-add'
	if (line.startsWith('-') && !line.startsWith('---')) return 'text-del'
	if (line.startsWith('@@')) return 'text-accent'
	if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---'))
		return 'text-faint'
	return 'text-muted'
}
