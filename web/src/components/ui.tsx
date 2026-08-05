import { RefreshCw, WifiOff } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useRepoIcon } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import { statusDot } from '../lib/format.ts'
import { LUCIDE_ICONS } from '../lib/lucideIcons.ts'
import type { RepoIcon, Workspace } from '../lib/types.ts'
import { useApp } from '../store.ts'

/**
 * Workspace dot: coloured by PR state (src/pr.ts). While the agent works it becomes a
 * spinner in that same colour rather than a filled dot — so `background` must go to one
 * or the other, never both, or the spinner's ring fills in and the motion disappears.
 */
export function StatusDot({ w, className }: { w: Workspace; className?: string }) {
	const { color, working } = statusDot(w)
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
 * Repo avatar, mirroring Conductor's resolution: an emoji or named glyph the user
 * picked, else the repo's own icon file, else the GitHub owner's avatar, else a
 * letter monogram. Takes icon + name rather than a workspace so the repo picker
 * in NewWorkspaceSheet renders exactly the same glyphs as the workspace list.
 */
export function RepoAvatar({ icon, name }: { icon: RepoIcon | null; name: string }) {
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
				fallback={monogram}
			/>
		)

	// Relay-served repo file: fetched with the auth header (token stays out of the URL). Monogram until then.
	return <RepoFileIcon repoName={name} fallback={monogram} />
}

/** A raster avatar tile that falls back to the monogram if the image fails to load. */
function ImgTile({ src, fit, fallback }: { src: string; fit: 'cover' | 'contain'; fallback: ReactNode }) {
	const [failed, setFailed] = useState(false)
	if (failed) return <>{fallback}</>
	return (
		<div className={AVATAR_TILE}>
			<img
				src={src}
				alt=""
				loading="lazy"
				className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
				onError={() => setFailed(true)}
			/>
		</div>
	)
}

/** Repo icon served by the relay, fetched with the auth header. Shows the monogram while loading or on error. */
function RepoFileIcon({ repoName, fallback }: { repoName: string | null; fallback: ReactNode }) {
	const { data, isError } = useRepoIcon(repoName)
	if (!repoName || isError || !data) return <>{fallback}</>
	return <ImgTile src={data} fit="contain" fallback={fallback} />
}
