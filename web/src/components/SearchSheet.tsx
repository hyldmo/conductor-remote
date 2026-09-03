import { Archive, ArchiveX, ChevronDown, Filter, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRepos } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import type { Workspace } from '../lib/types.ts'
import { type RepoChoice, RepoOptions, repoFilterLabel } from './RepoFilter.tsx'
import { SearchPane } from './SearchPane.tsx'
import { Empty } from './ui.tsx'

/**
 * Search, as a modal over the whole screen rather than a field above the list.
 *
 * The field used to sit under the header permanently, which cost a row of the list
 * on every launch to serve the one control you reach for a few times a day — and on a
 * phone that row is most of a workspace card. As a modal it also gets the width the
 * results actually want: an excerpt is two lines of prose, and the 320px drawer was
 * clipping the part that says why the hit matched.
 *
 * Sized off `--app-height`, not `inset-0`, because this sheet owns a focused input:
 * `fixed` resolves against the layout viewport, so a full-height sheet puts its own
 * results behind the software keyboard. The app column already shrinks that way
 * (index.css ▸ --app-height), and `.app-height` is the same rule.
 *
 * The repo filter is the sheet's own and starts at every repo each time it opens. The
 * sidebar's View-options filter is deliberately not inherited: it scopes the list to
 * what you are working on now, and a search is for finding what you are not. The
 * choices come from `/api/repos` rather than the live list, because the archived
 * work a search exists to reach is mostly in repos with no live workspace left.
 */
export function SearchSheet({
	live,
	selectedId,
	onOpen,
	onClose
}: {
	live: Workspace[]
	selectedId?: string
	onOpen: (workspaceId: string, sessionId: string | null) => void
	onClose: () => void
}) {
	const [query, setQuery] = useState('')
	const [repos, setRepos] = useState<string[]>([])
	const [includeArchived, setIncludeArchived] = useState(true)
	const [pickerOpen, setPickerOpen] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const known = useRepos().data?.repos ?? []

	// A live workspace in a repo the relay's list left out (hidden in Conductor) still
	// has to be filterable, or the row is on screen with no way to name its repo.
	const choices: RepoChoice[] = known.map(r => ({ name: r.name, icon: r.icon }))
	for (const w of live)
		if (w.repo_name && !choices.some(c => c.name === w.repo_name)) choices.push({ name: w.repo_name, icon: w.icon })

	// Focus on mount rather than with `autoFocus`: React applies that one before the
	// node is in the document on some WebKit builds, and the keyboard never comes up.
	useEffect(() => inputRef.current?.focus(), [])

	// Esc is the desktop way out — the phone has the X and the scrim. An open picker
	// takes the first press, the sheet the second.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			if (pickerOpen) setPickerOpen(false)
			else onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose, pickerOpen])

	const filtered = repos.length > 0

	// Portalled to <body> for the same reason as the other sheets: the drawer <aside> it
	// opens from carries a `transform`, which would make `fixed` mean "the drawer".
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Search workspaces and chats"
				className="app-height fade-in pt-safe fixed inset-x-0 top-0 z-50 flex flex-col bg-bg md:inset-x-auto md:left-1/2 md:top-16 md:max-h-[70vh] md:w-[36rem] md:max-w-[92vw] md:-translate-x-1/2 md:rounded-2xl md:border md:border-border md:shadow-2xl"
			>
				<div className="relative flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
					<div className="relative min-w-0 flex-1">
						<Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
						{/* `type="text"`, not `type="search"` — WebKit's built-in clear affordance is a
						    different size and colour on every iOS version, so the X below is ours. Without
						    `enterKeyHint` the return key says "Go" and implies a submit this box has not got. */}
						<input
							ref={inputRef}
							type="text"
							inputMode="search"
							enterKeyHint="search"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder="Search workspaces and chats"
							aria-label="Search workspaces and chats"
							className="w-full rounded-xl border border-border bg-surface py-2 pl-8 pr-9 text-sm text-text placeholder:text-faint focus:border-accent/50 focus:outline-none"
						/>
						{query ? (
							<button
								type="button"
								onClick={() => {
									setQuery('')
									inputRef.current?.focus()
								}}
								aria-label="Clear search"
								className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<X size={15} />
							</button>
						) : null}
					</div>
					<button
						type="button"
						onClick={() => setIncludeArchived(include => !include)}
						aria-label="Include archived workspaces"
						aria-pressed={includeArchived}
						title={includeArchived ? 'Search archived workspaces' : 'Archived workspaces excluded'}
						className={cn(
							'flex size-9 shrink-0 items-center justify-center rounded-full active:bg-surface-2',
							includeArchived ? 'border border-accent/50 bg-accent/10 text-text' : 'text-muted'
						)}
					>
						{includeArchived ? <Archive size={18} /> : <ArchiveX size={18} />}
					</button>
					{/* Icon-only until a repo is picked: the label only earns its width once it says
					    something, and on a phone that width comes straight out of the search box. */}
					<button
						type="button"
						onClick={() => setPickerOpen(o => !o)}
						aria-label={filtered ? `Repo filter: ${repoFilterLabel(repos)}` : 'Filter by repo'}
						aria-haspopup="menu"
						aria-expanded={pickerOpen}
						className={cn(
							'flex h-9 shrink-0 items-center justify-center gap-1 rounded-full text-sm active:bg-surface-2',
							filtered ? 'max-w-36 border border-accent/50 bg-accent/10 px-2.5 text-text' : 'size-9 text-muted'
						)}
					>
						<Filter size={filtered ? 14 : 18} className="shrink-0" />
						{filtered ? (
							<>
								<span className="min-w-0 truncate">{repoFilterLabel(repos)}</span>
								<ChevronDown
									size={14}
									className={cn('shrink-0 text-faint transition-transform', pickerOpen && 'rotate-180')}
								/>
							</>
						) : null}
					</button>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close search"
						className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
					>
						<X size={20} />
					</button>
					{pickerOpen ? (
						<>
							<div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} aria-hidden />
							<div
								role="menu"
								aria-label="Repos to search"
								className="fade-in absolute right-3 top-full z-20 mt-1 flex max-h-72 w-64 flex-col overflow-y-auto rounded-2xl border border-border bg-surface py-1 shadow-xl"
							>
								<RepoOptions repos={choices} selected={repos} onChange={setRepos} />
							</div>
						</>
					) : null}
				</div>
				<div className="pb-safe min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
					{query.trim() ? (
						<SearchPane
							query={query}
							repos={repos}
							includeArchived={includeArchived}
							live={live}
							selectedId={selectedId}
							onOpen={onOpen}
						/>
					) : (
						<Empty>
							{filtered ? `Workspaces and chats in ${repoFilterLabel(repos)}` : 'Every workspace on this Mac'}
							{includeArchived ? ', archived included' : ', excluding archived'} — by name, or by something said in the
							chat. Quote a “phrase” to require it word for word.
						</Empty>
					)}
				</div>
			</div>
		</>,
		document.body
	)
}
