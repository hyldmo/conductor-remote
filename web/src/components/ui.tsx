import { Check, CloudOff, Copy, RefreshCw, WifiOff, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useRepoIcon } from '../hooks.ts'
import { ApiError } from '../lib/api.ts'
import { copyText } from '../lib/clipboard.ts'
import { cn } from '../lib/cn.ts'
import { statusDot } from '../lib/format.ts'
import { unlockUrl } from '../lib/lock.ts'
import { LUCIDE_ICONS } from '../lib/lucideIcons.ts'
import type { PromptIndicatorState } from '../lib/pending.ts'
import type { RepoIcon, Workspace } from '../lib/types.ts'
import { useApp } from '../store.ts'

/** The same small footprint for a queued send and its sticky, actionable failure. */
export function PromptStatusDot({
	state,
	color = 'var(--color-working)',
	className
}: {
	state: Exclude<PromptIndicatorState, null>
	color?: string
	className?: string
}) {
	if (state === 'failed') {
		return (
			<span className={cn('dot-error', className)} role="img" aria-label="Send failed" data-prompt-state="failed">
				<X size={8} strokeWidth={3} aria-hidden />
			</span>
		)
	}
	return (
		<span
			className={cn('dot-spinner', className)}
			style={{ '--spin-color': color } as CSSProperties}
			role="img"
			aria-label="Prompt pending"
			data-prompt-state="sending"
		/>
	)
}

/**
 * Workspace dot: coloured by PR state (src/pr.ts). While a prompt is queued or the
 * agent works it becomes a spinner in that same colour; a send failure leaves the
 * ring behind with an X. `background` must go to the ring or dot, never both, or the
 * spinner fills in and its motion disappears.
 */
export function StatusDot({
	w,
	promptState,
	className
}: {
	w: Workspace
	promptState?: PromptIndicatorState
	className?: string
}) {
	const { color, working } = statusDot(w)
	if (promptState) return <PromptStatusDot state={promptState} color={color} className={className} />
	if (working)
		return <span className={cn('dot-spinner', className)} style={{ '--spin-color': color } as CSSProperties} />
	return <span className={cn('dot', className)} style={{ background: color }} />
}

function syncedAgo(ms: number): string {
	const secs = Math.max(0, Math.round(ms / 1000))
	if (secs < 90) return `${secs}s`
	const mins = Math.round(secs / 60)
	if (mins < 60) return `${mins}m`
	return `${Math.round(mins / 60)}h`
}

/**
 * Silent while connected. When the relay is auto-updating it restarts to apply, briefly dropping every
 * client — show a calm "Updating…" through that window (the last snapshot reads `mode:auto,
 * available:true` from before the restart until a fresh poll clears it) rather than the alarming red
 * "Offline". A genuine drop (no update in flight) still shows the red strip. `check` mode leaves
 * `available` set with no restart, so it keeps the normal offline behaviour.
 */
export function OfflineBanner() {
	const online = useApp(s => s.online)
	const lastSyncAt = useApp(s => s.lastSyncAt)
	const update = useApp(s => s.update)
	const updating = update?.mode === 'auto' && update.available
	// Re-render each second while offline so "last synced" counts up.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (online) return
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [online])
	if (updating)
		return (
			<div className="fade-in flex items-center gap-1.5 bg-accent/10 px-3 py-1.5 text-xs text-accent">
				<RefreshCw size={13} className="animate-spin" />
				<span>Updating relay to {update?.latest ?? 'latest'}… reconnecting</span>
			</div>
		)
	if (online) return null
	return (
		<div className="fade-in flex items-center gap-1.5 bg-del/10 px-3 py-1.5 text-xs text-del">
			<WifiOff size={13} />
			<span>Offline — retrying…{lastSyncAt ? ` last synced ${syncedAgo(now - lastSyncAt)} ago` : ''}</span>
		</div>
	)
}

/**
 * What the phone offers beside a refusal only a person at the Mac can clear: the lock
 * screen accepts no relay write, so every locked-Mac failure ends here rather than in a
 * Retry that would fail the same way (see src/parked.ts for why the relay won't unlock).
 * Renders nothing when there is no host to hand off to — a dev checkout on loopback.
 */
export function UnlockLink({ className }: { className?: string }) {
	const href = unlockUrl()
	if (!href) return null
	return (
		<a href={href} className={cn('font-semibold text-accent underline underline-offset-2', className)}>
			Unlock the Mac
		</a>
	)
}

export function CopyButton({
	text,
	label,
	className,
	size = 14
}: {
	text: string
	label: string
	className?: string
	size?: number
}) {
	const [copied, setCopied] = useState(false)
	const copy = async () => {
		try {
			await copyText(text)
			setCopied(true)
			window.setTimeout(() => setCopied(false), 1800)
		} catch {
			setCopied(false)
		}
	}
	return (
		<button
			type="button"
			onClick={() => void copy()}
			aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
			className={cn('flex items-center justify-center text-muted transition active:bg-surface-2', className)}
		>
			{copied ? <Check size={size} className="text-accent" /> : <Copy size={size} />}
		</button>
	)
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<span className={cn('rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted', className)}>
			{children}
		</span>
	)
}

export function Badge({ children }: { children: ReactNode }) {
	return (
		<span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-white">
			{children}
		</span>
	)
}

/**
 * What to say when the first `/api/state` never lands, which is the only thing the phone
 * can show on a cold launch: there is no cached list to fall back on.
 *
 * The old copy said "check the relay is running and the token is correct", and both of
 * those were fine every single time this actually fired. A phone that reaches nothing is
 * almost never a relay that stopped; it is the path to the relay. So the hints name the
 * path, in the order these have really bitten (see the relay's own README ▸ Troubleshooting):
 * the Mac asleep, then Tailscale, then a stale Funnel.
 *
 * The Private Relay line is the one worth the words. iCloud Private Relay routes WebKit
 * traffic around the VPN, so a *tailnet-only* relay stays unreachable with Tailscale
 * showing Connected — the phone resolves the name over public DNS and lands on a Funnel
 * ingress that is switched off. Nothing on screen suggests a VPN is being bypassed, and
 * the tailnet name never falls back to a working address, so this is unrecoverable by
 * waiting. Measured: 10+ minutes after Funnel went off, public DNS still answered with
 * the dead ingress IPs while MagicDNS answered with the node.
 *
 * A token problem cannot reach here — a 401 clears the token and raises the gate instead
 * (hooks.ts ▸ useOnline) — so it is deliberately not in the list.
 */
export function RelayUnreachable({ error }: { error: unknown }) {
	// `navigator.onLine` is only trustworthy in the negative: false means the OS has no
	// route at all, and that is a different problem with different advice. True proves
	// nothing, which is why every other case falls through to the hints.
	const noNetwork = typeof navigator !== 'undefined' && navigator.onLine === false
	const message = error instanceof Error ? error.message : String(error ?? 'request failed')
	// A timeout normalises to ApiError(0) (lib/api.ts); a DNS or connection failure never
	// becomes one at all, since `fetch` rejects before there is a status to read.
	const unreachable = !(error instanceof ApiError) || error.status === 0

	if (noNetwork)
		return (
			<Empty>
				<WifiOff size={20} className="mx-auto mb-3 text-muted" />
				<div className="font-medium text-text">This phone is offline</div>
				<div className="mt-1">Check Wi-Fi or cellular. The list comes back on its own.</div>
			</Empty>
		)

	return (
		<Empty>
			<CloudOff size={20} className="mx-auto mb-3 text-del" />
			<div className="font-medium text-text">
				{unreachable ? 'Can’t reach the relay' : 'The relay answered with an error'}
			</div>
			<div className="mt-1 break-words font-mono text-[11px] text-muted">{message}</div>
			{unreachable ? (
				<ul className="mt-4 space-y-2 text-left">
					<li>Is the Mac awake and online?</li>
					<li>
						If the relay is tailnet-only: Tailscale connected on this phone, and{' '}
						<span className="text-text">iCloud Private Relay off</span>. Private Relay routes around the VPN, so the app
						stays stuck even while Tailscale says Connected.
					</li>
					<li>Otherwise the Funnel may be stale after a network change — re-deploy on the Mac.</li>
				</ul>
			) : null}
		</Empty>
	)
}

export function Empty({ children }: { children: ReactNode }) {
	return <div className="mx-auto max-w-xs px-6 py-16 text-center text-sm text-muted">{children}</div>
}

export function Spinner({ label }: { label?: string }) {
	return (
		<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
			<span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />
			{label}
		</div>
	)
}

const AVATAR_TILE = 'grid size-8 place-items-center overflow-hidden rounded-lg bg-surface-2 font-semibold text-muted'

/**
 * How a surface draws the *artwork* inside the tile. `inset` holds a raster icon to the
 * 18px the emoji and lucide glyphs draw at, so a list mixing the two reads as one
 * column; `full-bleed` gives that up for size.
 *
 * It is required rather than defaulted, and that is the point. Five surfaces share this
 * component for its resolution, not for its looks, and while the treatment had a default
 * the sidebar's answer was every other list's answer too — a change meant for the
 * workspace row silently resized the repo filter, the search results and both pickers in
 * the New workspace sheet. Naming it at the call site is what keeps one surface's taste
 * from reaching the other four.
 */
export type RepoArtwork = 'inset' | 'full-bleed'

/**
 * Repo avatar, mirroring Conductor's resolution: an emoji or named glyph the user
 * picked, else the repo's own icon file, else the GitHub owner's avatar, else a
 * letter monogram. Takes icon + name rather than a workspace so the repo picker
 * in NewWorkspaceSheet renders exactly the same glyphs as the workspace list.
 *
 * That ladder is why the surfaces share one component: five branches whose order has to
 * match Conductor's, an authenticated fetch for the repo-file case, and a fallback for
 * every way each can fail. Four copies of it would be four chances to disagree about
 * which glyph a repo has. What is *not* shared is `artwork` — see above.
 */
export function RepoAvatar({ icon, name, artwork }: { icon: RepoIcon | null; name: string; artwork: RepoArtwork }) {
	const monogram = <div className={cn(AVATAR_TILE, 'text-xs')}>{(name.trim()[0] ?? '?').toUpperCase()}</div>
	if (!icon) return monogram

	if (icon.kind === 'emoji') return <div className={cn(AVATAR_TILE, 'text-lg leading-none')}>{icon.value}</div>

	if (icon.kind === 'named') {
		const Glyph = LUCIDE_ICONS[icon.value]
		return Glyph ? (
			<div className={AVATAR_TILE}>
				<Glyph size={18} className="text-muted" />
			</div>
		) : (
			monogram
		)
	}

	// GitHub owner avatar: public, external, no token — loads straight from github.com.
	if (icon.kind === 'github')
		return (
			<ImgTile
				src={`https://github.com/${encodeURIComponent(icon.owner)}.png?size=64`}
				fit="cover"
				artwork={artwork}
				fallback={monogram}
			/>
		)

	// Relay-served repo file: fetched with the auth header (token stays out of the URL). Monogram until then.
	return <RepoFileIcon repoName={name} artwork={artwork} fallback={monogram} />
}

/** A raster avatar tile that falls back to the monogram if the image fails to load. */
function ImgTile({
	src,
	fit,
	artwork,
	fallback
}: {
	src: string
	fit: 'cover' | 'contain'
	artwork: RepoArtwork
	fallback: ReactNode
}) {
	const [failed, setFailed] = useState(false)
	if (failed) return <>{fallback}</>
	return (
		<div className={cn(AVATAR_TILE, artwork === 'inset' && 'p-1.5')}>
			{/* A full-bleed image reaches the tile's corners, so it takes the tile's own radius
			    (`inherit`, not a second `rounded-lg`, so one value governs both) — and it needs
			    its own copy, because WebKit drops a parent's rounded clip on a composited child
			    and `.card`'s `active:scale-[0.985]` makes the workspace row exactly that.
			    An inset one is a 20px box floating clear of those corners, where the same 8px
			    reads as 40% of the artwork; it gets a radius proportional to itself instead. */}
			<img
				src={src}
				alt=""
				loading="lazy"
				className={cn(
					'size-full',
					artwork === 'full-bleed' ? 'rounded-[inherit]' : 'rounded-sm',
					fit === 'cover' ? 'object-cover' : 'object-contain'
				)}
				onError={() => setFailed(true)}
			/>
		</div>
	)
}

/** Repo icon served by the relay, fetched with the auth header. Shows the monogram while loading or on error. */
function RepoFileIcon({
	repoName,
	artwork,
	fallback
}: {
	repoName: string | null
	artwork: RepoArtwork
	fallback: ReactNode
}) {
	const { data, isError } = useRepoIcon(repoName)
	if (!repoName || isError || !data) return <>{fallback}</>
	return <ImgTile src={data} fit="contain" artwork={artwork} fallback={fallback} />
}
