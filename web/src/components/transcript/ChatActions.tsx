import { Check, ChevronDown, Copy, GitFork, Loader2, Minimize2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { renderTranscript, transcriptThrough } from '../../../../src/shared.ts'
import { copyText } from '../../lib/clipboard.ts'
import { cn } from '../../lib/cn.ts'
import { elapsed, timeAgo, timestampMs } from '../../lib/format.ts'
import { isLockedError } from '../../lib/lock.ts'
import type { TranscriptEntry } from '../../lib/types.ts'
import { UnlockLink } from '../ui.tsx'
import type { TranscriptCut } from './TranscriptMenu.tsx'
import { TranscriptMenu, TranscriptOptions } from './TranscriptMenu.tsx'
import type { SplitFormat } from './types.ts'

/**
 * What a finished turn cost and when it landed, then Copy, then Fork.
 *
 * `through` is the source row the copy stops at, so a fork offered beside an older
 * answer carries the conversation as it stood there. The newest turn passes none and
 * takes the whole chat, which is the same cut and one the header needn't explain.
 */
export function ChatActions({
	text,
	entries,
	at,
	startedAt,
	working,
	rowid,
	through,
	onFork,
	onCompact,
	compactUnavailable
}: {
	text: string
	entries: TranscriptEntry[]
	/** When the response landed — the second half of the meta line. */
	at: string
	/** When its turn started, against which that response is how long the answer took. */
	startedAt?: string | null
	/** A turn still running has its clock in `WorkingIndicator`, so the meta stays off. */
	working?: boolean
	/** The exact source message this action belongs to. */
	rowid: number
	through?: number
	onFork?: (format: SplitFormat) => Promise<void>
	onCompact?: (format: SplitFormat) => Promise<void>
	compactUnavailable?: string
}) {
	const [menuOpen, setMenuOpen] = useState<'copy' | 'fork' | 'compact' | null>(null)
	const [copied, setCopied] = useState<'response' | 'chat' | null>(null)
	const [copyError, setCopyError] = useState<string | null>(null)
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const copyMenuButton = useRef<HTMLButtonElement>(null)
	const forkMenuButton = useRef<HTMLButtonElement>(null)
	const compactMenuButton = useRef<HTMLButtonElement>(null)
	const transferInFlight = useRef(false)
	const [transferring, setTransferring] = useState<'fork' | 'compact' | null>(null)
	const [forkError, setForkError] = useState<string | null>(null)
	const [destination, setDestination] = useState<'chat' | 'workspace'>('chat')

	// An age in words goes stale where the elapsed timer above cannot: the transcript
	// redraws when a row lands, and a finished turn has none coming. A minute is the
	// smallest unit this label prints, so that is how often it needs redrawing.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000)
		return () => {
			clearInterval(timer)
			if (copyTimer.current) clearTimeout(copyTimer.current)
		}
	}, [])

	const took = startedAt ? timestampMs(at) - timestampMs(startedAt) : Number.NaN
	const meta = [took > 0 ? elapsed(took) : null, timeAgo(at, now)].filter(Boolean).join(' · ')

	const copy = async (cut: TranscriptCut = { thinking: false, tools: false, only: true }) => {
		setMenuOpen(null)
		setCopyError(null)
		try {
			let value = text
			if (!cut.only) {
				// The loaded transcript also contains the live outbox. Like Fork, copy only
				// dispatched messages, and keep every entry of an older response's source row.
				const saved = entries.filter(entry => !entry.queued)
				const selected = through === undefined ? saved : transcriptThrough(saved, through)?.entries
				if (!selected) throw new Error('Response no longer available')
				value = renderTranscript(selected, cut).text
			}
			// Stay in the tap's user gesture so copying also works in the installed iOS PWA.
			await copyText(value)
			setCopied(cut.only ? 'response' : 'chat')
			if (copyTimer.current) clearTimeout(copyTimer.current)
			copyTimer.current = setTimeout(() => setCopied(null), 1800)
		} catch {
			setCopied(null)
			setCopyError('Could not copy to the clipboard. Try again.')
		}
	}

	const fork = async (cut: TranscriptCut, replace = false) => {
		const transfer = replace ? onCompact : onFork
		if (!transfer || transferInFlight.current || (replace && compactUnavailable)) return
		transferInFlight.current = true
		setTransferring(replace ? 'compact' : 'fork')
		setForkError(null)
		setMenuOpen(null)
		try {
			await transfer({
				thinking: cut.thinking,
				tools: cut.tools,
				destination: replace ? 'chat' : destination,
				through: cut.only ? undefined : through,
				only: cut.only ? rowid : undefined
			})
		} catch (err) {
			setForkError(err instanceof Error ? err.message : `Could not ${replace ? 'compact' : 'fork'} this chat`)
		} finally {
			transferInFlight.current = false
			setTransferring(null)
		}
	}

	return (
		<div className="flex max-w-full flex-col items-start gap-1">
			<div className="flex max-w-full flex-wrap items-center gap-2">
				{!working && meta ? <span className="text-[11px] tabular-nums text-faint">{meta}</span> : null}
				<div className="relative">
					<div className="flex items-center overflow-hidden rounded-lg border border-border-soft bg-surface/70 text-muted">
						<button
							type="button"
							onClick={() => void copy()}
							aria-label={copied ? `Copied ${copied}` : 'Copy response'}
							className="flex size-7 items-center justify-center transition active:bg-surface-2"
						>
							{copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
						</button>
						<button
							ref={copyMenuButton}
							type="button"
							onClick={() => setMenuOpen(open => (open === 'copy' ? null : 'copy'))}
							aria-label="Choose copy options"
							aria-haspopup="menu"
							aria-expanded={menuOpen === 'copy'}
							className="flex size-7 items-center justify-center border-l border-border-soft transition active:bg-surface-2"
						>
							<ChevronDown size={14} className={cn('transition-transform', menuOpen === 'copy' && 'rotate-180')} />
						</button>
					</div>
					{menuOpen === 'copy' ? (
						<TranscriptMenu label="Copy options" anchor={copyMenuButton} onClose={() => setMenuOpen(null)}>
							<TranscriptOptions onSelect={cut => void copy(cut)} />
						</TranscriptMenu>
					) : null}
				</div>
				{onFork ? (
					<div className="relative">
						<div className="flex items-center overflow-hidden rounded-lg border border-border-soft bg-surface/70 text-muted">
							<button
								type="button"
								onClick={() => void fork({ thinking: true, tools: false })}
								disabled={!!transferring}
								aria-label={
									destination === 'workspace'
										? 'Fork to a new workspace with reasoning'
										: through
											? 'Fork chat from this response'
											: 'Fork chat with reasoning'
								}
								title={destination === 'workspace' ? 'New workspace with current code' : 'New chat, same files'}
								className="flex h-7 items-center gap-1 whitespace-nowrap px-2 text-[11px] font-medium transition active:bg-surface-2 disabled:opacity-50"
							>
								{transferring === 'fork' ? <Loader2 size={13} className="animate-spin" /> : <GitFork size={13} />}
								{destination === 'workspace' ? 'Fork workspace' : 'Fork'}
							</button>
							<button
								ref={forkMenuButton}
								type="button"
								onClick={() => setMenuOpen(open => (open === 'fork' ? null : 'fork'))}
								disabled={!!transferring}
								aria-label="Choose fork options"
								aria-haspopup="menu"
								aria-expanded={menuOpen === 'fork'}
								className="flex size-7 items-center justify-center border-l border-border-soft transition active:bg-surface-2 disabled:opacity-50"
							>
								<ChevronDown size={14} className={cn('transition-transform', menuOpen === 'fork' && 'rotate-180')} />
							</button>
						</div>
						{menuOpen === 'fork' ? (
							<TranscriptMenu label="Fork options" anchor={forkMenuButton} onClose={() => setMenuOpen(null)}>
								<button
									type="button"
									role="menuitemcheckbox"
									aria-checked={destination === 'workspace'}
									onClick={() => setDestination(current => (current === 'chat' ? 'workspace' : 'chat'))}
									className="flex w-full items-center gap-3 border-b border-border-soft px-3 py-2 text-left active:bg-surface-2"
								>
									<span className="min-w-0 flex-1">
										<span className="block text-[12px] font-medium text-text">To new workspace</span>
										<span className="block text-[11px] text-faint">Carry the current code into its own worktree</span>
									</span>
									<span
										aria-hidden
										className={cn(
											'relative h-6 w-11 shrink-0 rounded-full transition-colors',
											destination === 'workspace' ? 'bg-accent' : 'border border-border bg-surface-2'
										)}
									>
										<span
											className={cn(
												'absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform',
												destination === 'workspace' ? 'translate-x-5' : 'translate-x-0'
											)}
										/>
									</span>
								</button>
								<TranscriptOptions onSelect={cut => void fork(cut)} />
							</TranscriptMenu>
						) : null}
					</div>
				) : null}
				{onCompact ? (
					<div className="relative">
						<div className="flex items-center overflow-hidden rounded-lg border border-border-soft bg-surface/70 text-muted">
							<button
								type="button"
								onClick={() => void fork({ thinking: true, tools: false }, true)}
								disabled={!!transferring || !!compactUnavailable}
								aria-label="Compact chat with reasoning"
								title={compactUnavailable ?? 'Toggle fresh context for your next message'}
								className="flex h-7 items-center gap-1 whitespace-nowrap px-2 text-[11px] font-medium transition active:bg-surface-2 disabled:opacity-50"
							>
								{transferring === 'compact' ? <Loader2 size={13} className="animate-spin" /> : <Minimize2 size={13} />}
								Compact
							</button>
							<button
								ref={compactMenuButton}
								type="button"
								onClick={() => setMenuOpen(open => (open === 'compact' ? null : 'compact'))}
								disabled={!!transferring || !!compactUnavailable}
								aria-label="Choose compact options"
								aria-haspopup="menu"
								aria-expanded={menuOpen === 'compact'}
								className="flex size-7 items-center justify-center border-l border-border-soft transition active:bg-surface-2 disabled:opacity-50"
							>
								<ChevronDown size={14} className={cn('transition-transform', menuOpen === 'compact' && 'rotate-180')} />
							</button>
						</div>
						{menuOpen === 'compact' ? (
							<TranscriptMenu label="Compact options" anchor={compactMenuButton} onClose={() => setMenuOpen(null)}>
								<TranscriptOptions onSelect={cut => void fork(cut, true)} />
							</TranscriptMenu>
						) : null}
					</div>
				) : null}
			</div>
			{copyError ? <span className="max-w-[85vw] text-[11px] text-del">{copyError}</span> : null}
			{forkError ? (
				<span className="max-w-[85vw] text-[11px] text-del">
					{forkError}
					{isLockedError(forkError) ? <UnlockLink className="ml-1" /> : null}
				</span>
			) : null}
		</div>
	)
}
