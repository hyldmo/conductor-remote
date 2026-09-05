import { Check, Copy, LogOut, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn.ts'
import { useApp } from '../../store.ts'
import { MacRow } from './MacRow.tsx'
import { NotificationsRow } from './NotificationsRow.tsx'
import { QRCode } from './QRCode.tsx'
import { ThemeRow } from './ThemeRow.tsx'

/**
 * Connection sheet — shows a QR + copyable link for THIS device's token URL so you can re-scan it onto
 * another phone or re-add it to the home screen, and disconnect (clears the stored token → TokenGate,
 * behind a confirm — see `confirming`).
 * The gate itself is tokenless and can't draw this, so the QR lives here. Reached from the sidebar header.
 * Also the app's diagnostics corner: it carries the relay/app versions, and the way into the relay's logs.
 */
export function ConnectSheet({
	version,
	onLogs,
	onClose
}: {
	version?: string
	onLogs: () => void
	onClose: () => void
}) {
	const token = useApp(s => s.token)
	const setToken = useApp(s => s.setToken)
	const [copied, setCopied] = useState(false)
	// Disconnect is two taps, and the second one is nowhere near the first. Dropping the token sends you
	// to a gate this sheet can't draw, so the only way back is the URL — off a Mac that may not be in the
	// room. It sat one 32px tap from Close, in a sheet whose reason to exist is a QR you look at.
	const [confirming, setConfirming] = useState(false)
	const url = token ? `${location.origin}/#token=${token}` : location.origin
	// Relay is ahead of the build this app booted → a service-worker update is pending
	// (ReloadPrompt will surface it). Flag it here so the versions explain a stale UI.
	const stale = !!version && version !== __APP_VERSION__

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// clipboard blocked (insecure context / denied) — the link is on screen to copy by hand
		}
	}

	// Portalled to <body>: this is opened from the workspace drawer, whose <aside> carries a
	// `transform` for its slide animation — and a transform makes that element the containing block
	// for `fixed` descendants, so an in-place sheet is pinned inside the 320px drawer instead of the
	// screen (on md+ too, where the rail keeps `md:translate-x-0`). See LogsSheet, same reason.
	//
	// The height cap and the inner scroller are load-bearing, not polish. This sheet is anchored to
	// the *bottom* and has grown a QR plus three rows of Mac controls, so on a phone it outgrew the
	// screen — and an uncapped bottom sheet grows upward, off the top edge. That takes the header
	// with it, so Close and Disconnect land above the viewport while the sheet covers the backdrop
	// that would otherwise dismiss it: the app becomes unreachable with no gesture left. The
	// document can't rescue it either — `html,body{overflow:hidden}` (see index.css), by design.
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Connect a device"
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-sm flex-col items-center gap-4 rounded-t-3xl border border-border-soft bg-surface p-5 shadow-xl md:inset-0 md:m-auto md:h-fit md:rounded-3xl"
			>
				<div className="flex w-full shrink-0 items-center justify-between">
					<h2 className="text-base font-semibold">Connect a device</h2>
					<div className="flex shrink-0 items-center gap-1">
						{/* Tinted, not muted like Close beside it: this drops the token and sends you back to the
						    gate, and getting back in needs the URL from the Mac. The colour is the only thing
						    separating it from ordinary chrome at a glance — and it only *arms* the confirm below,
						    which is where the token actually goes. */}
						<button
							type="button"
							onClick={() => setConfirming(c => !c)}
							aria-label="Disconnect"
							aria-expanded={confirming}
							title="Disconnect"
							className={cn(
								'flex size-8 items-center justify-center rounded-full active:bg-surface-2',
								confirming ? 'bg-del/15 text-del' : 'text-del/80'
							)}
						>
							<LogOut size={17} />
						</button>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close"
							className="flex size-8 items-center justify-center rounded-full text-muted active:bg-surface-2"
						>
							<X size={18} />
						</button>
					</div>
				</div>
				{/* Outside the scroller on purpose: the sheet is capped at 85dvh and already scrolls, so a
				    confirm placed inside it could open below the fold — and an unanswered destructive
				    prompt you can't see is worse than the mis-tap it exists to catch. */}
				{confirming ? (
					<div className="fade-in w-full shrink-0 rounded-xl border border-del/40 bg-del/10 px-3 py-2.5 text-left">
						<p className="text-sm font-medium">Disconnect this device?</p>
						<p className="mt-1 text-xs text-muted">
							This forgets your access token. To get back in you’ll need the link or QR from the Mac running the relay —
							this screen can’t show it to you again.
						</p>
						<div className="mt-2.5 flex gap-2">
							<button
								type="button"
								onClick={() => setConfirming(false)}
								className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm active:bg-surface"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => setToken(null)}
								className="flex-1 rounded-lg bg-del px-3 py-2 text-sm font-semibold text-on-solid active:opacity-80"
							>
								Disconnect
							</button>
						</div>
					</div>
				) : null}
				<div className="flex w-full min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto overscroll-contain">
					<p className="text-center text-sm text-muted">
						Scan on another phone, or re-add this to your home screen. The link carries your access token.
					</p>
					<div className="shrink-0 rounded-2xl bg-white p-3">
						<QRCode text={url} size={216} />
					</div>
					<button
						type="button"
						onClick={copy}
						className="flex w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm active:bg-surface"
					>
						{copied ? <Check size={16} /> : <Copy size={16} />}
						{copied ? 'Copied' : 'Copy link'}
					</button>
					<ThemeRow />
					<NotificationsRow />
					<MacRow />
					<div className="flex w-full items-center justify-between text-xs text-faint">
						<span className="font-mono">
							relay {version ? <ReleaseLink version={version} /> : 'v?'}
							{' · '}
							<span className={stale ? 'text-working' : undefined}>
								app <ReleaseLink version={__APP_VERSION__} />
							</span>
							{stale ? ' · update pending' : ''}
						</span>
						<button type="button" onClick={onLogs} className="shrink-0 text-muted underline-offset-2 hover:underline">
							Logs
						</button>
					</div>
				</div>
			</div>
		</>,
		document.body
	)
}

function ReleaseLink({ version }: { version: string }) {
	if (version === '0.0.0-development') return <>v{version}</>

	return (
		<a
			href={`${__APP_RELEASES_URL__}/tag/v${encodeURIComponent(version)}`}
			target="_blank"
			rel="noopener noreferrer"
			title={`Release notes for v${version}`}
			className="rounded-sm underline underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
		>
			v{version}
		</a>
	)
}
