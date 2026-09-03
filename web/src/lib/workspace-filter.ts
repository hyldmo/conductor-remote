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

/** Toggle one repo, collapsing an explicit full set back to the unrestricted state. */
export function toggleRepoFilter(available: readonly string[], selected: readonly string[], repo: string): string[] {
	const next = selected.includes(repo) ? selected.filter(name => name !== repo) : [...selected, repo]
	return available.length > 0 && available.every(name => next.includes(name)) ? [] : next
}
