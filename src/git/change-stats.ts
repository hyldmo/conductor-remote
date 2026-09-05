import type { Workspace } from '../reads/types.ts'
import { type DiffStats, workspaceDiffStats } from './diff.ts'

/**
 * Git stats are local and cheap, but not cheap enough to run synchronously for every
 * workspace on the 2.5s state poll. Keep the last answer on the wire while a bounded
 * background queue refreshes it; this makes the sidebar live without letting dozens
 * of worktrees fork dozens of `git` processes at once. Working/updated rows stay hot;
 * an idle branch gets a slower safety refresh for edits made outside its agent.
 */
const WORKING_STALE_MS = 5_000
const IDLE_STALE_MS = 60_000
const MAX_CONCURRENT = 4

interface CacheEntry {
	at: number
	workspaceUpdatedAt: string
	stats: DiffStats | null
}

interface StatTask {
	key: string
	worktree: string
	base: string
	workspaceUpdatedAt: string
}

const cache = new Map<string, CacheEntry>()
const scheduled = new Set<string>()
const queue: StatTask[] = []
let active = 0

function taskKey(worktree: string, base: string): string {
	return `${worktree}\0${base}`
}

function pump(): void {
	while (active < MAX_CONCURRENT) {
		const task = queue.shift()
		if (!task) return
		active++
		void workspaceDiffStats(task.worktree, task.base)
			.then(
				stats => cache.set(task.key, { at: Date.now(), workspaceUpdatedAt: task.workspaceUpdatedAt, stats }),
				() => cache.set(task.key, { at: Date.now(), workspaceUpdatedAt: task.workspaceUpdatedAt, stats: null })
			)
			.finally(() => {
				active--
				scheduled.delete(task.key)
				pump()
			})
	}
}

function schedule(worktree: string, base: string, workspaceUpdatedAt: string): void {
	const key = taskKey(worktree, base)
	if (scheduled.has(key)) return
	scheduled.add(key)
	queue.push({ key, worktree, base, workspaceUpdatedAt })
	pump()
}

/** Attach cached line counts and queue stale worktrees for a background refresh. */
export function attachChangeStats(workspaces: Workspace[]): void {
	const now = Date.now()
	for (const workspace of workspaces) {
		if (!workspace.worktree) {
			workspace.change_stats = null
			continue
		}
		const key = taskKey(workspace.worktree, workspace.baseBranch)
		const hit = cache.get(key)
		workspace.change_stats = hit?.stats ?? null
		const staleMs = workspace.session_status === 'working' ? WORKING_STALE_MS : IDLE_STALE_MS
		if (!hit || hit.workspaceUpdatedAt !== workspace.updated_at || now - hit.at >= staleMs) {
			schedule(workspace.worktree, workspace.baseBranch, workspace.updated_at)
		}
	}
}
