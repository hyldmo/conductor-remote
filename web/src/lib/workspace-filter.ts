export function workspaceFilterSummary({
	total,
	shown,
	hidden,
	repoFiltered
}: {
	total: number
	shown: number
	hidden: number
	repoFiltered: boolean
}): string | undefined {
	if (!total) return undefined
	if (!repoFiltered && !hidden) return `${total} active`
	return [`${shown} of ${total}`, hidden ? `${hidden} hidden` : null].filter(Boolean).join(' · ')
}

/**
 * Repo scope cannot use an empty array for "all": the checkbox list also needs a
 * real empty state so clearing the master and choosing one repo is possible.
 */
export type RepoSelection = { mode: 'all' } | { mode: 'selected'; repos: string[] }

export const ALL_REPOS: RepoSelection = { mode: 'all' }

/** Read the explicit model, falling back to the old `[] = all` preference shape. */
export function parseRepoSelection(value: unknown, legacyValue?: unknown): RepoSelection {
	if (value && typeof value === 'object' && 'mode' in value) {
		if (value.mode === 'all') return ALL_REPOS
		if (value.mode === 'selected' && 'repos' in value && Array.isArray(value.repos)) {
			return { mode: 'selected', repos: value.repos.filter((repo): repo is string => typeof repo === 'string') }
		}
	}
	const legacyRepos = Array.isArray(legacyValue)
		? legacyValue.filter((repo): repo is string => typeof repo === 'string')
		: typeof legacyValue === 'string'
			? [legacyValue]
			: []
	return legacyRepos.length ? { mode: 'selected', repos: legacyRepos } : ALL_REPOS
}

export function selectedRepos(selection: RepoSelection): string[] {
	return selection.mode === 'selected' ? selection.repos : []
}

export function clearRepoFilter(): RepoSelection {
	return { mode: 'selected', repos: [] }
}

export function repoIsSelected(selection: RepoSelection, repo: string): boolean {
	return selection.mode === 'all' || selection.repos.includes(repo)
}

/**
 * Toggle a row against the effective set. From "all", this removes just that
 * row; completing an exact set collapses back to the future-proof all mode.
 */
export function toggleRepoFilter(available: readonly string[], selection: RepoSelection, repo: string): RepoSelection {
	const selected = selection.mode === 'all' ? [...available] : selection.repos
	const next = selected.includes(repo) ? selected.filter(name => name !== repo) : [...selected, repo]
	return available.length > 0 && available.every(name => next.includes(name))
		? ALL_REPOS
		: { mode: 'selected', repos: next }
}
