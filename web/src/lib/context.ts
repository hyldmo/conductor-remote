import type { ContextBreakdownResponse } from './types.ts'

/** One vocabulary for context composition everywhere it is drawn. */
export const CONTEXT_CATEGORY_META = [
	{
		key: 'initial',
		label: 'Initial context',
		barClass: 'bg-context-initial',
		ringClass: 'stroke-context-initial'
	},
	{ key: 'chat', label: 'Chat', barClass: 'bg-context-chat', ringClass: 'stroke-context-chat' },
	{ key: 'thinking', label: 'Thinking', barClass: 'bg-working', ringClass: 'stroke-working' },
	{ key: 'tools', label: 'Tool calls', barClass: 'bg-context-tools', ringClass: 'stroke-context-tools' }
] as const

export interface ContextRingSegment {
	key: (typeof CONTEXT_CATEGORY_META)[number]['key']
	label: string
	ringClass: string
	length: number
	offset: number
}

/**
 * Subdivide the used portion of a context ring by transcript stratum.
 *
 * `categories` add up to the current token count, while `usedPercent` locates that
 * count inside the model's whole context window. Multiplying the two preserves both
 * facts: color answers what occupies the context, and total arc length answers how
 * close the chat is to compaction.
 */
export function contextRingSegments(
	usedPercent: number,
	breakdown: ContextBreakdownResponse | undefined
): ContextRingSegment[] {
	if (!breakdown || breakdown.totalTokens <= 0) return []
	const used = Math.min(100, Math.max(0, usedPercent))
	let offset = 0
	return CONTEXT_CATEGORY_META.flatMap(category => {
		const tokens = Math.max(0, breakdown.categories[category.key])
		const length = Math.min(100 - offset, (tokens / breakdown.totalTokens) * used)
		if (length <= 0) return []
		const segment = {
			key: category.key,
			label: category.label,
			ringClass: category.ringClass,
			length,
			offset
		}
		offset += length
		return [segment]
	})
}
