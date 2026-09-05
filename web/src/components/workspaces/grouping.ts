import {
	RECENT_BUCKETS,
	recentBucket,
	recentBucketLabel,
	STATUS_ORDER,
	timestampMs,
	workspaceStatus,
	workspaceStatusLabel,
	workspaceTitle
} from '../../lib/format.ts'
import type { Workspace } from '../../lib/types.ts'
import type { GroupBy, SortBy } from '../../store.ts'

/** Pinned first (matches the relay's order), then the chosen sort key. */
export function sortWorkspaces(list: Workspace[], sortBy: SortBy): Workspace[] {
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

export function groupWorkspaces(list: Workspace[], groupBy: GroupBy): Group[] {
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
