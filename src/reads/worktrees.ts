import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const worktreeCache = new Map<string, string | null>()

/**
 * Resolve a workspace's worktree path. Conductor lays worktrees out as
 * `<workspacesRoot>/<repoName>/<directoryName>`, but we verify against
 * `git worktree list` (matched by branch) so a layout change can't silently
 * point us at the wrong tree.
 */
export function resolveWorktree(
	workspacesRoot: string,
	repoName: string | null,
	directoryName: string | null,
	branch: string | null,
	repoRoot: string | null
): string | null {
	if (repoName && directoryName) {
		const guess = path.join(workspacesRoot, repoName, directoryName)
		if (fs.existsSync(path.join(guess, '.git'))) return guess
	}
	if (!(repoRoot && branch)) return null
	const cacheKey = repoRoot
	let listing = worktreeCache.get(cacheKey)
	if (listing === undefined) {
		try {
			listing = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
				encoding: 'utf8',
				timeout: 5000
			})
		} catch {
			listing = null
		}
		worktreeCache.set(cacheKey, listing)
	}
	if (!listing) return null
	// Porcelain: blocks of "worktree <path>" / "branch refs/heads/<name>"
	const blocks = listing.split('\n\n')
	for (const block of blocks) {
		if (block.includes(`refs/heads/${branch}`)) {
			const m = block.match(/^worktree (.+)$/m)
			if (m) return m[1]
		}
	}
	return null
}
