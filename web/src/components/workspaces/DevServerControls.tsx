import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Globe2, Loader2, Play, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDevServer } from '../../hooks/review.ts'
import { client } from '../../lib/api.ts'
import { useApp } from '../../store.ts'

/**
 * Open the forward the tap just created. Safari drops a tap's activation after a
 * few seconds, so this lands for a server that was already running (about a
 * second) and is refused for a cold start that spent half a minute in Conductor's
 * UI. The Open control is on screen for that case, and a refusal changes nothing.
 * A backgrounded app is left alone: pulling someone into a browser tab minutes
 * later is not what they tapped for.
 */
function openForward(url: string) {
	if (document.visibilityState !== 'visible') return
	window.open(url, '_blank', 'noopener,noreferrer')
}

const controlClass =
	'flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-40'

/** Choose, start, expose, open and stop the workspace's Conductor Run tasks. */
export function DevServerControls({ workspaceId }: { workspaceId: string }) {
	const query = useDevServer(workspaceId)
	const queryClient = useQueryClient()
	const online = useApp(s => s.online)
	const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [previewMenuOpen, setPreviewMenuOpen] = useState(false)
	const [runMenuOpen, setRunMenuOpen] = useState(false)
	const previewControls = useRef<HTMLDivElement>(null)
	const runControls = useRef<HTMLDivElement>(null)
	const state = query.data
	const multipleRunConfigs = (state?.runConfigs?.length ?? 0) > 1
	const forwards =
		state?.forwards?.filter(forward => forward.forwarded && forward.url) ??
		(state?.forwarded && state.url
			? [{ name: state.port ? `Port ${state.port}` : 'Dev server', port: state.port ?? 0, url: state.url }]
			: [])

	useEffect(() => {
		if (!previewMenuOpen && !runMenuOpen) return
		const controls = runMenuOpen ? runControls : previewControls
		const dismissOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && controls.current?.contains(event.target)) return
			setPreviewMenuOpen(false)
			setRunMenuOpen(false)
		}
		const dismissWithEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			setPreviewMenuOpen(false)
			setRunMenuOpen(false)
			controls.current?.querySelector<HTMLButtonElement>('button')?.focus()
		}
		document.addEventListener('pointerdown', dismissOutside)
		document.addEventListener('keydown', dismissWithEscape)
		return () => {
			document.removeEventListener('pointerdown', dismissOutside)
			document.removeEventListener('keydown', dismissWithEscape)
		}
	}, [previewMenuOpen, runMenuOpen])

	const apply = async (running: boolean, runConfigId?: string) => {
		if (busy) return
		setBusy(running ? 'start' : 'stop')
		setError(null)
		try {
			const result = running
				? await client.startDevServer(workspaceId, runConfigId)
				: await client.stopDevServer(workspaceId)
			queryClient.setQueryData(['dev-server', workspaceId], result)
			if (!result.ok) setError(result.error ?? `Could not ${running ? 'start' : 'stop'} the dev server`)
			else if (running && result.url) openForward(result.url)
		} catch (err) {
			setError(err instanceof Error ? err.message : `Could not ${running ? 'start' : 'stop'} the dev server`)
		} finally {
			setBusy(null)
			void queryClient.invalidateQueries({ queryKey: ['dev-server', workspaceId] })
		}
	}

	const startLabel = multipleRunConfigs
		? 'Choose Run config'
		: state?.running
			? 'Forward dev server to tailnet'
			: 'Start and forward dev server'
	const unavailable = state && !state.available

	return (
		<>
			{forwards.length && forwards[0]?.url ? (
				<div ref={previewControls} className="relative flex shrink-0 items-center">
					<a
						href={forwards[0].url}
						target="_blank"
						rel="noreferrer"
						aria-label={`Open ${forwards[0].name} on port ${forwards[0].port}`}
						title={forwards[0].url}
						className={controlClass}
					>
						<ExternalLink size={18} />
					</a>
					{forwards.length > 1 ? (
						<>
							<button
								type="button"
								onClick={() => setPreviewMenuOpen(value => !value)}
								aria-label="Choose forwarded dev server"
								aria-haspopup="menu"
								aria-expanded={previewMenuOpen}
								className="flex h-9 w-6 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<ChevronDown size={14} className={previewMenuOpen ? 'rotate-180' : undefined} />
							</button>
							{previewMenuOpen ? (
								<div
									role="menu"
									aria-label="Forwarded dev servers"
									className="fade-in absolute right-0 top-full z-30 mt-1 max-h-[calc(100dvh-4rem)] min-w-52 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-xl"
								>
									{forwards.map(forward => (
										<a
											key={`${forward.port}:${forward.url}`}
											href={forward.url ?? undefined}
											target="_blank"
											rel="noreferrer"
											onClick={() => setPreviewMenuOpen(false)}
											role="menuitem"
											className="flex items-center gap-3 px-3 py-2.5 text-left text-sm active:bg-surface-2"
										>
											<span className="min-w-0 flex-1 truncate">{forward.name}</span>
											<span className="font-mono text-xs text-faint">:{forward.port}</span>
										</a>
									))}
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : (
				<div ref={runControls} className="relative shrink-0">
					<button
						type="button"
						onClick={() => {
							if (multipleRunConfigs) setRunMenuOpen(value => !value)
							else void apply(true)
						}}
						disabled={!online || !!busy || !!unavailable || query.isLoading}
						aria-label={startLabel}
						aria-haspopup={multipleRunConfigs ? 'menu' : undefined}
						aria-expanded={multipleRunConfigs ? runMenuOpen : undefined}
						title={unavailable ? state.error : startLabel}
						className={controlClass}
					>
						{busy === 'start' || query.isLoading ? (
							<Loader2 size={18} className="animate-spin" />
						) : state?.running ? (
							<Globe2 size={18} />
						) : (
							<Play size={18} fill="currentColor" />
						)}
					</button>
					{runMenuOpen && multipleRunConfigs ? (
						<div
							role="menu"
							aria-label="Run configs"
							className="fade-in absolute right-0 top-full z-30 mt-1 max-h-[calc(100dvh-4rem)] min-w-44 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-xl"
						>
							{state?.runConfigs.map(config => (
								<button
									key={config.id}
									type="button"
									role="menuitem"
									onClick={() => {
										setRunMenuOpen(false)
										void apply(true, config.id)
									}}
									className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm active:bg-surface-2"
								>
									<Play size={14} className="shrink-0 text-muted" />
									<span className="min-w-0 flex-1 truncate">{config.name}</span>
								</button>
							))}
						</div>
					) : null}
				</div>
			)}
			{state?.running || state?.forwarded ? (
				<button
					type="button"
					onClick={() => void apply(false)}
					disabled={!online || !!busy}
					aria-label="Stop dev server"
					className={controlClass}
				>
					{busy === 'stop' ? <Loader2 size={18} className="animate-spin" /> : <Square size={15} fill="currentColor" />}
				</button>
			) : null}
			{error ? (
				<button
					type="button"
					onClick={() => setError(null)}
					className="absolute right-2 top-full z-30 max-w-72 rounded-lg border border-del/40 bg-surface px-3 py-2 text-left text-xs text-del shadow-xl"
				>
					{error}
				</button>
			) : null}
		</>
	)
}
