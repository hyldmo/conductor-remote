import type { ElementContent } from 'hast'
import { memo, useMemo } from 'react'
import { highlightCode } from '../../lib/syntax/highlight.ts'

/** hast → React. lowlight emits text and spans only, so this is the whole grammar. */
export function Tokens({ nodes }: { nodes: ElementContent[] }) {
	return (
		<>
			{nodes.map((node, i) => {
				if (node.type === 'text') return node.value
				if (node.type !== 'element') return null
				const classes = node.properties?.className
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: token order is fixed for a given string
					<span key={i} className={Array.isArray(classes) ? classes.join(' ') : undefined}>
						<Tokens nodes={node.children} />
					</span>
				)
			})}
		</>
	)
}

/**
 * A block of code, coloured when its language is one of the registered few.
 *
 * `memo` plus `useMemo` for the same reason `Markdown` carries them: the transcript is
 * polled every second, and a step re-renders whenever its own row does. Tokenising is
 * cheap — 0.011ms for the median Bash command here — but it is not free, and a chat's
 * first paint holds every step it has ever shown.
 */
export const Code = memo(function Code({ text, language }: { text: string; language: string | null }) {
	const nodes = useMemo(() => highlightCode(text, language), [text, language])
	return nodes ? <Tokens nodes={nodes} /> : text
})
