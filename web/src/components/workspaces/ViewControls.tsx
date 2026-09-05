import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { RepoSelection } from '../../lib/workspace-filter.ts'
import { type GroupBy, type SortBy, useApp, type ViewPrefs } from '../../store.ts'
import { type RepoChoice, RepoOptions, repoFilterLabel } from './RepoFilter.tsx'

/** The desktop sidebar's Group by / Repo / Sort by popover. */
export function ViewControls({
	repos,
	view,
	summary,
	onClose
}: {
	repos: RepoChoice[]
	view: ViewPrefs
	summary?: string
	onClose: () => void
}) {
	const setView = useApp(s => s.setView)
	return (
		<>
			<div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-labelledby="workspace-filters-title"
				aria-describedby={summary ? 'workspace-filters-summary' : undefined}
				className="fade-in absolute right-2 top-full z-30 mt-1 flex w-64 flex-col gap-2.5 rounded-2xl border border-border bg-surface p-3 shadow-xl"
			>
				<div className="border-b border-border-soft pb-2">
					<h2 id="workspace-filters-title" className="text-sm font-semibold text-text">
						Workspace filters
					</h2>
					{summary ? (
						<p id="workspace-filters-summary" className="mt-0.5 text-xs text-muted">
							{summary}
						</p>
					) : null}
				</div>
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
				<RepoFilter
					repos={repos}
					selected={view.repoSelection}
					onChange={repoSelection => setView({ repoSelection })}
				/>
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
	selected: RepoSelection
	onChange: (selection: RepoSelection) => void
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
