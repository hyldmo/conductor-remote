import { memo, useEffect, useState } from 'react'
import { client } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { languageForTool, languageForToolOutput } from '../../lib/syntax/highlight.ts'
import type { TranscriptEntry } from '../../lib/types.ts'
import { Patch } from '../review/Patch.tsx'
import { Spinner } from '../ui.tsx'
import { plural } from './ActivityIndicator.tsx'
import { Label } from './Bubble.tsx'
import { Code } from './Code.tsx'
import { ChatLink, sourceReference } from './Markdown.tsx'

/**
 * One tool step: what ran, and what came back.
 *
 * Closed it is a single line, which is what a run of forty of them has to stay. Open it
 * carries the call's input and the result the relay paired with it — plain text, a
 * coloured diff for an edit, and any images the tool returned. The images are the reason
 * this holds open state rather than leaving `<details>` to itself: their bytes are a
 * request each (`client.toolImage`), and a closed step must not make it.
 */
export const ToolEntry = memo(function ToolEntry({ e }: { e: TranscriptEntry }) {
	const [open, setOpen] = useState(false)

	// A failure with no call to sit on: the relay never paired it (lib/transcript/merge.ts),
	// so it stands alone as the step that failed rather than disappearing.
	if (e.error && !e.tool) {
		return (
			<div className="overflow-hidden rounded-xl border border-del/30 bg-del/5 px-3 py-2">
				<Mono text={e.text} className="line-clamp-4 text-del/80" />
			</div>
		)
	}
	const source = sourceReference(e.detail)
	const images = e.images ?? []
	// Nothing to open: no input worth a second line, and no output yet — a call still
	// running has none. A disclosure that reveals nothing is worse than a plain row.
	if (!e.detail && !e.output && !images.length) {
		return (
			<div className="flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap rounded-xl border border-border-soft bg-surface/60 px-3 py-1.5">
				<span className="shrink-0 font-mono text-[11px] text-faint">·</span>
				<span className="max-w-full truncate text-[12.5px] text-muted">{e.text}</span>
			</div>
		)
	}
	return (
		<details
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
			className={cn(
				'group/tool min-w-0 overflow-hidden rounded-xl border',
				e.error ? 'border-del/30 bg-del/5' : 'border-border-soft bg-surface/60'
			)}
		>
			<summary className="flex cursor-pointer select-none list-none items-baseline gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 font-mono text-[11px] text-faint transition-transform group-open/tool:rotate-90">
					▸
				</span>
				<span className="max-w-full truncate text-[12.5px] text-muted">{e.text}</span>
				{e.detail ? (
					source ? (
						<ChatLink
							href={source}
							title={`Open ${e.detail}`}
							onClick={event => event.stopPropagation()}
							className="min-w-0 flex-1 truncate font-mono text-[11px] text-accent underline underline-offset-2 group-open/tool:invisible"
						>
							{e.detail}
						</ChatLink>
					) : (
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint group-open/tool:invisible">
							{e.detail}
						</span>
					)
				) : null}
				{e.error ? <span className="ml-auto shrink-0 text-[11px] text-del">failed</span> : null}
			</summary>
			<div className="flex min-w-0 flex-col gap-2 border-t border-border-soft px-3 py-2">
				{e.detail ? (
					source ? (
						<ChatLink
							href={source}
							title={`Open ${e.detail}`}
							className="block whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
						>
							{e.detail}
						</ChatLink>
					) : (
						<Mono text={e.detail} className="text-muted" language={languageForTool(e.tool)} />
					)
				) : null}
				{e.output ? (
					<div className={cn('min-w-0', e.detail && 'border-t border-border-soft pt-2')}>
						<Label>{e.error ? 'error' : e.diff ? 'changes' : 'output'}</Label>
						{e.diff ? (
							<Patch patch={e.output} fileName={e.detail} />
						) : (
							<Mono
								text={e.output}
								className={e.error ? 'text-del/80' : 'text-muted'}
								language={e.error ? null : languageForToolOutput(e.tool, e.detail)}
							/>
						)}
					</div>
				) : null}
				{open && images.length ? (
					<div
						className={cn('flex min-w-0 flex-col gap-2', (e.detail || e.output) && 'border-t border-border-soft pt-2')}
					>
						<Label>{plural(images.length, 'image')}</Label>
						{images.map(reference => (
							<ToolImage key={reference} reference={reference} />
						))}
					</div>
				) : null}
			</div>
		</details>
	)
})

/** Shared by every mono block in a tool row: the call's input, its output, an error. */
const MONO = 'whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]'

/**
 * Output as it was printed. `text` stays inline, or <pre> would render this file's indentation.
 *
 * `language` colours the block. Only the *open* body passes one: the closed row shows a
 * single truncated line, so colouring it would buy a comma and cost a tokenise per step
 * on every chat's first paint — 256 Bash calls in the largest chat on this Mac.
 */
function Mono({ text, className, language }: { text: string; className?: string; language?: string | null }) {
	return <pre className={cn(MONO, className)}>{language ? <Code text={text} language={language} /> : text}</pre>
}

/** A tool's image, pulled through the relay so the token stays in the header, not the URL. */
function ToolImage({ reference }: { reference: string }) {
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let disposed = false
		client
			.toolImage(reference)
			.then(objectUrl => !disposed && setUrl(objectUrl))
			.catch(() => !disposed && setFailed(true))
		return () => {
			disposed = true
		}
	}, [reference])

	if (failed) return <span className="text-[11px] text-faint">Image unavailable.</span>
	if (!url) return <Spinner label="Loading image…" />
	return <img src={url} alt="Tool output" className="max-w-full rounded-lg border border-border-soft" />
}
