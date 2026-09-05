import { useMemo } from 'react'
import { useDebounced } from '../../hooks/browser.ts'
import { useSearch } from '../../hooks/search.ts'
import { cn } from '../../lib/cn.ts'
import { queryTokens, relativeTime, splitSnippet, workspaceTitle } from '../../lib/format.ts'
import type { SearchRole, SearchSnippet, Workspace } from '../../lib/types.ts'
import { type RepoSelection, repoIsSelected, selectedRepos } from '../../lib/workspace-filter.ts'
import { Chip, Empty, RepoAvatar, Spinner } from '../ui.tsx'
import { repoFilterLabel } from '../workspaces/RepoFilter.tsx'

/**
 * Search results, replacing the grouped list while a query is typed.
 *
 * Two sources arrive at different speeds and are merged into one list rather than
 * stacked into two sections. The live workspaces filter locally on every keystroke,
 * with no request at all, so the workspace you can name appears instantly and keeps
 * working with the relay unreachable. The relay's transcript index answers ~250ms
 * later and adds the ones you can only describe — including archived work, which is
 * 1,846 of the 1,886 workspaces on this Mac and the whole reason the feature exists.
 *
 * A workspace found both ways stays where the local pass put it and keeps its
 * excerpt: the snippet is what separates three workspaces with similar names.
 *
 * `repos` is the sheet's own filter, never the sidebar's View-options one: that scopes
 * the list to what you are working on now, and a search is for finding what you are
 * not. It applies to both sources — locally to the live pass, and on the relay to the
 * index, where it has to sit inside the ranking (src/search/coordinator.ts ▸ search).
 */
export function SearchPane({
	query,
	repoSelection,
	includeArchived,
	live,
	selectedId,
	onOpen
}: {
	query: string
	repoSelection: RepoSelection
	includeArchived: boolean
	live: Workspace[]
	selectedId?: string
	onOpen: (workspaceId: string, sessionId: string | null) => void
}) {
	const settled = useDebounced(query.trim(), 250)
	const repos = selectedRepos(repoSelection)
	const noRepos = repoSelection.mode === 'selected' && repos.length === 0
	const { data, isError, error, isFetching } = useSearch(noRepos ? '' : settled, repos, includeArchived)
	const tokens = useMemo(() => queryTokens(query), [query])

	const rows = useMemo(() => {
		const byId = new Map<string, Row>()
		if (tokens.length)
			for (const w of live) {
				if (repoSelection.mode === 'selected' && !(w.repo_name && repoIsSelected(repoSelection, w.repo_name))) continue
				const hay = [workspaceTitle(w), w.branch, w.repo_name, w.directory_name, w.session_title]
					.filter(Boolean)
					.join(' ')
					.toLowerCase()
				// Every token must appear somewhere, matching the relay's own name search:
				// "auk lamp" should find the lamp workspace in the auk repo, where neither
				// column holds both words.
				if (tokens.every(t => hay.includes(t)))
					byId.set(w.id, { workspace: w, archived: false, sessionId: null, snippets: [], hits: 0 })
			}
		for (const r of noRepos ? [] : (data?.results ?? [])) {
			// `keepPreviousData` deliberately keeps the old response while the newly scoped
			// request runs. Hide its archived rows immediately when this toggle changes.
			if (!includeArchived && r.workspace.archived) continue
			const already = byId.get(r.workspace.id)
			if (already) {
				already.sessionId = r.sessionId
				already.snippets = r.snippets
				already.hits = r.hits
				continue
			}
			byId.set(r.workspace.id, {
				workspace: r.workspace,
				archived: r.workspace.archived,
				sessionId: r.sessionId,
				snippets: r.snippets,
				hits: r.hits
			})
		}
		return [...byId.values()]
	}, [live, data, tokens, repoSelection, noRepos, includeArchived])

	const index = data?.index
	return (
		<>
			{index && !index.ready ? (
				<p className="px-1 pb-2 text-xs text-faint">
					Indexing chats… {Math.round(index.progress * 100)}% — older conversations aren’t searchable yet.
				</p>
			) : null}
			{index?.error ? (
				<p className="px-1 pb-2 text-xs text-del">Chat index unavailable ({index.error}) — searching names only.</p>
			) : null}
			{/* A failed search must not take over the pane. The local name filter still works
			    with the relay unreachable, so the rows below are real — and "nothing matches"
			    would be a lie about a question we never got to ask. */}
			{isError ? (
				<p className="px-1 pb-2 text-xs text-del">
					Chat search unavailable ({(error as Error)?.message}) — showing name matches only.
				</p>
			) : null}
			{rows.length === 0 ? (
				isFetching || settled !== query.trim() ? (
					<Spinner />
				) : isError ? null : (
					<Empty>
						{noRepos
							? 'No repos selected.'
							: `Nothing matches “${query.trim()}”${repos.length ? ` in ${repoFilterLabel(repoSelection)}` : ''}.`}
					</Empty>
				)
			) : (
				<ul className="flex flex-col gap-2 pb-2">
					{rows.map(row => (
						<li key={row.workspace.id} className="fade-in">
							<ResultRow row={row} tokens={tokens} selected={row.workspace.id === selectedId} onOpen={onOpen} />
						</li>
					))}
				</ul>
			)}
		</>
	)
}

/** Enough of a workspace to draw a result — satisfied by both `Workspace` and `SearchWorkspace`. */
type RowWorkspace = Pick<
	Workspace,
	'id' | 'workspace_name' | 'pr_title' | 'branch' | 'directory_name' | 'repo_name' | 'updated_at' | 'icon'
>

interface Row {
	workspace: RowWorkspace
	archived: boolean
	/** The chat the strongest excerpt came from, so a tap lands on it rather than the default tab. */
	sessionId: string | null
	snippets: SearchSnippet[]
	hits: number
}

const CARD = 'card w-full flex-col items-stretch gap-0'

/**
 * An archived result opens like any other, into a read-only reader
 * (`ArchivedChat`). It could not before: `/api/state` lists only live workspaces, so
 * `/w/<id>` rendered "Workspace not found" and the row had to be a dead card. What
 * changed is that archiving deletes the worktree and leaves the conversation, and the
 * relay now answers for a workspace in any state (`GET /api/workspaces/:id`) — so the
 * chat search found is the chat you get, with no unarchive on the Mac.
 */
function ResultRow({
	row,
	tokens,
	selected,
	onOpen
}: {
	row: Row
	tokens: string[]
	selected: boolean
	onOpen: (workspaceId: string, sessionId: string | null) => void
}) {
	const w = row.workspace
	// Conductor names every worktree after a reused codename ("manama-v1"), and a search
	// for one matches a scattering of unrelated workspaces that share it. Those rows are
	// right, but nothing on them says so — the codename appears in no other field — so a
	// correct result reads as a bug. Show it exactly when it is the only reason we matched.
	const codename = w.directory_name?.toLowerCase()
	const visible = `${workspaceTitle(w)} ${w.branch ?? ''} ${w.repo_name ?? ''}`.toLowerCase()
	const viaCodename = !!codename && tokens.some(t => codename.includes(t) && !visible.includes(t))
	const body = (
		<>
			<div className="flex items-start gap-3">
				<RepoAvatar icon={w.icon} name={w.repo_name || workspaceTitle(w)} artwork="inset" />
				<div className="min-w-0 flex-1 overflow-hidden">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate font-medium text-text">{workspaceTitle(w)}</span>
						{row.archived ? (
							<span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
								Archived
							</span>
						) : null}
					</div>
					<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
						{w.repo_name ? <span className="shrink-0 font-mono text-faint">{w.repo_name}</span> : null}
						{w.branch ? <Chip className="min-w-0 flex-1 truncate">{w.branch}</Chip> : null}
						{viaCodename ? <Chip className="shrink-0 text-faint">dir {w.directory_name}</Chip> : null}
						<span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">{relativeTime(w.updated_at)}</span>
					</div>
				</div>
			</div>
			{row.snippets.length ? (
				<div className="mt-2 flex flex-col gap-1.5 border-l-2 border-border-soft pl-2.5">
					{row.snippets.map(s => (
						<SnippetLine key={`${s.sessionId}:${s.at}:${s.text.slice(0, 24)}`} snippet={s} />
					))}
					{row.hits > row.snippets.length ? (
						<span className="text-[11px] text-faint">+{row.hits - row.snippets.length} more messages</span>
					) : null}
				</div>
			) : null}
		</>
	)
	return (
		<button
			type="button"
			data-palette-row=""
			className={cn(CARD, selected && 'border-accent/50 bg-surface-2')}
			onClick={() => onOpen(w.id, row.sessionId)}
		>
			{body}
		</button>
	)
}

/**
 * Reasoning gets its own label rather than reading as the agent's answer: the words
 * are real and the chat view renders them, but the agent never said them out loud,
 * so an excerpt tagged "agent" would be quoted back as a statement it made.
 */
const ROLE_LABEL: Record<SearchRole, string> = { user: 'you', assistant: 'agent', thinking: 'thought' }

function SnippetLine({ snippet }: { snippet: SearchSnippet }) {
	return (
		<p className="line-clamp-2 text-left text-xs leading-snug text-muted">
			<span
				className={`mr-1.5 text-[10px] uppercase tracking-wide ${snippet.role === 'thinking' ? 'text-faint italic' : 'text-faint'}`}
			>
				{ROLE_LABEL[snippet.role]}
			</span>
			{splitSnippet(snippet.text).map((run, i) =>
				run.hit ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional slices of one string
					<mark key={i} className="rounded bg-accent/25 px-0.5 text-text">
						{run.text}
					</mark>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional slices of one string
					<span key={i}>{run.text}</span>
				)
			)}
		</p>
	)
}
