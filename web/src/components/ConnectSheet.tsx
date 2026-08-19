import { Bell, Check, Copy, LogOut, Sun, Wifi, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePush } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import type { SettingsResponse } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { QRCode } from './QRCode.tsx'

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
								className="flex-1 rounded-lg bg-del px-3 py-2 text-sm font-semibold text-black active:opacity-80"
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
					<NotificationsRow />
					<MacRow />
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
		<div className="w-full shrink-0 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
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

const AWAKE_CHOICES: { label: string; seconds: number }[] = [
	{ label: '1h', seconds: 3600 },
	{ label: '4h', seconds: 4 * 3600 },
	{ label: '8h', seconds: 8 * 3600 }
]

/** "until 21:45", weekday-prefixed when the window crosses midnight — same rule the CLI prints. */
function untilLabel(until: number | null): string {
	if (!until) return 'until you turn it off'
	const d = new Date(until)
	const sameDay = d.toDateString() === new Date().toDateString()
	const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	return sameDay ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * The two things about the *Mac* a phone can usefully change: keep it awake with the lid
 * shut, and name a network to fall back to when it loses the one it's on.
 *
 * Both are opt-in on the Mac side and say so rather than appearing broken. Keeping the Mac
 * awake needs `nosleep setup` (a scoped sudoers rule — a daemon has no TTY to answer a
 * password prompt), and with none installed the relay reports `available: false`, which is
 * what the copy explains instead of a dead button.
 *
 * The honest caveat is in the copy too: awake is not drivable. A locked screen blocks every
 * UI write, so this buys reads, notifications, and sends that park until you unlock.
 */
function MacRow() {
	const [data, setData] = useState<SettingsResponse | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// The disarm answer said the lid is shut and the Mac is about to be *put* to sleep — the
	// relay goes unreachable seconds after the tap, and copy that still read "stops the Mac
	// sleeping when you shut the lid" made that look like the app breaking.
	const [goingToSleep, setGoingToSleep] = useState(false)

	const load = useCallback(async () => {
		try {
			setData(await client.settings())
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
			await load()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	const nosleep = data?.nosleep
	const known = data?.wifi.known ?? []
	const fallback = data?.settings.fallbackSsids[0] ?? ''

	return (
		<div className="flex w-full shrink-0 flex-col gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<Sun size={16} className={cn('shrink-0', nosleep?.armed ? 'text-accent' : 'text-muted')} />
					<span>Keep the Mac awake</span>
				</div>
				{nosleep?.armed ? (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void act(async () => {
								const r = await client.disarmNoSleep()
								setGoingToSleep(r.willSleep === true)
							})
						}
						className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-50"
					>
						Let it sleep
					</button>
				) : (
					<div className="flex shrink-0 gap-1">
						{AWAKE_CHOICES.map(c => (
							<button
								key={c.seconds}
								type="button"
								disabled={busy || !nosleep?.available}
								onClick={() =>
									void act(() => {
										setGoingToSleep(false)
										return client.armNoSleep(c.seconds)
									})
								}
								className="rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-40"
							>
								{c.label}
							</button>
						))}
					</div>
				)}
			</div>
			<p className="text-xs text-muted">
				{!data
					? 'Checking…'
					: !nosleep?.available
						? 'Run `conductor-remote nosleep setup` on the Mac once to enable this.'
						: nosleep.armed
							? `Awake ${untilLabel(nosleep.until)}, lid closed. Sends still park until you unlock.`
							: goingToSleep
								? 'The lid is shut, so the Mac is going to sleep now — this app will be unreachable until you wake it.'
								: 'Stops the Mac sleeping when you shut the lid. Reads and notifications keep working; sends park until you unlock.'}
			</p>

			<div className="border-t border-border pt-2.5">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<Wifi size={16} className={cn('shrink-0', data?.settings.autoRejoin ? 'text-accent' : 'text-muted')} />
						<span>Fallback network</span>
					</div>
					{fallback ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => void act(() => client.patchSettings({ fallbackSsids: [], autoRejoin: false }))}
							className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-50"
						>
							Turn off
						</button>
					) : null}
				</div>

				{fallback ? (
					<p className="mt-1 text-xs text-muted">
						If the Mac loses its connection it joins <span className="text-fg">{fallback}</span> and re-registers.
					</p>
				) : (
					<NetworkPicker
						known={known}
						hotspots={data?.wifi.likelyHotspots ?? []}
						busy={busy}
						onPick={ssid => void act(() => client.patchSettings({ fallbackSsids: [ssid], autoRejoin: true }))}
					/>
				)}

				{/* The one hotspot fact macOS will actually tell us, and it decides whether any of
				    this can help the case it exists for. On Never the Mac won't reach for the phone
				    on its own, and no relay code substitutes for that. */}
				{data?.wifi.autoJoinHotspot === 'Never' ? (
					<p className="mt-1 text-xs text-faint">
						Auto-join Hotspot is off on this Mac (System Settings ▸ Wi-Fi). Your hotspot has to be on and broadcasting
						before the Mac can join it.
					</p>
				) : null}
			</div>

			{error ? <p className="text-xs text-del">{error}</p> : null}
		</div>
	)
}

/**
 * Choosing one network out of everything this Mac has ever joined — 135 of them on the
 * machine this was built against, which is why a bare `<select>` was the wrong control.
 *
 * **The short list the macOS Wi-Fi menu draws cannot be had.** That menu is a live scan
 * plus a Personal Hotspot learned over Continuity, and both are shut: `system_profiler
 * SPAirPortDataType` does scan and reports every neighbour's channel, security and signal,
 * but prints `<redacted>` for the name without Location Services — it can count them, never
 * name them — the hotspot arrives over private BLE and touches no file, and the store that
 * would at least date each network (`com.apple.wifi.known-networks.plist`, `LastAssociatedAt`)
 * is `-rw------- root`. The world-readable airport prefs keep a `PreferredOrder` array, and
 * on this Mac it is empty. So the saved list is the only list, and it arrives whole.
 *
 * What rescues it is that the list is not arbitrary: `known` comes in macOS's own preference
 * order, which tracks how recently each network was joined, so its head *is* what the menu
 * shows — here `vafler` (associated) then `Han Høyes iPhone` (the hotspot), in that order.
 * Hence only the first hotspot guess is promoted. Sorting every guess to the front instead
 * filled all eight visible slots with iPhones — six of them other people's, ranked 25th to
 * 130th — and buried the office Wi-Fi sitting at rank 3. The guess reads the SSID text alone
 * (`looksLikeHotspot` in src/wifi.ts), so it stays labelled "likely" and stays cheap: it may
 * lift one row, and decide nothing.
 */
function NetworkPicker({
	known,
	hotspots,
	busy,
	onPick
}: {
	known: string[]
	hotspots: string[]
	busy: boolean
	onPick: (ssid: string) => void
}) {
	const [query, setQuery] = useState('')

	if (known.length === 0) return <p className="mt-1 text-xs text-muted">No saved Wi-Fi networks to offer.</p>

	const hot = new Set(hotspots)
	const q = query.trim().toLowerCase()
	const found = known.filter(s => !q || s.toLowerCase().includes(q))
	const phone = found.find(s => hot.has(s))
	const matches = (phone ? [phone, ...found.filter(s => s !== phone)] : found).slice(0, 6)

	return (
		<>
			<p className="mt-1 text-xs text-muted">
				Turn your hotspot on before you leave, and the Mac can move to it if the office Wi-Fi drops.
			</p>
			<input
				type="search"
				value={query}
				disabled={busy}
				onChange={e => setQuery(e.target.value)}
				placeholder={`Search ${known.length} saved networks`}
				className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs disabled:opacity-40"
			/>
			<div className="mt-1.5 flex flex-col gap-1">
				{matches.map(ssid => (
					<button
						key={ssid}
						type="button"
						disabled={busy}
						onClick={() => onPick(ssid)}
						className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs active:bg-surface disabled:opacity-50"
					>
						<span className="truncate">{ssid}</span>
						{hot.has(ssid) ? <span className="shrink-0 text-faint">likely hotspot</span> : null}
					</button>
				))}
				{matches.length === 0 ? <p className="text-xs text-faint">Nothing matches “{query}”.</p> : null}
			</div>
			{/* Says what the six are, so a short list off a 135-network Mac doesn't read as arbitrary. */}
			{!q && known.length > matches.length ? (
				<p className="mt-1 text-xs text-faint">
					Most recently joined. Search to reach the other {known.length - matches.length}.
				</p>
			) : null}
		</>
	)
}
