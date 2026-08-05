import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useRepos } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { RepoAvatar } from './ui.tsx'

/**
 * Start new work from the phone — the one action that previously needed the Mac.
 *
 * Conductor's deep-link scheme creates the workspace (no Accessibility, no
 * keystrokes) but only *pre-fills* the composer, and the worktree then takes
 * however long it takes — measured at 30s+ on a real repo, past the phone's own
 * request budget. So the relay returns as soon as the row exists and delivers the
 * prompt itself once the workspace turns ready (src/firstprompt.ts): a slow repo
 * shows a real workspace filling in rather than a spinner, and the prompt still
 * goes if the phone is locked, closed, or off the network by then. This screen's
 * job ends at the response; the chat shows the prompt until it lands.
 */
export function NewWorkspaceSheet({ onClose }: { onClose: () => void }) {
	const { data } = useRepos()
	const [repo, setRepo] = useState<string>('')
	const [prompt, setPrompt] = useState('')
	const [pickerOpen, setPickerOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const repos = data?.repos ?? []
	const selected = repos.find(r => r.name === repo)
	// Default to the first repo so "path" is always explicit — an unmatched or
	// missing path silently lands the workspace in whichever repo Conductor lists first.
	useEffect(() => {
		if (!repo && repos.length) setRepo(repos[0].name)
	}, [repo, repos])

	const create = async () => {
		const text = prompt.trim()
		if (!repo || busy) return
		setBusy(true)
		setError(null)
		try {
			const r = await client.createWorkspace(repo, text)
			if (!r.ok || !r.workspaceId) {
				setError(r.error ?? 'could not create the workspace')
				return
			}
			// ['state'] is the workspace-list query — an invalidate on any other key silently
			// does nothing and the new workspace only shows up on the next 2.5s poll.
			await queryClient.invalidateQueries({ queryKey: ['state'] })
			onClose()
			navigate(`/w/${r.workspaceId}`)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'could not create the workspace')
		} finally {
			setBusy(false)
		}
	}

	// Portalled to <body> for the same reason as ConnectSheet/LogsSheet: the drawer <aside> it's
	// opened from has a `transform`, which would make `fixed inset-0` mean "the drawer", not "the screen".
	return createPortal(
		<div className="fixed inset-0 z-50 flex flex-col bg-bg">
			<header className="pt-safe flex items-center gap-2 border-b border-border-soft px-3 pb-2.5">
				<span className="flex-1 text-[15px] font-semibold">New workspace</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
				<div className="relative">
					<button
						type="button"
						onClick={() => setPickerOpen(o => !o)}
						aria-haspopup="menu"
						aria-expanded={pickerOpen}
						className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 text-left transition active:bg-surface-2"
					>
						{selected ? <RepoAvatar icon={selected.icon} name={selected.name} /> : null}
						<span className="min-w-0 flex-1 truncate text-[15px] font-medium">{selected?.name ?? 'Choose a repo'}</span>
						<ChevronDown size={18} className={cn('shrink-0 text-muted transition', pickerOpen && 'rotate-180')} />
					</button>
					{pickerOpen ? (
						<ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-2xl border border-border bg-surface py-1 shadow-xl">
							{repos.map(r => (
								<li key={r.name}>
									<button
										type="button"
										onClick={() => {
											setRepo(r.name)
											setPickerOpen(false)
										}}
										className="flex w-full items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
									>
										<RepoAvatar icon={r.icon} name={r.name} />
										<span className="min-w-0 flex-1 truncate text-[15px]">{r.name}</span>
										{r.name === repo ? <Check size={16} className="shrink-0 text-accent" /> : null}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
				<textarea
					value={prompt}
					onChange={e => setPrompt(e.target.value)}
					placeholder="What should the agent do? (optional)"
					rows={6}
					// biome-ignore lint/a11y/noAutofocus: the sheet exists only to type this
					autoFocus
					// text-base or iOS auto-zooms on focus and won't zoom back out (see Composer).
					className="w-full resize-none rounded-2xl border border-border bg-surface px-4 py-3 text-base outline-none placeholder:text-faint"
				/>
				{error ? <div className="text-xs text-del">{error}</div> : null}
			</div>

			<div className="pb-safe border-t border-border-soft p-3">
				<button
					type="button"
					onClick={create}
					disabled={!repo || busy}
					className="w-full rounded-2xl bg-accent px-4 py-3 text-[15px] font-semibold text-bg transition active:scale-[0.985] disabled:opacity-40"
				>
					{busy ? 'Creating…' : prompt.trim() ? 'Create & start' : 'Create empty workspace'}
				</button>
			</div>
		</div>,
		document.body
	)
}
