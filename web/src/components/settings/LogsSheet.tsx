import { Check, Copy, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLogs } from '../../hooks/preferences.ts'
import { cn } from '../../lib/cn.ts'
import type { LogEntry, LogLevel } from '../../lib/types.ts'
import { Empty, Spinner } from '../ui.tsx'

const LEVEL_CLASS: Record<LogLevel, string> = {
	info: 'text-muted',
	warn: 'text-working',
	error: 'text-del'
}

function pad(n: number): string {
	return String(n).padStart(2, '0')
}

/** On screen: time only — the date is noise when you're watching a relay that's live right now. */
function clockTime(t: number | null): string {
	if (t == null) return '·'
	const d = new Date(t)
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** In a copied log: the full stamp, because it's about to be read somewhere with no other context. */
function fullStamp(t: number | null): string {
	if (t == null) return '                   '
	const d = new Date(t)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ageSince(ms: number): string {
	const secs = Math.max(0, Math.round(ms / 1000))
	if (secs < 90) return `${secs}s ago`
	const mins = Math.round(secs / 60)
	if (mins < 60) return `${mins}m ago`
	const hours = Math.round(mins / 60)
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/**
 * The relay's own log, on the phone — the whole point is diagnosing a Mac you can't reach, so it
 * ends in one tap on **Copy** (the relay has already redacted the access token, which its startup
 * banner prints verbatim). Two kinds of source: `Live` is the running relay's captured console,
 * ordered and timestamped; the file tabs tail the daemon's stdout/stderr on disk, which is where a
 * crash *before* the current process still exists — a relay that keeps dying and being restarted by
 * launchd shows an almost-empty Live tab and the real story in `relay.err.log`.
 */
export function LogsSheet({ onClose }: { onClose: () => void }) {
	const [source, setSource] = useState<string | null>(null) // null = the live in-memory buffer
	const [problemsOnly, setProblemsOnly] = useState(false)
	const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
	const { data, isLoading, isError, error } = useLogs(source, true)
	const bodyRef = useRef<HTMLDivElement>(null)
	// Follow the tail, but stop fighting the user the moment they scroll back to read something.
	const stick = useRef(true)

	const shown = useMemo(
		() => (data?.entries ?? []).filter(e => !problemsOnly || e.level !== 'info'),
		[data, problemsOnly]
	)

	useEffect(() => {
		const el = bodyRef.current
		if (el && stick.current && shown.length) el.scrollTop = el.scrollHeight
	}, [shown])

	const copy = async () => {
		const header = `# conductor-remote ${source ?? 'live'} log · app v${__APP_VERSION__} · copied ${fullStamp(Date.now())}`
		const body = shown.map(
			(e: LogEntry) => `${fullStamp(e.t)} ${e.level === 'info' ? '' : e.level.toUpperCase()} ${e.text}`
		)
		try {
			await navigator.clipboard.writeText([header, ...body].join('\n'))
			setCopied('ok')
		} catch {
			// Insecure context or a denied permission — say so; the text is on screen to select by hand.
			setCopied('failed')
		}
		setTimeout(() => setCopied(null), 2000)
	}

	const tabs: Array<{ key: string | null; label: string; hint?: string }> = [
		{ key: null, label: 'Live', hint: data ? `since ${ageSince(data.now - data.startedAt)}` : undefined },
		...(data?.files ?? []).map(f => ({ key: f.name, label: f.name, hint: fileSize(f.size) }))
	]

	// Portalled to <body> deliberately: this sheet is opened from the workspace drawer, and that
	// <aside> carries a `transform` for its slide animation — which makes it the containing block
	// for `fixed` descendants, so an in-place sheet would be pinned inside the 320px drawer instead
	// of the screen. Logs need the whole width.
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Relay logs"
				className="fade-in pt-safe pb-safe fixed inset-0 z-50 mx-auto flex flex-col bg-bg md:inset-6 md:rounded-3xl md:border md:border-border-soft"
			>
				<div className="flex items-center justify-between gap-2 border-b border-border-soft px-4 py-3">
					<div className="min-w-0">
						<h2 className="text-base font-semibold">Relay logs</h2>
						<p className="truncate text-xs text-muted">
							{data
								? `${shown.length} line${shown.length === 1 ? '' : 's'} · relay started ${ageSince(data.now - data.startedAt)}`
								: 'Loading…'}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
					>
						<X size={18} />
					</button>
				</div>

				<div className="flex gap-1.5 overflow-x-auto border-b border-border-soft px-3 py-2">
					{tabs.map(t => (
						<button
							key={t.key ?? 'live'}
							type="button"
							onClick={() => {
								stick.current = true
								setSource(t.key)
							}}
							className={cn('pill shrink-0 whitespace-nowrap', t.key === source && 'pill-active')}
						>
							{t.label}
							{t.hint ? <span className="ml-1.5 text-[11px] text-faint">{t.hint}</span> : null}
						</button>
					))}
				</div>

				{/* The files are the LaunchAgent's streams. An unmanaged relay (dev run) writes to a terminal
				    instead, so its own lines are only in Live — say which log you're actually reading. */}
				{source && data && !data.managed ? (
					<p className="border-b border-border-soft bg-working/10 px-4 py-2 text-xs text-working">
						This file belongs to the installed daemon — this relay isn’t the one writing it. Its own output is under
						Live.
					</p>
				) : null}

				<div
					ref={bodyRef}
					onScroll={e => {
						const el = e.currentTarget
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
					}}
					className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
				>
					{isLoading && !data ? (
						<Spinner label="Reading logs…" />
					) : isError ? (
						<Empty>{(error as Error)?.message}</Empty>
					) : shown.length === 0 ? (
						<Empty>
							{problemsOnly ? 'No warnings or errors logged.' : 'Nothing logged yet — the relay has been quiet.'}
						</Empty>
					) : (
						shown.map((e, i) => (
							// Log lines have no id and repeat verbatim (a retried send logs the same text); the
							// index is the only stable key, and the list is append-only so it doesn't reorder.
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines have no id
							<div key={i} className="flex gap-2 whitespace-pre-wrap break-words py-px">
								<span className="shrink-0 text-faint">{clockTime(e.t)}</span>
								<span className={cn('min-w-0 flex-1', LEVEL_CLASS[e.level])}>{e.text}</span>
							</div>
						))
					)}
				</div>

				<div className="flex items-center gap-2 border-t border-border-soft px-3 py-2.5">
					<button
						type="button"
						onClick={() => setProblemsOnly(v => !v)}
						className={cn('pill shrink-0', problemsOnly && 'pill-active')}
					>
						Problems only
					</button>
					<button
						type="button"
						onClick={copy}
						className="ml-auto flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm active:bg-surface"
					>
						{copied === 'ok' ? <Check size={16} /> : <Copy size={16} />}
						{copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy blocked — select by hand' : 'Copy'}
					</button>
				</div>
			</div>
		</>,
		document.body
	)
}
