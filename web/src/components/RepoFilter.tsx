import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import type { RepoIcon } from '../lib/types.ts'
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
 * search sheet's. "All repos" is a real row rather than "nothing ticked", because a
 * list with every box empty reads as a filter that hides everything.
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
	const toggle = (repo: string) =>
		onChange(selected.includes(repo) ? selected.filter(r => r !== repo) : [...selected, repo])
	return (
		<>
			<RepoOption checked={selected.length === 0} label="All repos" onChange={() => onChange([])} />
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
