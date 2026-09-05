import type { Element, ElementContent } from 'hast'
import { Paperclip } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { attachmentTokens, isPreviewableSource } from '../../../../src/shared.ts'
import { useLocalImage } from '../../hooks/images.ts'
import { client } from '../../lib/api.ts'
import { useAttachmentReference, useFileMention, useImageReference } from '../../lib/fileMentions.ts'
import { languageForFence } from '../../lib/syntax/highlight.ts'
import type { FilePreviewResponse } from '../../lib/types.ts'
import { ImageThumbnail } from '../attachments/ImageThumbnail.tsx'
import { PreviewTruncationNotice, SourceLines } from '../review/SourceLines.tsx'
import { ViewerHeader } from '../review/ViewerHeader.tsx'
import { CopyButton, Spinner } from '../ui.tsx'
import { Code } from './Code.tsx'

/** Hoisted so the plugin list is one stable prop rather than a new array on every render. */
const PLUGINS = [remarkGfm, remarkBreaks]
const ATTACHMENT_HOST = 'conductor-attachment.invalid'

/** Turn a Conductor token into a Markdown link for a file chip or image thumbnail. */
function withAttachmentLinks(text: string): string {
	const tokens = attachmentTokens(text)
	if (!tokens.length) return text
	let markdown = ''
	let offset = 0
	for (const token of tokens) {
		const label = token.name.replace(/[\\`*_[\]<>]/g, '\\$&')
		markdown += `${text.slice(offset, token.start)}[${label}](https://${ATTACHMENT_HOST}/?path=${encodeURIComponent(token.path)})`
		offset = token.end
	}
	return markdown + text.slice(offset)
}

function attachmentPath(href: string | undefined): string | null {
	if (!href) return null
	try {
		const url = new URL(href)
		return url.hostname === ATTACHMENT_HOST ? url.searchParams.get('path') : null
	} catch {
		return null
	}
}

/** Fetch a local Markdown image through the relay, where the browser can attach its auth header. */
function ChatImage({ src, alt, ...props }: React.ComponentProps<'img'>) {
	const reference = useImageReference(typeof src === 'string' ? src : null)
	const { objectUrl, error } = useLocalImage(reference)

	if (reference) {
		if (error)
			return (
				<span className="my-2 block rounded-lg border border-del/30 px-3 py-2 text-xs text-del">
					{alt || 'Image'} unavailable: {error}
				</span>
			)
		return objectUrl ? <img src={objectUrl} alt={alt ?? ''} {...props} /> : null
	}
	return <img src={src} alt={alt ?? ''} {...props} />
}

/** Agent file links are absolute paths, unlike the PWA's own `/w/:id` routes. */
export function sourceReference(href: string | undefined): string | null {
	if (!href?.startsWith('/')) return null
	const location = href.match(/:([1-9]\d*)(?::\d+)?$/)
	return isPreviewableSource(location ? href.slice(0, -location[0].length) : href) ? href : null
}

/**
 * Source links must stay inside the running PWA. A browser follows `/Users/...`
 * back to this app and the router quite reasonably turns it into the home screen.
 * Intercept coding-agent locations and show a relay-backed source preview instead.
 */
export function ChatLink({ href, children, onClick, ...props }: React.ComponentProps<'a'>) {
	const attachment = attachmentPath(href)
	const attachmentPreview = useAttachmentReference(attachment)
	const linkedImageReference = useImageReference(href ?? null)
	const imageReference = attachmentPreview?.kind === 'image' ? attachmentPreview.reference : linkedImageReference
	// A link whose href is a path relative to the worktree — `[the helper](src/git.ts)` —
	// resolves the same way an inline mention does, and for the same reason: followed as a
	// URL it lands on the PWA's own router and shows the home screen.
	const mention = useFileMention(href ?? null)
	const source = attachmentPreview?.kind === 'source' ? attachmentPreview.reference : (sourceReference(href) ?? mention)
	const reference = imageReference ?? source
	const [previewing, setPreviewing] = useState(false)
	const preview =
		imageReference && previewing ? (
			<ImagePreviewSheet reference={imageReference} onClose={() => setPreviewing(false)} />
		) : source && previewing ? (
			<FilePreviewSheet reference={source} onClose={() => setPreviewing(false)} />
		) : null
	// react-markdown's sanitiser blanks the href of every scheme outside http(s), irc(s),
	// mailto and xmpp, and an empty href follows to the page you are already on — a tap
	// that silently reloads the PWA. It is reachable without anyone writing a bad link:
	// gstack appends `<gstack-qid:plan-eng-review-…>` to a review question believing the
	// angle brackets hide it, and CommonMark reads `<scheme:rest>` as an autolink.
	if (!href) return <span title={props.title}>{children}</span>
	if (attachment) {
		if (imageReference) {
			return (
				<>
					<button
						type="button"
						title={`Open image ${imageReference}`}
						onClick={() => setPreviewing(true)}
						className="my-1 inline-flex rounded-lg align-middle transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						<ImageThumbnail reference={imageReference} name={attachment.slice(attachment.lastIndexOf('/') + 1)} />
					</button>
					{preview}
				</>
			)
		}
		return (
			<>
				<button
					type="button"
					title={imageReference ? `Open image ${imageReference}` : source ? `Open ${source}` : attachment}
					disabled={!reference}
					onClick={() => setPreviewing(true)}
					className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 align-baseline text-[0.9em] font-medium text-muted transition hover:text-text focus-visible:outline-2 focus-visible:outline-accent active:bg-surface disabled:cursor-default"
				>
					<Paperclip size={12} className="shrink-0" />
					<span className="truncate">{children}</span>
				</button>
				{preview}
			</>
		)
	}
	return (
		<>
			<a
				href={href}
				{...props}
				title={imageReference ? `Open image ${imageReference}` : props.title}
				onClick={event => {
					onClick?.(event)
					if (
						!reference ||
						event.defaultPrevented ||
						event.button !== 0 ||
						event.metaKey ||
						event.ctrlKey ||
						event.shiftKey ||
						event.altKey
					)
						return
					event.preventDefault()
					setPreviewing(true)
				}}
			>
				{children}
			</a>
			{preview}
		</>
	)
}

function ImagePreviewSheet({ reference, onClose }: { reference: string; onClose: () => void }) {
	const { objectUrl, error } = useLocalImage(reference)

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', closeOnEscape)
		return () => window.removeEventListener('keydown', closeOnEscape)
	}, [onClose])

	return createPortal(
		<>
			<div className="fixed inset-0 z-[60] bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Image preview"
				className="fade-in pt-safe pb-safe fixed inset-0 z-[60] mx-auto flex flex-col bg-bg md:inset-6 md:rounded-3xl md:border md:border-border-soft"
			>
				<ViewerHeader title="Image" subtitle={reference} onClose={onClose} closeLabel="Close image preview" />
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/15 p-3">
					{!objectUrl && !error ? <Spinner label="Loading image…" /> : null}
					{error ? <p className="max-w-xs text-center text-sm text-muted">Image unavailable: {error}</p> : null}
					{objectUrl ? (
						<img src={objectUrl} alt="" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
					) : null}
				</div>
			</div>
		</>,
		document.body
	)
}

function FilePreviewSheet({ reference, onClose }: { reference: string; onClose: () => void }) {
	const [preview, setPreview] = useState<FilePreviewResponse | null>(null)
	const [error, setError] = useState<string | null>(null)
	const highlightedLine = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let disposed = false
		setPreview(null)
		setError(null)
		void client.filePreview(reference).then(
			result => {
				if (!disposed) setPreview(result)
			},
			err => {
				if (!disposed) setError(err instanceof Error ? err.message : 'Could not read source file')
			}
		)
		return () => {
			disposed = true
		}
	}, [reference])

	useEffect(() => {
		if (!preview?.line) return
		highlightedLine.current?.scrollIntoView({ block: 'center' })
	}, [preview?.line])

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', closeOnEscape)
		return () => window.removeEventListener('keydown', closeOnEscape)
	}, [onClose])

	return createPortal(
		<>
			<div className="fixed inset-0 z-[60] bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Source file"
				className="fade-in pt-safe pb-safe fixed inset-0 z-[60] mx-auto flex flex-col bg-bg md:inset-6 md:rounded-3xl md:border md:border-border-soft"
			>
				<ViewerHeader
					title="Source"
					subtitle={preview?.path ?? reference}
					onClose={onClose}
					closeLabel="Close source preview"
				/>
				<div className="min-h-0 flex-1 overflow-auto">
					{!preview && !error ? <Spinner label="Reading source…" /> : null}
					{error ? <p className="mx-auto max-w-xs px-6 py-16 text-center text-sm text-muted">{error}</p> : null}
					{preview ? (
						isMarkdownFile(preview.path) ? (
							<MarkdownFile preview={preview} />
						) : (
							<SourceLines preview={preview} lineRef={highlightedLine} />
						)
					) : null}
				</div>
			</div>
		</>,
		document.body
	)
}

function isMarkdownFile(filePath: string): boolean {
	return filePath.toLowerCase().endsWith('.md')
}

function MarkdownFile({ preview }: { preview: FilePreviewResponse }) {
	return (
		<div className="p-4 text-sm leading-6 text-text">
			<Markdown>{preview.content}</Markdown>
			<PreviewTruncationNotice preview={preview} />
		</div>
	)
}

/**
 * A fenced block, coloured when its info string names a language we registered.
 * Inline code reaches this component too and carries no class at all, so it falls
 * through to the plain `<code>` the chat has always drawn — unless it names a file
 * in this workspace, which is how "we updated `tests/foo.ts`" becomes a source link
 * (`web/src/lib/fileMentions.ts`).
 *
 * Only a classless span is offered as a mention: a fence is a block of code, and its
 * one line naming a path does not make the block a link.
 */
function ChatCode({ className, children, node, ...props }: React.ComponentProps<'code'> & { node?: unknown }) {
	const language = languageForFence(className)
	const text = fenceText(children)
	const mention = useFileMention(className ? null : text)
	if (mention)
		return (
			<FileMention reference={mention} {...props}>
				{children}
			</FileMention>
		)
	return (
		<code className={className} {...props}>
			{language && text !== null ? <Code text={text} language={language} /> : children}
		</code>
	)
}

/**
 * Inline code that names a real file, drawn as code rather than as a link: it is the
 * path the agent wrote, and colouring it like prose would lose that. A real `button`
 * because it opens a sheet instead of going anywhere — the keyboard and VoiceOver get
 * that for free, and an anchor to `/Users/…` would be a lie the router has to catch.
 */
function FileMention({
	reference,
	children,
	...props
}: React.ComponentProps<'code'> & { reference: string; node?: unknown }) {
	const [previewing, setPreviewing] = useState(false)
	return (
		<>
			<button
				type="button"
				title={`Open ${reference}`}
				onClick={() => setPreviewing(true)}
				className="max-w-full align-baseline text-left"
			>
				<code {...props} className="text-accent underline decoration-dotted underline-offset-2">
					{children}
				</code>
			</button>
			{previewing ? <FilePreviewSheet reference={reference} onClose={() => setPreviewing(false)} /> : null}
		</>
	)
}

/** react-markdown hands a fence its source as one string, or as a list of them. */
function fenceText(children: React.ReactNode): string | null {
	if (typeof children === 'string') return children
	if (Array.isArray(children) && children.every(child => typeof child === 'string')) return children.join('')
	return null
}

function ChatPre({ node, children, ...props }: React.ComponentProps<'pre'> & ExtraProps) {
	const source = node ? fenceSource(node) : ''
	return (
		<div className="relative">
			<pre {...props}>{children}</pre>
			{source ? (
				<CopyButton
					text={source}
					label="code"
					size={12}
					className="absolute right-1.5 top-1.5 size-6 rounded-md border border-border-soft bg-bg/90"
				/>
			) : null}
		</div>
	)
}

export function fenceSource(node: Element): string {
	let text = ''
	const walk = (nodes: ElementContent[]) => {
		for (const child of nodes) {
			if (child.type === 'text') text += child.value
			else if (child.type === 'element') walk(child.children)
		}
	}
	walk(node.children)
	return text.replace(/\n$/, '')
}

const COMPONENTS = { a: ChatLink, code: ChatCode, img: ChatImage, pre: ChatPre }

/**
 * Chat markdown. GFM for tables/strikethrough/task lists, breaks so single
 * newlines behave like chat line breaks. Raw HTML is not rendered (react-markdown
 * escapes it by default), so transcript content can't inject markup.
 *
 * `memo` is load-bearing, not a micro-optimisation: rendering this parses the text
 * through remark and rehype, and the transcript holds one per message. The polls
 * above it re-render the whole chat every couple of seconds, so without the bail-out
 * a long session re-parses every message it has ever shown — measured at ~300ms of
 * blocked main thread per poll on a phone-class CPU, which is what makes the
 * spinners stutter. The prop is a plain string, so the default compare is exact.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
				{withAttachmentLinks(children)}
			</ReactMarkdown>
		</div>
	)
})
