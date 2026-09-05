import { useMemo } from 'react'
import { cn } from '../../lib/cn.ts'
import { highlightLines, languageForPath } from '../../lib/syntax/highlight.ts'
import type { FilePreviewResponse } from '../../lib/types.ts'
import { Tokens } from '../transcript/Code.tsx'

/** A bounded source preview with stable line numbers and optional focus highlighting. */
export function SourceLines({
	preview,
	lineRef
}: {
	preview: FilePreviewResponse
	lineRef?: React.RefObject<HTMLDivElement | null>
}) {
	const language = languageForPath(preview.path)
	// One tokenise per preview, split to match the rows this draws. The content is a
	// window into the file (src/http/services/files.ts caps it at 500 lines, or 100 either side of
	// the line the agent named), so a block comment that opened above the window
	// colours from the top of the window rather than from where it really starts.
	// A count that doesn't line up drops the colour rather than the gutter: a line
	// out of step here renumbers every line below it and still looks plausible.
	const { text, tokens } = useMemo(() => {
		const text = preview.content.split('\n')
		const tokens = highlightLines(preview.content, language)
		return { text, tokens: tokens?.length === text.length ? tokens : null }
	}, [preview.content, language])
	return (
		<>
			<pre className="min-w-max p-3 font-mono text-[11.5px] leading-[1.5] text-muted">
				{text.map((line, index) => {
					const number = preview.lineStart + index
					const selected = number === preview.line
					const lineTokens = tokens?.[index]
					return (
						<div
							key={number}
							ref={selected ? lineRef : undefined}
							className={cn(
								'grid grid-cols-[auto_1fr] gap-3 whitespace-pre',
								selected && 'rounded bg-accent-soft text-text'
							)}
						>
							<span className="select-none text-right text-faint">{number}</span>
							<code>{lineTokens?.length ? <Tokens nodes={lineTokens} /> : line || ' '}</code>
						</div>
					)
				})}
			</pre>
			<PreviewTruncationNotice preview={preview} />
		</>
	)
}

export function PreviewTruncationNotice({ preview }: { preview: FilePreviewResponse }) {
	return preview.truncated ? (
		<p className="border-t border-border-soft px-4 py-2 text-xs text-faint">
			Showing lines {preview.lineStart}–{preview.lineEnd} of {preview.totalLines}.
		</p>
	) : null
}
