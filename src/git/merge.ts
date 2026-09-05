import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Workspace } from '../reads/types.ts'

const exec = promisify(execFile)

/**
 * Conductor's merge button, on the phone, in the intended flow: an agent opens
 * the PR, then you tap merge to merge *the PR*. This is a GitHub write via `gh`
 * (the same outward reach as src/git/pr.ts, which already reads PR state) — GitHub does
 * the merge server-side, so nothing local is pushed or checked out. The button
 * only exists when there's an open PR (see the PWA), so this never invents one.
 */

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export interface MergeResult {
	ok: boolean
	branch: string
	method?: MergeMethod
	error?: string
}

async function gh(root: string, args: string[]): Promise<string> {
	const { stdout } = await exec('gh', args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
	return stdout
}

/**
 * The repo's merge method, preferring squash (this project's convention), then a
 * merge commit, then rebase — whichever GitHub allows for the repo. Defaults to
 * squash if the query fails.
 */
async function preferredMethod(root: string): Promise<MergeMethod> {
	try {
		const out = await gh(root, ['repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'])
		const a = JSON.parse(out) as {
			squashMergeAllowed?: boolean
			mergeCommitAllowed?: boolean
			rebaseMergeAllowed?: boolean
		}
		if (a.squashMergeAllowed) return 'squash'
		if (a.mergeCommitAllowed) return 'merge'
		if (a.rebaseMergeAllowed) return 'rebase'
	} catch {
		// gh missing / not a GitHub repo → fall back; the merge call will surface any real error.
	}
	return 'squash'
}

/**
 * Merge the workspace's open PR. `gh pr merge <branch>` resolves the PR from its
 * head branch, so we need no PR number. We don't `--delete-branch` (the worktree
 * still has it checked out; Conductor deletes it on archive, not on merge) and
 * push nothing — GitHub performs the merge. Any GitHub-side refusal (checks,
 * reviews, conflicts, draft) comes back as a loud error.
 */
export async function mergePr(ws: Workspace): Promise<MergeResult> {
	const branch = ws.branch ?? ''
	const root = ws.repo_root
	if (!branch) return { ok: false, branch, error: 'workspace has no branch' }
	if (!root) return { ok: false, branch, error: 'repo root unresolved' }
	const method = await preferredMethod(root)
	try {
		await gh(root, ['pr', 'merge', branch, `--${method}`])
		return { ok: true, branch, method }
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr
		const message = (stderr || (err instanceof Error ? err.message : String(err))).trim()
		return { ok: false, branch, method, error: message }
	}
}
