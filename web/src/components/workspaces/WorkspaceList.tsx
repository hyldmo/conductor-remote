import {
	ArrowDownUp,
	ChevronDown,
	CircleCheck,
	FileDiff,
	FolderTree,
	Gauge,
	GitMerge,
	LayoutList,
	ListFilter,
	type LucideIcon,
	Moon,
	PhoneCall,
	Plus,
	QrCode,
	ScrollText,
	Search,
	SlidersHorizontal,
	Sun,
	SunMoon,
	Workflow
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useModelCatalog, useRoles } from '../../hooks/agents.ts'
import { useWorkspaces } from '../../hooks/workspaces.ts'
import { cn } from '../../lib/cn.ts'
import { type Command, useCommandStore, useRegisterCommands } from '../../lib/commands.ts'
import { isDone, isMerged } from '../../lib/format.ts'
import { promptIndicator } from '../../lib/prompts/pending.ts'
import { unreadCount } from '../../lib/read.ts'
import { readThemePreference, type ThemePreference, writeThemePreference } from '../../lib/theme.ts'
import { ALL_REPOS, selectedRepos, workspaceFilterSummary } from '../../lib/workspace-filter.ts'
import { type GroupBy, type SortBy, useApp, WORKING_HINT_MS } from '../../store.ts'
import { PlanUsageSheet } from '../agents/PlanUsageSheet.tsx'
import { HeaderFrame } from '../Header.tsx'
import { RolesSettings } from '../orchestration/RolesSettings.tsx'
import { WorkflowSummary } from '../orchestration/WorkflowSummary.tsx'
import { SearchSheet } from '../search/SearchSheet.tsx'
import { ConnectSheet } from '../settings/ConnectSheet.tsx'
import { LogsSheet } from '../settings/LogsSheet.tsx'
import { Empty, RelayUnreachable, Spinner } from '../ui.tsx'
import { useVoiceCall } from '../voice/VoiceProvider.tsx'
import { groupWorkspaces, sortWorkspaces } from './grouping.ts'
import { NewWorkspaceSheet } from './NewWorkspaceSheet.tsx'
import { type RepoChoice, repoFilterLabel } from './RepoFilter.tsx'
import { ViewControls } from './ViewControls.tsx'
import { GroupDot, WorkspaceCard } from './WorkspaceCard.tsx'
import { workspaceHasWorkflow } from './WorkspaceRunLabel.tsx'

/** Workspace list — floating drawer on phones, persistent left rail on md+. */
export function WorkspaceList({ selectedId }: { selectedId?: string }) {
	const navigate = useNavigate()
	const voice = useVoiceCall()
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
	const [rolesOpen, setRolesOpen] = useState(false)
	const searchOpen = useCommandStore(s => s.open)
	const setSearchOpen = useCommandStore(s => s.setOpen)
	const [theme, setTheme] = useState(readThemePreference)
	const { data, isLoading, isError, error } = useWorkspaces()
	const workspaces = data?.workspaces ?? []
	const unboundWorkflows = (data?.workflows ?? []).filter(workflow => !workflow.workspaceId)
	// Conductor's own names for the models these rows run on, read once for the whole
	// list: the catalog is a single cached request, while a hook per card would be one
	// subscription per row on a list that re-reads every 2.5s. It costs no UI trip —
	// `GET /api/models` serves what the picker was last seen holding.
	const modelGroups = useModelCatalog().data?.groups
	// Managed runs carry their frozen roles in `/api/state`; only pre-coordinator
	// Workflow roots need today's configured roles to reconstruct their icon stack.
	const needsLegacyWorkflowRoles = workspaces.some(
		workspace => !workspace.workflow && !workspace.workflow_identity && workspaceHasWorkflow(workspace)
	)
	const workflowRoles = useRoles(needsLegacyWorkflowRoles).data?.roles

	// The theme is device-local and the Connect sheet edits it too, so re-read it as the
	// palette opens rather than trust a copy taken at mount.
	useEffect(() => {
		if (searchOpen) setTheme(readThemePreference())
	}, [searchOpen])

	const repoIcons = new Map(workspaces.map(w => [w.repo_name, w.icon] as const))
	const selectedRepoNames = selectedRepos(view.repoSelection)
	const repos: RepoChoice[] = [
		...new Set([...workspaces.map(w => w.repo_name).filter((r): r is string => !!r), ...selectedRepoNames])
	]
		.sort()
		.map(name => ({ name, icon: repoIcons.get(name) ?? null }))
	const inRepo =
		view.repoSelection.mode === 'all'
			? workspaces
			: workspaces.filter(w => !!w.repo_name && selectedRepoNames.includes(w.repo_name))
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

	// The dot marks the *setting*; the filter popover's subtitle only speaks up once a
	// filter actually took something out, or "Hide merged" with nothing merged would
	// read as "40 of 40". Keep repo scope out of this summary: the picker directly below
	// already says which repos are selected.
	const repoFiltered = view.repoSelection.mode === 'selected'
	const filtered = repoFiltered || view.hideMerged || view.hideDone

	// The palette's rows for the sheets this toolbar opens and the switches inside View
	// options (`lib/commands.ts`). Registered here because this component is always
	// mounted and holds every setter involved; toggles read the store as they run, so a
	// row cannot flip a value it was built against.
	const setView = useApp(s => s.setView)
	const voiceActive = voice.status !== 'idle'
	const openPanel = voice.openPanel
	const commands = useMemo<Command[]>(() => {
		const groups: [GroupBy, string][] = [
			['status', 'Status'],
			['recent', 'Recent'],
			['repo', 'Repo'],
			['none', 'None']
		]
		const sorts: [SortBy, string][] = [
			['updated', 'Updated'],
			['created', 'Created'],
			['name', 'Name']
		]
		const themes: [ThemePreference, string, LucideIcon][] = [
			['system', 'System', SunMoon],
			['light', 'Light', Sun],
			['dark', 'Dark', Moon]
		]
		return [
			{
				id: 'app.search',
				label: 'Search chats and actions',
				group: 'App',
				hidden: true,
				shortcut: { key: 'k', mod: true },
				run: () => setSearchOpen(open => !open)
			},
			{
				id: 'app.newWorkspace',
				label: 'New workspace',
				group: 'App',
				icon: Plus,
				keywords: ['create', 'start', 'repo', 'branch'],
				run: () => setNewOpen(true)
			},
			{
				id: 'app.usage',
				label: 'Plan usage',
				group: 'App',
				icon: Gauge,
				keywords: ['models', 'quota', 'limits', 'rate', 'effort', 'defaults'],
				run: () => setUsageOpen(true)
			},
			{
				id: 'app.connect',
				label: 'Connect a device',
				group: 'App',
				icon: QrCode,
				keywords: ['qr', 'token', 'link', 'phone', 'pair', 'disconnect', 'notifications', 'push'],
				run: () => setConnectOpen(true)
			},
			{
				id: 'app.logs',
				label: 'Relay logs',
				group: 'App',
				icon: ScrollText,
				keywords: ['diagnostics', 'debug', 'errors'],
				run: () => setLogsOpen(true)
			},
			{
				id: 'app.roles',
				label: 'Delegated roles',
				group: 'App',
				icon: Workflow,
				keywords: ['workflow', 'planning', 'exploration', 'implementation', 'models'],
				run: () => setRolesOpen(true)
			},
			{
				id: 'app.controlRoom',
				label: voiceActive ? 'Open active call' : 'Control room',
				group: 'App',
				icon: PhoneCall,
				keywords: ['voice', 'call', 'fleet', 'orchestrator'],
				run: openPanel
			},
			...themes.map(
				([value, label, icon]): Command => ({
					id: `app.theme.${value}`,
					label: `Theme: ${label}`,
					group: 'App',
					icon,
					keywords: ['appearance', 'dark mode', 'light mode'],
					checked: theme === value,
					run: () => {
						writeThemePreference(value)
						setTheme(value)
					}
				})
			),
			{
				id: 'view.filters',
				label: 'Workspace filters',
				group: 'View',
				icon: SlidersHorizontal,
				keywords: ['view options', 'group', 'sort', 'repo'],
				run: () => {
					// The popover hangs off this toolbar, which on a phone may be in a closed drawer.
					setSidebarOpen(true)
					setControlsOpen(true)
				}
			},
			{
				id: 'view.hideMerged',
				label: 'Hide merged',
				group: 'View',
				icon: GitMerge,
				keywords: ['filter', 'pull request', 'pr', 'landed'],
				checked: view.hideMerged,
				run: () => setView({ hideMerged: !useApp.getState().view.hideMerged })
			},
			{
				id: 'view.hideDone',
				label: 'Hide done',
				group: 'View',
				icon: CircleCheck,
				keywords: ['filter', 'status', 'finished'],
				checked: view.hideDone,
				run: () => setView({ hideDone: !useApp.getState().view.hideDone })
			},
			{
				id: 'view.showDiffs',
				label: 'Sidebar diffs',
				group: 'View',
				icon: FileDiff,
				keywords: ['additions', 'deletions', 'line changes', 'stats'],
				checked: view.showDiffs,
				run: () => setView({ showDiffs: !useApp.getState().view.showDiffs })
			},
			{
				id: 'view.showFolders',
				label: 'Folders in the file rail',
				group: 'View',
				icon: FolderTree,
				keywords: ['diff', 'files', 'tree', 'group'],
				checked: view.showFolders,
				run: () => setView({ showFolders: !useApp.getState().view.showFolders })
			},
			{
				id: 'view.repos.all',
				label: 'Show all repos',
				group: 'View',
				icon: ListFilter,
				keywords: ['repo filter', 'clear', 'reset'],
				enabled: repoFiltered,
				run: () => setView({ repoSelection: ALL_REPOS })
			},
			...groups.map(
				([value, label]): Command => ({
					id: `view.groupBy.${value}`,
					label: `Group by: ${label}`,
					group: 'View',
					icon: LayoutList,
					keywords: ['sections', 'sidebar'],
					checked: view.groupBy === value,
					run: () => setView({ groupBy: value })
				})
			),
			...sorts.map(
				([value, label]): Command => ({
					id: `view.sortBy.${value}`,
					label: `Sort by: ${label}`,
					group: 'View',
					icon: ArrowDownUp,
					keywords: ['order', 'sidebar'],
					checked: view.sortBy === value,
					run: () => setView({ sortBy: value })
				})
			)
		]
	}, [
		theme,
		view.hideMerged,
		view.hideDone,
		view.showDiffs,
		view.showFolders,
		view.groupBy,
		view.sortBy,
		repoFiltered,
		voiceActive,
		openPanel,
		setView,
		setSearchOpen,
		setSidebarOpen
	])
	useRegisterCommands('sidebar', commands)

	const repoLabel = repoFilterLabel(view.repoSelection)
	const filterSummary = workspaceFilterSummary({
		total: workspaces.length,
		shown: shown.length,
		hidden,
		repoFiltered
	})

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden">
			<div className="relative">
				<HeaderFrame>
					{/* No close button. The drawer already closes four other ways — the scrim, an
					    edge swipe back, picking a workspace, the header toggle it opened from — and
					    on md+ it is a static rail that cannot close at all, so the X was a control
					    that did nothing half the time and cost a slot on the phone the whole time. */}
					<div
						role="toolbar"
						aria-label="Workspace controls"
						className="flex w-full items-center justify-between px-3 pb-2.5"
					>
						<button
							type="button"
							onClick={() => setSearchOpen(true)}
							aria-label="Search chats and actions"
							title="Search and actions (⌘K)"
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9"
						>
							<Search size={18} />
						</button>
						<button
							type="button"
							onClick={() => setUsageOpen(true)}
							aria-label="Models"
							title="Models"
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9"
						>
							<Gauge size={18} />
						</button>
						<button
							type="button"
							onClick={() => setControlsOpen(o => !o)}
							aria-label="View options"
							className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9"
						>
							<SlidersHorizontal size={18} />
							{filtered ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
						</button>
						<button
							type="button"
							onClick={() => setConnectOpen(true)}
							aria-label="Connect a device"
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9"
						>
							<QrCode size={18} />
						</button>
						<button
							type="button"
							onClick={() => setRolesOpen(true)}
							aria-label="Open delegated roles"
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9"
						>
							<Workflow size={18} />
						</button>
						<button
							type="button"
							onClick={voice.openPanel}
							aria-label={voice.status === 'idle' ? 'Call fleet orchestrator' : 'Open active call'}
							title="Control room"
							className={cn(
								'relative flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 min-[360px]:size-9',
								voice.status !== 'idle' && 'bg-voice-soft text-voice'
							)}
						>
							<PhoneCall size={18} />
							{voice.status !== 'idle' ? (
								<span className="absolute right-1 top-1 size-1.5 rounded-full bg-voice" />
							) : null}
						</button>
						{/* Last, and the only filled one: it is the thing you came here to do. */}
						<button
							type="button"
							onClick={() => setNewOpen(true)}
							aria-label="New workspace"
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-text active:bg-surface-2 min-[360px]:size-9"
						>
							<Plus size={20} />
						</button>
					</div>
				</HeaderFrame>
				{controlsOpen ? (
					<ViewControls repos={repos} view={view} summary={filterSummary} onClose={() => setControlsOpen(false)} />
				) : null}
			</div>
			<nav className="pb-safe min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
				{unboundWorkflows.length ? (
					<section className="mb-3 space-y-2" aria-label="Accepted workflows waiting for a workspace">
						<div className="px-1 text-xs font-semibold text-muted">Accepted workflows</div>
						{unboundWorkflows.map(workflow => (
							<WorkflowSummary key={workflow.id} workflow={workflow} compact />
						))}
					</section>
				) : null}
				{isLoading && !data ? (
					<Spinner label="Loading workspaces…" />
				) : isError ? (
					<RelayUnreachable error={error} />
				) : workspaces.length === 0 && !unboundWorkflows.length ? (
					<Empty>No active workspaces. Start one in Conductor and it’ll appear here.</Empty>
				) : workspaces.length > 0 && shown.length === 0 ? (
					<Empty>
						{repoFiltered
							? selectedRepoNames.length
								? `No workspaces in ${repoLabel}`
								: 'No repos selected'
							: 'No workspaces'}
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
															workflowRoles={workflowRoles}
															promptState={promptState}
															showDiffs={view.showDiffs}
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
			{rolesOpen ? <RolesSettings onClose={() => setRolesOpen(false)} /> : null}
		</div>
	)
}
