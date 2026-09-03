import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import type { RepoIcon } from '../lib/types.ts'
import { toggleRepoFilter } from '../lib/workspace-filter.ts'
import { RepoAvatar } from './ui.tsx'

export interface RepoChoice {
	name: string
	icon: RepoIcon | null
}

/** What a repo filter reads as on its button: every repo, the one repo, or how many. */
export function repoFilterLabel(selected: string[]): string {
	if (!selected.length) return 'All repos'
	return selected.length === 1 ? selected[0] : `${selected.length} repos`
}

/**
 * The multi-select behind both repo filters — the sidebar's View options and the
 * search sheet's. An empty selection means no repo constraint. Name that state in a
 * separate bulk-action strip rather than drawing a checked "All repos" checkbox beside
 * unchecked repo boxes, which makes the selection model look contradictory.
 */
export function RepoOptions({
	repos,
	selected,
	onChange
}: {
	repos: RepoChoice[]
	selected: string[]
	onChange: (repos: string[]) => void
}) {
	const selectedCount = repos.filter(repo => selected.includes(repo.name)).length
	const unrestricted = selected.length === 0
	const toggle = (repo: string) => {
		// Selecting the final repo is the unrestricted state, not a filter that happens
		// to name every current repo. Normalising it also clears the active-filter dot.
		onChange(
			toggleRepoFilter(
				repos.map(choice => choice.name),
				selected,
				repo
			)
		)
	}
	return (
		<>
			{unrestricted ? (
				<div className="sticky top-0 z-[1] mb-0.5 flex min-h-8 items-center justify-between gap-3 border-b border-border-soft bg-inherit px-2 text-xs">
					<span className="min-w-0 truncate text-faint">
						{repos.length ? `All ${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}` : 'No repos'}
					</span>
					{repos.length ? (
						<span className="flex shrink-0 items-center gap-1 font-medium text-muted">
							<Check size={12} strokeWidth={2.5} aria-hidden />
							Showing all
						</span>
					) : null}
				</div>
			) : (
				<button
					type="button"
					onClick={() => onChange([])}
					aria-label="Show all repos"
					className="sticky top-0 z-[1] mb-0.5 flex min-h-8 w-full items-center justify-between gap-3 border-b border-border-soft bg-inherit px-2 text-xs active:bg-surface"
				>
					<span className="min-w-0 truncate text-faint">
						{selectedCount} of {repos.length} repos
					</span>
					<span className="shrink-0 font-semibold text-accent">Show all</span>
				</button>
			)}
			{repos.map(repo => (
				<RepoOption
					key={repo.name}
					checked={selected.includes(repo.name)}
					label={repo.name}
					icon={<RepoAvatar icon={repo.icon} name={repo.name} artwork="inset" />}
					onChange={() => toggle(repo.name)}
				/>
			))}
		</>
	)
}

function RepoOption({
	checked,
	label,
	icon,
	onChange
}: {
	checked: boolean
	label: string
	icon?: ReactNode
	onChange: () => void
}) {
	return (
		<label className="flex min-w-0 cursor-pointer items-center gap-2 px-2 py-0.5 text-left text-sm text-text active:bg-surface">
			<input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
			{icon ?? <span className="size-8 shrink-0" />}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span
				className={cn(
					'flex size-4 shrink-0 items-center justify-center rounded border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
					checked ? 'border-accent bg-accent text-on-solid' : 'border-faint bg-surface'
				)}
			>
				{checked ? <Check size={12} strokeWidth={3} /> : null}
			</span>
		</label>
	)
}
