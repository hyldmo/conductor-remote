import { ChevronDown, Plus, QrCode, SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { useWorkspaces } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import {
	isSettingUp,
	relativeTime,
	STATUS_ORDER,
	shortModel,
	workspaceLabel,
	workspaceStatus,
	workspaceStatusLabel
} from '../lib/format.ts'
import type { Workspace } from '../lib/types.ts'
import { type GroupBy, type SortBy, useApp, type ViewPrefs } from '../store.ts'
import { ConnectSheet } from './ConnectSheet.tsx'
import { Header } from './Header.tsx'
import { LogsSheet } from './LogsSheet.tsx'
import { NewWorkspaceSheet } from './NewWorkspaceSheet.tsx'
import { Badge, Chip, Empty, RepoAvatar, Spinner, StatusDot } from './ui.tsx'

/** Pinned first (matches the relay's order), then the chosen sort key. */
function sortWorkspaces(list: Workspace[], sortBy: SortBy): Workspace[] {
	return [...list].sort((a, b) => {
		const pin = Number(!!b.pinned_at) - Number(!!a.pinned_at)
		if (pin) return pin
		if (sortBy === 'name') return workspaceLabel(a).localeCompare(workspaceLabel(b))
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

function groupWorkspaces(list: Workspace[], groupBy: GroupBy): Group[] {
	if (groupBy === 'none') return [{ key: 'all', label: '', items: list }]
	const buckets = new Map<string, Workspace[]>()
	for (const w of list) {
		const key = groupBy === 'status' ? workspaceStatus(w) : (w.repo_name ?? '')
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
	return [...buckets.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map(r => ({ key: `repo:${r}`, label: r || 'No repo', items: buckets.get(r) ?? [] }))
}

/** Workspace list — floating drawer on phones, persistent left rail on md+. */
export function WorkspaceList({ selectedId }: { selectedId?: string }) {
	const navigate = useNavigate()
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	const view = useApp(s => s.view)
	const toggleGroup = useApp(s => s.toggleGroup)
	const [controlsOpen, setControlsOpen] = useState(false)
	const [connectOpen, setConnectOpen] = useState(false)
	const [newOpen, setNewOpen] = useState(false)
	const [logsOpen, setLogsOpen] = useState(false)
	const { data, isLoading, isError, error } = useWorkspaces()
	const workspaces = data?.workspaces ?? []

	const repos = [...new Set(workspaces.map(w => w.repo_name).filter((r): r is string => !!r))].sort()
	if (view.repo && !repos.includes(view.repo)) repos.push(view.repo)
	const shown = view.repo ? workspaces.filter(w => w.repo_name === view.repo) : workspaces
	const groups = groupWorkspaces(sortWorkspaces(shown, view.sortBy), view.groupBy)

	const open = (id: string) => {
		navigate(`/w/${id}`)
		setSidebarOpen(false)
	}

	const subtitle = workspaces.length
		? view.repo
			? `${shown.length} of ${workspaces.length} · ${view.repo}`
			: `${workspaces.length} active`
		: undefined

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden">
			<div className="relative">
				<Header
					title="Workspaces"
					subtitle={subtitle}
					right={
						<>
							<button
								type="button"
								onClick={() => setNewOpen(true)}
								aria-label="New workspace"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<Plus size={20} />
							</button>
							<button
								type="button"
								onClick={() => setControlsOpen(o => !o)}
								aria-label="View options"
								className="relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<SlidersHorizontal size={18} />
								{view.repo ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
							</button>
							<button
								type="button"
								onClick={() => setConnectOpen(true)}
								aria-label="Connect a device"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
							>
								<QrCode size={18} />
							</button>
							<button
								type="button"
								onClick={() => setSidebarOpen(false)}
								aria-label="Close workspaces"
								className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 md:hidden"
							>
								<X size={20} />
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
					<Empty>
						{(error as Error)?.message}
						<br />
						<br />
						Check the relay is running and the token is correct.
					</Empty>
				) : workspaces.length === 0 ? (
					<Empty>No active workspaces. Start one in Conductor and it’ll appear here.</Empty>
				) : shown.length === 0 ? (
					<Empty>No workspaces in {view.repo}.</Empty>
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
										{g.items.map(w => (
											<li key={w.id} className="fade-in">
												<button
													type="button"
													className={cn(
														'card w-full',
														w.id === selectedId ? 'border-accent/50 bg-surface-2' : w.unread && 'border-l-accent'
													)}
													onClick={() => open(w.id)}
												>
													<WorkspaceCard w={w} selected={w.id === selectedId} />
												</button>
											</li>
										))}
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
			{logsOpen ? <LogsSheet onClose={() => setLogsOpen(false)} /> : null}
		</div>
	)
}

/** Status glyph for group headers — backlog is hollow, like the desktop sidebar. */
function GroupDot({ status }: { status?: string }) {
	if (!status) return null
	const colors: Record<string, string> = {
		done: 'var(--color-done)',
		'in-review': 'var(--color-idle)',
		'in-progress': 'var(--color-working)',
		'setting-up': 'var(--color-working)'
	}
	const color = colors[status]
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
							['repo', 'Repo'],
							['none', 'None']
						]}
					/>
				</ControlRow>
				<ControlRow id="view-repo" label="Repo">
					<ViewSelect
						id="view-repo"
						value={view.repo ?? 'all'}
						onChange={v => setView({ repo: v === 'all' ? null : v })}
						options={[['all', 'All repos'], ...repos.map((r): [string, string] => [r, r])]}
					/>
				</ControlRow>
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
			</div>
		</>
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

function WorkspaceCard({ w, selected }: { w: Workspace; selected: boolean }) {
	const model = shortModel(w.model)
	const ctx = w.context_used_percent
	return (
		<>
			<div className="relative shrink-0 self-start">
				<RepoAvatar icon={w.icon} name={w.repo_name || workspaceLabel(w)} />
				{/* `bg-surface` fills the spinner's hollow centre so the avatar doesn't show through it. */}
				<StatusDot w={w} className="absolute -right-0.5 -bottom-0.5 bg-surface ring-2 ring-surface" />
			</div>
			<div className="min-w-0 flex-1 overflow-hidden">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							'min-w-0 flex-1 truncate',
							w.unread ? 'font-bold' : 'font-medium',
							w.unread || selected ? 'text-text' : 'text-muted'
						)}
					>
						{workspaceLabel(w)}
					</span>
					{isSettingUp(w) ? (
						<span className="shrink-0 rounded-md bg-working/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-working">
							Setting up
						</span>
					) : null}
					{w.pinned_at ? <span className="shrink-0 text-xs text-faint">📌</span> : null}
					{w.unread ? <Badge>{w.unread}</Badge> : null}
				</div>
				{/* Row 1: repo + branch (branch flexes to fill and truncates). Row 2: model · ctx · time. */}
				<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
					{w.repo_name ? <span className="shrink-0 font-mono text-faint">{w.repo_name}</span> : null}
					{w.branch ? <Chip className="min-w-0 flex-1 truncate">{w.branch}</Chip> : null}
				</div>
				<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
					{model ? <Chip>{model}</Chip> : null}
					{typeof ctx === 'number' && ctx > 0 ? (
						<span className="shrink-0 text-faint">{Math.round(ctx)}% ctx</span>
					) : null}
					<span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">{relativeTime(w.updated_at)}</span>
				</div>
			</div>
		</>
	)
}
