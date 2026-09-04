import { lazy, Suspense, useMemo } from 'react'
import { cn } from '../lib/cn.ts'

export interface PatchProps {
	patch: string
	fileName?: string
	hideFileHeader?: boolean
	truncated?: boolean
	className?: string
}

const PierrePatch = lazy(() => import('./PierrePatch.tsx'))

/**
 * A unified diff owned by Pierre: syntax, gutters, change emphasis and hunks. The
 * small line-coloured renderer remains only while Pierre loads and for metadata-
 * only patches (binary files, pure renames and mode changes) that have no code body.
 *
 * Two screens show one: the workspace diff (DiffView) and an edit step inside a chat,
 * whose result Conductor stores as a `diffString` (src/transcript.ts). They were the
 * same fifteen lines twice over, and a patch that reads differently in two places reads
 * as two different changes.
 */
export function Patch(props: PatchProps) {
	// Binary, rename-only and mode-only patches have no code for Shiki to colour. Pierre
	// would reduce those to an empty body once its duplicate file header is hidden.
	if (!props.patch.split('\n').some(line => line.startsWith('@@ '))) return <PlainPatch {...props} />

	return (
		<Suspense fallback={<PlainPatch {...props} />}>
			<PierrePatch {...props} />
		</Suspense>
	)
}

export function PlainPatch({ patch, truncated, className }: PatchProps) {
	const lines = useMemo(() => patch.split('\n'), [patch])
	return (
		<pre className={cn('overflow-x-auto font-mono text-[11.5px] leading-[1.5]', className)}>
			{lines.map((line, i) => {
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: patch lines are a static render list
					<div key={i} className={cn('whitespace-pre', lineClass(line))}>
						{line || ' '}
					</div>
				)
			})}
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
