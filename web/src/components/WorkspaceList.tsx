import { Check, ChevronDown, Plus, QrCode, Search, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { useWorkspaces } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import {
	isMerged,
	RECENT_BUCKETS,
	recentBucket,
	recentBucketLabel,
	relativeTime,
	STATUS_COLORS,
	STATUS_ORDER,
	shortModel,
	workspaceStatus,
	workspaceStatusLabel,
	workspaceTitle
} from '../lib/format.ts'
import { unreadCount } from '../lib/read.ts'
import type { Workspace } from '../lib/types.ts'
import { type GroupBy, type SortBy, useApp, type ViewPrefs } from '../store.ts'
import { ConnectSheet } from './ConnectSheet.tsx'
import { Header } from './Header.tsx'
import { LogsSheet } from './LogsSheet.tsx'
import { NewWorkspaceSheet } from './NewWorkspaceSheet.tsx'
import { SearchSheet } from './SearchSheet.tsx'
import { Badge, Chip, Empty, RelayUnreachable, RepoAvatar, Spinner, StatusDot } from './ui.tsx'

/** Pinned first (matches the relay's order), then the chosen sort key. */
function sortWorkspaces(list: Workspace[], sortBy: SortBy): Workspace[] {
	return [...list].sort((a, b) => {
		const pin = Number(!!b.pinned_at) - Number(!!a.pinned_at)
		if (pin) return pin
		if (sortBy === 'name') return workspaceTitle(a).localeCompare(workspaceTitle(b))
		// SQLite datetime strings compare lexically; newest first.
		return sortBy === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)
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
	const toggleGroup = useApp(s => s.toggleGroup)
	const [controlsOpen, setControlsOpen] = useState(false)
	const [connectOpen, setConnectOpen] = useState(false)
	const [newOpen, setNewOpen] = useState(false)
	const [logsOpen, setLogsOpen] = useState(false)
	const [searchOpen, setSearchOpen] = useState(false)
	const { data, isLoading, isError, error } = useWorkspaces()
	const workspaces = data?.workspaces ?? []

	const repos = [
		...new Set([...workspaces.map(w => w.repo_name).filter((r): r is string => !!r), ...view.repos])
	].sort()
	const inRepo = view.repos.length
		? workspaces.filter(w => !!w.repo_name && view.repos.includes(w.repo_name))
		: workspaces
	// The workspace you're *in* is never hidden: the list is the way back to the chat on
	// screen, and a filter that swallows it reads as the app having lost your place.
	const shown = view.hideMerged ? inRepo.filter(w => !isMerged(w) || w.id === selectedId) : inRepo
	const hiddenMerged = inRepo.length - shown.length
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
	const filtered = view.repos.length > 0 || view.hideMerged
	const narrowed = view.repos.length > 0 || hiddenMerged > 0
	const repoFilterLabel = view.repos.length === 1 ? view.repos[0] : `${view.repos.length} repos`
	const subtitle = workspaces.length
		? narrowed
			? [
					`${shown.length} of ${workspaces.length}`,
					view.repos.length ? repoFilterLabel : null,
					hiddenMerged ? `${hiddenMerged} merged hidden` : null
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
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<Search size={18} />
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
						{view.repos.length ? `No workspaces in ${repoFilterLabel}` : 'No workspaces'}
						{hiddenMerged ? ` — ${hiddenMerged} merged ${hiddenMerged === 1 ? 'one is' : 'ones are'} hidden.` : '.'}
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
											return (
												<li key={w.id} className="fade-in">
													<button
														type="button"
														className={cn(
															'card w-full',
															w.id === selectedId ? 'border-accent/50 bg-surface-2' : unread && 'border-l-accent'
														)}
														onClick={() => open(w.id)}
													>
														<WorkspaceCard w={w} unread={unread} selected={w.id === selectedId} />
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
function ViewControls({ repos, view, onClose }: { repos: string[]; view: ViewPrefs; onClose: () => void }) {
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
				<ControlRow id="view-hide-merged" label="Hide merged">
					<ViewSwitch
						id="view-hide-merged"
						checked={view.hideMerged}
						label="Hide workspaces whose PR has merged"
						onChange={v => setView({ hideMerged: v })}
					/>
				</ControlRow>
				{/* Whose merge, exactly: ours, off `gh`, not Conductor's status — see `isMerged`.
				    Worth one line here because the two disagree often enough that a workspace
				    still sitting in "Done" after this is on looks like the toggle misfiring. */}
				<p className="-mt-1 text-faint text-xs">
					By the PR on GitHub, which can trail a merge by up to a minute — not by Conductor’s status.
				</p>
			</div>
		</>
	)
}

function RepoFilter({
	repos,
	selected,
	onChange
}: {
	repos: string[]
	selected: string[]
	onChange: (repos: string[]) => void
}) {
	const [open, setOpen] = useState(false)
	const selectedAll = selected.length === 0
	const label = selectedAll ? 'All repos' : selected.length === 1 ? selected[0] : `${selected.length} repos`
	const toggle = (repo: string) =>
		onChange(selected.includes(repo) ? selected.filter(r => r !== repo) : [...selected, repo])

	return (
		<div className="flex flex-col gap-2">
			<ControlRow id="view-repo" label="Repo">
				<button
					id="view-repo"
					type="button"
					onClick={() => setOpen(value => !value)}
					aria-expanded={open}
					aria-controls="view-repo-options"
					className="flex max-w-36 items-center gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
				>
					<span className="truncate">{label}</span>
					<ChevronDown size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')} />
				</button>
			</ControlRow>
			{open ? (
				<div
					id="view-repo-options"
					className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-border bg-surface-2 p-1"
				>
					<RepoOption checked={selectedAll} label="All repos" onChange={() => onChange([])} />
					{repos.map(repo => (
						<RepoOption key={repo} checked={selected.includes(repo)} label={repo} onChange={() => toggle(repo)} />
					))}
				</div>
			) : null}
		</div>
	)
}

function RepoOption({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
	return (
		<label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text active:bg-surface">
			<input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
			<span
				className={cn(
					'flex size-4 shrink-0 items-center justify-center rounded border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
					checked ? 'border-accent bg-accent text-white' : 'border-faint bg-surface'
				)}
			>
				{checked ? <Check size={12} strokeWidth={3} /> : null}
			</span>
			<span className="truncate">{label}</span>
		</label>
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
			className="max-w-36 truncate rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text [color-scheme:dark]"
		>
			{options.map(([v, label]) => (
				<option key={v} value={v}>
					{label}
				</option>
			))}
		</select>
	)
}

function WorkspaceCard({ w, unread, selected }: { w: Workspace; unread: number; selected: boolean }) {
	const model = shortModel(w.model)
	return (
		<>
			<div className="relative shrink-0 self-start">
				<RepoAvatar icon={w.icon} name={w.repo_name || workspaceTitle(w)} />
				{/* `bg-surface` fills the spinner's hollow centre so the avatar doesn't show through it. */}
				<StatusDot w={w} className="absolute -right-0.5 -bottom-0.5 bg-surface ring-2 ring-surface" />
			</div>
			<div className="min-w-0 flex-1 overflow-hidden">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							'min-w-0 flex-1 truncate leading-none',
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
				<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
					{model ? <Chip>{model}</Chip> : null}
					<span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">{relativeTime(w.updated_at)}</span>
				</div>
			</div>
		</>
	)
}
