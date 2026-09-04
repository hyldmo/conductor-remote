import { Archive, ArchiveX, ChevronDown, Filter, Search, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRepos } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import { type Command, isApplePlatform, matchCommands, parsePaletteQuery, useCommands } from '../lib/commands.ts'
import type { Workspace } from '../lib/types.ts'
import { ALL_REPOS, type RepoSelection, selectedRepos } from '../lib/workspace-filter.ts'
import { CommandResults, PaletteHeading } from './CommandResults.tsx'
import { type RepoChoice, RepoOptions, repoFilterLabel } from './RepoFilter.tsx'
import { SearchPane } from './SearchPane.tsx'
import { Empty } from './ui.tsx'

/**
 * Search and actions, as a modal over the whole screen rather than a field above the list.
 *
 * The field used to sit under the header permanently, which cost a row of the list
 * on every launch to serve the one control you reach for a few times a day — and on a
 * phone that row is most of a workspace card. As a modal it also gets the width the
 * results actually want: an excerpt is two lines of prose, and the 320px drawer was
 * clipping the part that says why the hit matched.
 *
 * It is the command palette too. The same box that finds a chat finds "Hide merged",
 * "Plan usage" or "Status: Done" (`lib/commands.ts`): with nothing typed it lists every
 * action grouped like the menus they replace; with a query, matching actions sit above
 * the chat results; a leading `>` asks for actions alone and sends no search at all.
 * One box rather than a second dialog, because a person reaching for ⌘K is recalling
 * a thing, and the thing may be a conversation or a switch.
 *
 * The arrow keys move real focus between the rows — actions and results alike carry
 * `data-palette-row` — and Enter is the focused button's own click. Enter in the box
 * takes the first row, the way a launcher does, so ⌘K, "hide merged", Enter is the
 * whole gesture. No index state and no aria-activedescendant: the browser owns the
 * focus ring, and a screen reader hears each row as the menu item it is.
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
	const [repoSelection, setRepoSelection] = useState<RepoSelection>(ALL_REPOS)
	const [includeArchived, setIncludeArchived] = useState(true)
	const [pickerOpen, setPickerOpen] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const rootRef = useRef<HTMLDivElement>(null)
	const known = useRepos().data?.repos ?? []
	const commands = useCommands()
	const apple = useMemo(() => isApplePlatform(), [])

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

	const repos = selectedRepos(repoSelection)
	const filtered = repoSelection.mode === 'selected'

	const { commandsOnly, query: searchQuery } = parsePaletteQuery(query)
	const browsing = !searchQuery.trim()
	const matched = useMemo(() => matchCommands(commands, searchQuery), [commands, searchQuery])
	// Beside chat results the actions take the top of the list, not the whole of it.
	const actions = browsing || commandsOnly ? matched : matched.slice(0, MAX_ACTIONS_BESIDE_RESULTS)

	const run = (command: Command) => {
		// Close first: a sheet the command opens has to land on an empty screen rather
		// than under this one, and this sheet's own Esc listener leaves with it.
		onClose()
		void command.run()
	}

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.nativeEvent.isComposing) return
		const input = inputRef.current
		const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-palette-row]') ?? [])]
		const active = document.activeElement
		const at = active instanceof HTMLElement ? rows.indexOf(active) : -1
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (!rows.length) return
			e.preventDefault()
			if (e.key === 'ArrowDown') rows[at < 0 ? 0 : Math.min(at + 1, rows.length - 1)]?.focus()
			else if (at <= 0) input?.focus()
			else rows[at - 1]?.focus()
			return
		}
		// Only once something is typed: Enter on an empty box must not run whatever
		// happens to be listed first.
		if (e.key === 'Enter' && active === input && searchQuery.trim()) {
			const first = rows[0]
			if (!first) return
			e.preventDefault()
			first.click()
			return
		}
		// A character typed while a row has focus belongs in the box. The default is
		// cancelled and the character appended by hand, so it lands exactly once.
		if (at >= 0 && input && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault()
			setQuery(current => current + e.key)
			input.focus()
		}
	}

	// Portalled to <body> for the same reason as the other sheets: the drawer <aside> it
	// opens from carries a `transform`, which would make `fixed` mean "the drawer".
	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} aria-hidden />
			<div
				ref={rootRef}
				role="dialog"
				aria-modal="true"
				aria-label="Search chats and actions"
				onKeyDown={onKeyDown}
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
							placeholder="Search chats and actions"
							aria-label="Search chats and actions"
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
						aria-label={filtered ? `Repo filter: ${repoFilterLabel(repoSelection)}` : 'Filter by repo'}
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
								<span className="min-w-0 truncate">{repoFilterLabel(repoSelection)}</span>
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
								<RepoOptions repos={choices} selected={repoSelection} onChange={setRepoSelection} />
							</div>
						</>
					) : null}
				</div>
				<div className="pb-safe min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
					<CommandResults commands={actions} grouped={browsing || commandsOnly} apple={apple} onRun={run} />
					{commandsOnly ? (
						actions.length ? null : (
							<Empty>No action matches “{searchQuery}”. Drop the “&gt;” to search chats too.</Empty>
						)
					) : browsing ? (
						<p className="px-2.5 pt-3 text-xs leading-relaxed text-faint">
							{filtered
								? repos.length
									? `Workspaces and chats in ${repoFilterLabel(repoSelection)}`
									: 'No repos selected'
								: 'Every workspace on this Mac'}
							{includeArchived ? ', archived included' : ', excluding archived'} — by name, or by something said in the
							chat. Quote a “phrase” to require it word for word; start with “&gt;” for actions alone.
						</p>
					) : (
						<>
							{actions.length ? <PaletteHeading>Workspaces and chats</PaletteHeading> : null}
							<SearchPane
								query={searchQuery}
								repoSelection={repoSelection}
								includeArchived={includeArchived}
								live={live}
								selectedId={selectedId}
								onOpen={onOpen}
							/>
						</>
					)}
				</div>
			</div>
		</>,
		document.body
	)
}

/**
 * How many actions sit above a chat search. Enough that "status" lists every status
 * choice, few enough that a query meant for a chat does not push its results below
 * the fold on a phone.
 */
const MAX_ACTIONS_BESIDE_RESULTS = 8
