import { Check, Minus } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '../lib/cn.ts'
import type { RepoIcon } from '../lib/types.ts'
import {
	ALL_REPOS,
	clearRepoFilter,
	type RepoSelection,
	repoIsSelected,
	toggleRepoFilter
} from '../lib/workspace-filter.ts'
import { RepoAvatar } from './ui.tsx'

export interface RepoChoice {
	name: string
	icon: RepoIcon | null
}

/** What a repo filter reads as on its button: every repo, the one repo, or how many. */
export function repoFilterLabel(selection: RepoSelection): string {
	if (selection.mode === 'all') return 'All repos'
	if (!selection.repos.length) return 'No repos'
	return selection.repos.length === 1 ? selection.repos[0] : `${selection.repos.length} repos`
}

/**
 * The multi-select behind both repo filters — the sidebar's View options and the
 * search sheet's. It follows a table's checkbox model: the master reflects the rows,
 * including its mixed state, and every row stays independently toggleable.
 */
export function RepoOptions({
	repos,
	selected,
	onChange
}: {
	repos: RepoChoice[]
	selected: RepoSelection
	onChange: (selection: RepoSelection) => void
}) {
	const selectedCount = repos.filter(repo => repoIsSelected(selected, repo.name)).length
	const allSelected = selected.mode === 'all' || (repos.length > 0 && selectedCount === repos.length)
	const partlySelected = !allSelected && selectedCount > 0
	const toggle = (repo: string) => {
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
			<RepoOption
				checked={allSelected}
				indeterminate={partlySelected}
				disabled={repos.length === 0}
				label="All repos"
				className="sticky top-0 z-[1] mb-0.5 border-b border-border-soft bg-inherit"
				onChange={() => onChange(allSelected ? clearRepoFilter() : ALL_REPOS)}
			/>
			{repos.map(repo => (
				<RepoOption
					key={repo.name}
					checked={repoIsSelected(selected, repo.name)}
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
	indeterminate = false,
	disabled = false,
	label,
	icon,
	className,
	onChange
}: {
	checked: boolean
	indeterminate?: boolean
	disabled?: boolean
	label: string
	icon?: ReactNode
	className?: string
	onChange: () => void
}) {
	const inputRef = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate
	}, [indeterminate])

	return (
		<label
			className={cn(
				'flex min-w-0 items-center gap-2 px-2 py-0.5 text-left text-sm text-text',
				disabled ? 'cursor-default opacity-50' : 'cursor-pointer active:bg-surface',
				className
			)}
		>
			<input
				ref={inputRef}
				type="checkbox"
				checked={checked}
				disabled={disabled}
				aria-checked={indeterminate ? 'mixed' : checked}
				onChange={onChange}
				className="peer sr-only"
			/>
			{icon ?? <span className="size-8 shrink-0" />}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span
				className={cn(
					'flex size-4 shrink-0 items-center justify-center rounded border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
					checked || indeterminate ? 'border-accent bg-accent text-on-solid' : 'border-faint bg-surface'
				)}
			>
				{indeterminate ? (
					<Minus size={12} strokeWidth={3} aria-hidden />
				) : checked ? (
					<Check size={12} strokeWidth={3} aria-hidden />
				) : null}
			</span>
		</label>
	)
}
