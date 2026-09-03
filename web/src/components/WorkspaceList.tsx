import { ChevronDown, Gauge, Plus, QrCode, Search, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useModelCatalog, useWorkspaces } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import {
	isDone,
	isMerged,
	modelLabel,
	RECENT_BUCKETS,
	recentBucket,
	recentBucketLabel,
	relativeAge,
	STATUS_COLORS,
	STATUS_ORDER,
	timestampMs,
	workspaceStatus,
	workspaceStatusLabel,
	workspaceTitle
} from '../lib/format.ts'
import { type PromptIndicatorState, promptIndicator } from '../lib/pending.ts'
import { unreadCount } from '../lib/read.ts'
import type { CachedModelGroup, Workspace } from '../lib/types.ts'
import { type GroupBy, type SortBy, useApp, type ViewPrefs, WORKING_HINT_MS } from '../store.ts'
import { ProviderMark } from './AgentIcons.tsx'
import { ConnectSheet } from './ConnectSheet.tsx'
import { Header } from './Header.tsx'
import { LogsSheet } from './LogsSheet.tsx'
import { NewWorkspaceSheet } from './NewWorkspaceSheet.tsx'
import { PlanUsageSheet } from './PlanUsageSheet.tsx'
import { type RepoChoice, RepoOptions, repoFilterLabel } from './RepoFilter.tsx'
import { SearchSheet } from './SearchSheet.tsx'
import { Badge, Empty, RelayUnreachable, RepoAvatar, Spinner, StatusDot } from './ui.tsx'

/** Pinned first (matches the relay's order), then the chosen sort key. */
function sortWorkspaces(list: Workspace[], sortBy: SortBy): Workspace[] {
	return [...list].sort((a, b) => {
		const pin = Number(!!b.pinned_at) - Number(!!a.pinned_at)
		if (pin) return pin
		if (sortBy === 'name') return workspaceTitle(a).localeCompare(workspaceTitle(b))
		// Conductor mixes bare SQLite UTC and ISO-Z strings. Parse both before sorting:
		// lexically, every `T` sorts after every space even when its row is older.
		const aTime = sortBy === 'created' ? a.created_at : a.updated_at
		const bTime = sortBy === 'created' ? b.created_at : b.updated_at
		const byTime = timestampMs(bTime) - timestampMs(aTime)
		return Number.isFinite(byTime) ? byTime : bTime.localeCompare(aTime)
	})
}

interface Group {
	key: string
	label: string
	status?: string
	items: Workspace[]
}

function bucketKey(w: Workspace, groupBy: GroupBy): string {
	if (groupBy === 'status') return workspaceStatus(w)
	if (groupBy === 'recent') return recentBucket(w.updated_at)
	return w.repo_name ?? ''
}

function groupWorkspaces(list: Workspace[], groupBy: GroupBy): Group[] {
	if (groupBy === 'none') return [{ key: 'all', label: '', items: list }]
	const buckets = new Map<string, Workspace[]>()
	for (const w of list) {
		const key = bucketKey(w, groupBy)
		const bucket = buckets.get(key)
		if (bucket) bucket.push(w)
		else buckets.set(key, [w])
	}
	if (groupBy === 'status') {
		const order = [...STATUS_ORDER, ...[...buckets.keys()].filter(k => !STATUS_ORDER.includes(k))]
		return order
			.filter(s => buckets.has(s))
			.map(s => ({ key: `status:${s}`, label: workspaceStatusLabel(s), status: s, items: buckets.get(s) ?? [] }))
	}
	if (groupBy === 'recent')
		return RECENT_BUCKETS.filter(b => buckets.has(b)).map(b => ({
			key: `recent:${b}`,
			label: recentBucketLabel(b),
			items: buckets.get(b) ?? []
		}))
	return [...buckets.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map(r => ({ key: `repo:${r}`, label: r || 'No repo', items: buckets.get(r) ?? [] }))
}

/** Workspace list — floating drawer on phones, persistent left rail on md+. */
export function WorkspaceList({ selectedId }: { selectedId?: string }) {
	const navigate = useNavigate()
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	const view = useApp(s => s.view)
	const readMarks = useApp(s => s.readMarks)
	const pending = useApp(s => s.pending)
	const workingHints = useApp(s => s.workingHints)
	const toggleGroup = useApp(s => s.toggleGroup)
	const [controlsOpen, setControlsOpen] = useState(false)
	const [connectOpen, setConnectOpen] = useState(false)
	const [newOpen, setNewOpen] = useState(false)
	const [logsOpen, setLogsOpen] = useState(false)
	const [usageOpen, setUsageOpen] = useState(false)
	const [searchOpen, setSearchOpen] = useState(false)
	const { data, isLoading, isError, error } = useWorkspaces()
	const workspaces = data?.workspaces ?? []
	// Conductor's own names for the models these rows run on, read once for the whole
	// list: the catalog is a single cached request, while a hook per card would be one
	// subscription per row on a list that re-reads every 2.5s. It costs no UI trip —
	// `GET /api/models` serves what the picker was last seen holding.
	const modelGroups = useModelCatalog().data?.groups

	// ⌘K / Ctrl+K opens search from any screen. This component is always mounted —
	// drawer on phones, static rail on md+ — so the one listener covers the whole app
	// without a second copy next to the router. It toggles, palette-style, and the
	// preventDefault keeps Ctrl+K away from the browser's own address-bar search.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				setSearchOpen(o => !o)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const repoIcons = new Map(workspaces.map(w => [w.repo_name, w.icon] as const))
	const repos: RepoChoice[] = [
		...new Set([...workspaces.map(w => w.repo_name).filter((r): r is string => !!r), ...view.repos])
	]
		.sort()
		.map(name => ({ name, icon: repoIcons.get(name) ?? null }))
	const inRepo = view.repos.length
		? workspaces.filter(w => !!w.repo_name && view.repos.includes(w.repo_name))
		: workspaces
	// The workspace you're *in* is never hidden: the list is the way back to the chat on
	// screen, and a filter that swallows it reads as the app having lost your place.
	const shown = inRepo.filter(
		w => w.id === selectedId || !((view.hideMerged && isMerged(w)) || (view.hideDone && isDone(w)))
	)
	// One count for both toggles rather than one each: a merged workspace marked Done is
	// hidden once, so two counts would add up to more rows than the filters took out.
	const hidden = inRepo.length - shown.length
	const groups = groupWorkspaces(sortWorkspaces(shown, view.sortBy), view.groupBy)

	// A search result names the chat its excerpt came from, so opening one lands on that
	// conversation instead of the workspace's default tab — the whole point of having
	// found it by something that was said in it.
	const open = (id: string, sessionId: string | null = null) => {
		navigate(sessionId ? `/w/${id}?session=${encodeURIComponent(sessionId)}` : `/w/${id}`)
		setSidebarOpen(false)
	}

	// The dot marks the *setting*; the subtitle only speaks up once a filter actually
	// took something out, or "Hide merged" with nothing merged would read as "40 of 40".
	const filtered = view.repos.length > 0 || view.hideMerged || view.hideDone
	const narrowed = view.repos.length > 0 || hidden > 0
	const repoLabel = repoFilterLabel(view.repos)
	const subtitle = workspaces.length
		? narrowed
			? [
					`${shown.length} of ${workspaces.length}`,
					view.repos.length ? repoLabel : null,
					hidden ? `${hidden} hidden` : null
				]
					.filter(Boolean)
					.join(' · ')
			: `${workspaces.length} active`
		: undefined

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden">
			<div className="relative">
				<Header
					title="Workspaces"
					subtitle={subtitle}
					right={
						/* No close button. The drawer already closes four other ways — the scrim, an
						   edge swipe back, picking a workspace, the header toggle it opened from — and
						   on md+ it is a static rail that cannot close at all, so the X was a control
						   that did nothing half the time and cost a slot on the phone the whole time. */
						<>
							<button
								type="button"
								onClick={() => setSearchOpen(true)}
								aria-label="Search workspaces and chats"
								title="Search (⌘K)"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<Search size={18} />
							</button>
							<button
								type="button"
								onClick={() => setUsageOpen(true)}
								aria-label="Models"
								title="Models"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<Gauge size={18} />
							</button>
							<button
								type="button"
								onClick={() => setControlsOpen(o => !o)}
								aria-label="View options"
								className="relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<SlidersHorizontal size={18} />
								{filtered ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
							</button>
							<button
								type="button"
								onClick={() => setConnectOpen(true)}
								aria-label="Connect a device"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<QrCode size={18} />
							</button>
							{/* Last, and the only filled one: it is the thing you came here to do. */}
							<button
								type="button"
								onClick={() => setNewOpen(true)}
								aria-label="New workspace"
								className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-text active:bg-surface-2"
							>
								<Plus size={20} />
							</button>
						</>
					}
				/>
				{controlsOpen ? <ViewControls repos={repos} view={view} onClose={() => setControlsOpen(false)} /> : null}
			</div>
			<nav className="pb-safe min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
				{isLoading && !data ? (
					<Spinner label="Loading workspaces…" />
				) : isError ? (
					<RelayUnreachable error={error} />
				) : workspaces.length === 0 ? (
					<Empty>No active workspaces. Start one in Conductor and it’ll appear here.</Empty>
				) : shown.length === 0 ? (
					<Empty>
						{view.repos.length ? `No workspaces in ${repoLabel}` : 'No workspaces'}
						{hidden ? ` — ${hidden} ${hidden === 1 ? 'one is' : 'ones are'} hidden.` : '.'}
					</Empty>
				) : (
					groups.map(g => {
						const collapsed = !!g.label && view.collapsed.includes(g.key)
						return (
							<section key={g.key}>
								{g.label ? (
									<button
										type="button"
										onClick={() => toggleGroup(g.key)}
										className="flex w-full items-center gap-2 px-1 py-2 text-sm font-semibold"
									>
										<GroupDot status={g.status} />
										<span className="truncate">{g.label}</span>
										{collapsed ? <span className="font-normal text-muted text-xs">{g.items.length}</span> : null}
										<ChevronDown
											size={14}
											className={cn('ml-auto shrink-0 text-faint transition-transform', collapsed && '-rotate-90')}
										/>
									</button>
								) : null}
								{collapsed ? null : (
									<ul className="flex flex-col gap-2 pb-2">
										{g.items.map(w => {
											const unread = unreadCount(w, readMarks)
											const workingHint = w.active_session_id ? workingHints[w.active_session_id] : undefined
											const promptState = promptIndicator(
												pending.filter(p => p.workspaceId === w.id),
												[...(w.pending_prompt ? [w.pending_prompt] : []), ...(w.parked_prompts ?? [])],
												workingHint !== undefined && Date.now() - workingHint < WORKING_HINT_MS
											)
											return (
												<li key={w.id} className="fade-in">
													{/* Tighter than the shared `.card` (px-4 py-3.5): this row is the one
													    card the app draws by the dozen, and the nav already pads it by 12px,
													    so the card's own inset was double-spending the phone's narrow rail.
													    `p-2` sits in the utilities layer, which is what lets it win. */}
													<button
														type="button"
														className={cn(
															'card w-full px-3 py-2.5',
															w.id === selectedId ? 'border-accent/50 bg-surface-2' : unread && 'border-l-accent'
														)}
														onClick={() => open(w.id)}
													>
														<WorkspaceCard
															w={w}
															unread={unread}
															selected={w.id === selectedId}
															modelGroups={modelGroups}
															promptState={promptState}
														/>
													</button>
												</li>
											)
										})}
									</ul>
								)}
							</section>
						)
					})
				)}
			</nav>
			{connectOpen ? (
				<ConnectSheet
					version={data?.version}
					onLogs={() => {
						setConnectOpen(false)
						setLogsOpen(true)
					}}
					onClose={() => setConnectOpen(false)}
				/>
			) : null}
			{newOpen ? <NewWorkspaceSheet onClose={() => setNewOpen(false)} /> : null}
			{searchOpen ? (
				<SearchSheet
					live={workspaces}
					selectedId={selectedId}
					onOpen={(id, sessionId) => {
						setSearchOpen(false)
						open(id, sessionId)
					}}
					onClose={() => setSearchOpen(false)}
				/>
			) : null}
			{logsOpen ? <LogsSheet onClose={() => setLogsOpen(false)} /> : null}
			{usageOpen ? <PlanUsageSheet onClose={() => setUsageOpen(false)} /> : null}
		</div>
	)
}

/** Status glyph for group headers — backlog is hollow, like the desktop sidebar. */
function GroupDot({ status }: { status?: string }) {
	if (!status) return null
	const color = STATUS_COLORS[status]
	if (!color) return <span className="dot size-2 border border-faint bg-transparent" />
	return <span className="dot size-2" style={{ background: color }} />
}

/** The desktop sidebar's Group by / Repo / Sort by popover. */
function ViewControls({ repos, view, onClose }: { repos: RepoChoice[]; view: ViewPrefs; onClose: () => void }) {
	const setView = useApp(s => s.setView)
	return (
		<>
			<div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
			<div className="fade-in absolute right-2 top-full z-30 mt-1 flex w-64 flex-col gap-2.5 rounded-2xl border border-border bg-surface p-3 shadow-xl">
				<ControlRow id="view-group" label="Group by">
					<ViewSelect
						id="view-group"
						value={view.groupBy}
						onChange={v => setView({ groupBy: v as GroupBy })}
						options={[
							['status', 'Status'],
							['recent', 'Recent'],
							['repo', 'Repo'],
							['none', 'None']
						]}
					/>
				</ControlRow>
				<RepoFilter repos={repos} selected={view.repos} onChange={repos => setView({ repos })} />
				<ControlRow id="view-sort" label="Sort by">
					<ViewSelect
						id="view-sort"
						value={view.sortBy}
						onChange={v => setView({ sortBy: v as SortBy })}
						options={[
							['updated', 'Updated'],
							['created', 'Created'],
							['name', 'Name']
						]}
					/>
				</ControlRow>
				{/* Two toggles, because the two claims disagree in both directions: merged is
				    read off the PR on GitHub (`isMerged`), Done is the status somebody set
				    (`isDone`), and either one alone leaves finished work in the list. */}
				<ControlRow id="view-hide-merged" label="Hide merged">
					<ViewSwitch
						id="view-hide-merged"
						checked={view.hideMerged}
						label="Hide workspaces whose PR has merged"
						onChange={v => setView({ hideMerged: v })}
					/>
				</ControlRow>
				<ControlRow id="view-hide-done" label="Hide done">
					<ViewSwitch
						id="view-hide-done"
						checked={view.hideDone}
						label="Hide workspaces marked Done"
						onChange={v => setView({ hideDone: v })}
					/>
				</ControlRow>
			</div>
		</>
	)
}

function RepoFilter({
	repos,
	selected,
	onChange
}: {
	repos: RepoChoice[]
	selected: string[]
	onChange: (repos: string[]) => void
}) {
	const [open, setOpen] = useState(false)

	return (
		<div className="flex flex-col gap-1.5">
			<ControlRow id="view-repo" label="Repo">
				<button
					id="view-repo"
					type="button"
					onClick={() => setOpen(value => !value)}
					aria-expanded={open}
					aria-controls="view-repo-options"
					className="flex max-w-36 items-center gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
				>
					<span className="truncate">{repoFilterLabel(selected)}</span>
					<ChevronDown size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')} />
				</button>
			</ControlRow>
			{open ? (
				<div
					id="view-repo-options"
					className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-border bg-surface-2 py-0.5"
				>
					<RepoOptions repos={repos} selected={selected} onChange={onChange} />
				</div>
			) : null}
		</div>
	)
}

/** The popover's boolean row — same pill as the Connect sheet's, sized for this list. */
function ViewSwitch({
	id,
	checked,
	label,
	onChange
}: {
	id: string
	checked: boolean
	label: string
	onChange: (v: boolean) => void
}) {
	return (
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={cn(
				'relative h-6 w-11 shrink-0 rounded-full transition-colors',
				checked ? 'bg-accent' : 'border border-border bg-surface-2'
			)}
		>
			{/* `left-0.5` is load-bearing — see the note on the Connect sheet's twin. */}
			<span
				className={cn(
					'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
					checked ? 'translate-x-5' : 'translate-x-0'
				)}
			/>
		</button>
	)
}

function ControlRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 text-sm text-muted">
			<label htmlFor={id}>{label}</label>
			{children}
		</div>
	)
}

function ViewSelect({
	id,
	value,
	options,
	onChange
}: {
	id: string
	value: string
	options: [string, string][]
	onChange: (v: string) => void
}) {
	return (
		<select
			id={id}
			value={value}
			onChange={e => onChange(e.target.value)}
			className="max-w-36 truncate rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
		>
			{options.map(([v, label]) => (
				<option key={v} value={v}>
					{label}
				</option>
			))}
		</select>
	)
}

/**
 * The picker labels to name this workspace's model with. Its own agent's list when
 * that picker has been read, and otherwise everything the relay has ever seen — an
 * id that several of those labels could name resolves to none of them
 * (`format.ts` ▸ `modelLabel`), so the wider list can't produce a wrong name.
 */
function catalogFor(groups: CachedModelGroup[] | undefined, agentType: string | null): string[] {
	if (!groups?.length) return []
	const own = groups.find(g => g.agentType === (agentType ?? 'unknown'))
	return own?.models ?? [...new Set(groups.flatMap(g => g.models))]
}

function WorkspaceCard({
	w,
	unread,
	selected,
	modelGroups,
	promptState
}: {
	w: Workspace
	unread: number
	selected: boolean
	modelGroups: CachedModelGroup[] | undefined
	promptState: PromptIndicatorState
}) {
	const model = modelLabel(w.model, catalogFor(modelGroups, w.agent_type))
	return (
		<>
			{/* No `self-start`: it pinned the tile to the top of the text column and left it
			    high of the row's middle. Both lines beside it are single-line (truncate), so
			    the column can never grow and centring can never drift. */}
			<div className="relative shrink-0">
				<RepoAvatar icon={w.icon} name={w.repo_name || workspaceTitle(w)} artwork="full-bleed" />
				{/* `bg-surface` fills the spinner's hollow centre so the avatar doesn't show through it. */}
				<StatusDot
					w={w}
					promptState={promptState}
					className="absolute -right-0.5 -bottom-0.5 bg-surface ring-2 ring-surface"
				/>
			</div>
			<div className="min-w-0 flex-1 space-y-1.25 overflow-hidden">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-sm leading-none',
							unread ? 'font-bold' : 'font-medium',
							unread || selected ? 'text-text' : 'text-muted'
						)}
					>
						{workspaceTitle(w)}
					</span>
					{w.pinned_at ? <span className="shrink-0 text-xs text-faint">📌</span> : null}
					{/* Unread is a per-chat flag, so one unread chat has no number worth printing — a
					    dot says it; the count only appears once several chats here have news. */}
					{unread > 1 ? <Badge>{unread}</Badge> : unread ? <span className="dot size-2 bg-accent" /> : null}
				</div>
				{/* Context usage is *not* here: a workspace holds several chats and this card can only
				    speak for the active one, so the number read as the workspace's. It lives on the
				    chat tab that owns it (components/SessionView.tsx ▸ SessionTabs). */}
				{/* Age first: it is the one thing every row is scanned for, and the left edge is
				    where that scan already is. The model sits at the right edge, where a column
				    of marks reads at a glance and a long name has somewhere to truncate. */}
				<div className="flex min-w-0 items-end gap-2 text-xs text-muted">
					<span className="shrink-0 text-[11px] text-faint">{relativeAge(w.updated_at)}</span>
					{model ? (
						<span className="ml-auto flex min-w-0 items-center gap-1 text-[11px]">
							<ProviderMark agentType={w.agent_type} model={w.model} className="size-3" />
							<span className="truncate">{model}</span>
						</span>
					) : null}
				</div>
			</div>
		</>
	)
}
