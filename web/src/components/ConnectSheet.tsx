import { Bell, Check, Copy, LogOut, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { usePush } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import { useApp } from '../store.ts'
import { QRCode } from './QRCode.tsx'

/**
 * Connection sheet — shows a QR + copyable link for THIS device's token URL so you can re-scan it onto
 * another phone or re-add it to the home screen, and disconnect (clears the stored token → TokenGate).
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
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Connect a device"
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-w-sm flex-col items-center gap-4 rounded-t-3xl border border-border-soft bg-surface p-5 shadow-xl md:inset-0 md:m-auto md:h-fit md:rounded-3xl"
			>
				<div className="flex w-full items-center justify-between">
					<h2 className="text-base font-semibold">Connect a device</h2>
					<div className="flex shrink-0 items-center gap-1">
						{/* Tinted, not muted like Close beside it: this drops the token and sends you back to the
						    gate, and getting back in needs the URL from the Mac. The colour is the only thing
						    separating it from ordinary chrome at a glance. */}
						<button
							type="button"
							onClick={() => setToken(null)}
							aria-label="Disconnect"
							title="Disconnect"
							className="flex size-8 items-center justify-center rounded-full text-del/80 active:bg-surface-2"
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
				<p className="text-center text-sm text-muted">
					Scan on another phone, or re-add this to your home screen. The link carries your access token.
				</p>
				<div className="rounded-2xl bg-white p-3">
					<QRCode text={url} size={216} />
				</div>
				<button
					type="button"
					onClick={copy}
					className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm active:bg-surface"
				>
					{copied ? <Check size={16} /> : <Copy size={16} />}
					{copied ? 'Copied' : 'Copy link'}
				</button>
				<NotificationsRow />
				<div className="flex w-full items-center justify-between text-xs text-faint">
					<span className="font-mono">
						{version ? `relay v${version}` : 'relay v?'}
						{' · '}
						<span className={stale ? 'text-working' : undefined}>app v{__APP_VERSION__}</span>
						{stale ? ' · update pending' : ''}
					</span>
					<button type="button" onClick={onLogs} className="shrink-0 text-muted underline-offset-2 hover:underline">
						Logs
					</button>
				</div>
			</div>
		</>,
		document.body
	)
}

/**
 * Push notifications for this device. Lives on the Connect sheet because that is
 * where everything about *this phone's* relationship with the relay already is —
 * its token, its QR, its logs.
 *
 * The copy carries the fix, not just the state: on iOS the common answer is "add
 * it to your Home Screen" (Safari exposes no push API in a tab) and the second is
 * "you denied it once, so the browser will never ask again" — neither of which a
 * greyed-out switch would explain.
 */
function NotificationsRow() {
	const push = usePush()
	const blocked = push.permission === 'denied'
	const unavailable = push.support !== 'ok' || push.relayDisabled

	const explain = push.relayDisabled
		? 'Turned off on the relay (PUSH_NOTIFY=off).'
		: push.support === 'needs-install'
			? 'Add this to your Home Screen first — iOS only allows notifications for installed apps.'
			: push.support === 'insecure'
				? 'Needs a secure connection — open the app on its https:// Tailscale URL.'
				: push.support === 'unsupported'
					? 'This browser can’t receive push notifications.'
					: blocked
						? 'Blocked for this app — allow notifications in your device settings, then come back.'
						: push.enabled
							? `On for this device${push.devices > 1 ? ` · ${push.devices} devices subscribed` : ''}.`
							: 'Get a ping when an agent finishes its turn or hits an error.'

	return (
		<div className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<Bell size={16} className={cn('shrink-0', push.enabled ? 'text-accent' : 'text-muted')} />
					<span>Notifications</span>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={push.enabled}
					aria-label="Notifications on this device"
					disabled={unavailable || blocked || push.busy}
					onClick={() => void (push.enabled ? push.disable() : push.enable())}
					className={cn(
						'relative h-6 w-11 shrink-0 rounded-full transition-colors',
						push.enabled ? 'bg-accent' : 'border border-border bg-surface',
						(unavailable || blocked || push.busy) && 'opacity-40'
					)}
				>
					{/* `left-0.5` is load-bearing: without an inset the absolute knob resolves to its
					    static position, which a button centres — so the "off" state drew mid-pill. */}
					<span
						className={cn(
							'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
							push.enabled ? 'translate-x-5' : 'translate-x-0'
						)}
					/>
				</button>
			</div>
			<p className="mt-1 text-xs text-muted">{explain}</p>
			{push.error ? <p className="mt-1 text-xs text-del">{push.error}</p> : null}
			{push.enabled ? (
				<button
					type="button"
					onClick={() => void push.test()}
					disabled={push.busy}
					className="mt-1.5 text-xs text-muted underline-offset-2 hover:underline disabled:opacity-50"
				>
					Send a test notification
				</button>
			) : null}
		</div>
	)
}
