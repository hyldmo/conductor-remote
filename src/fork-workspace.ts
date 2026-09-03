/**
 * Carry one worktree's current files into a freshly-created Conductor workspace.
 *
 * The source index is user state, so taking a snapshot must not stage, unstage or
 * otherwise touch it. An alternate index starts at the source index, absorbs the
 * worktree with `git add -A`, and writes an immutable tree object. Private refs keep
 * every captured layer alive until Conductor has created the destination worktree.
 *
 * Materialising is the inverse: restore the captured worktree tree, source index and
 * source HEAD onto Conductor's freshly-created branch. That preserves committed,
 * staged, unstaged and untracked state — the same layers Conductor's own checkpointer
 * records for a native "fork with code".
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000
const STALE_REF_MS = 24 * 60 * 60 * 1000

export interface ForkWorkspaceSnapshot {
	/** Git tree containing the source's tracked and untracked-not-ignored files. */
	tree: string
	/** Source commit the destination branch should start from. */
	head: string
	/** The source's staged state, restored after the worktree tree. */
	indexTree: string
	/** Private ref prefix retaining all three objects until the destination has taken them. */
	ref: string
	/** Canonical common object directory; source and destination must share it. */
	commonDir: string
}

function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env }
	// A relay launched from inside another Git command must still address the worktree
	// passed to `-C`, not the repository its parent exported in these variables.
	delete env.GIT_DIR
	delete env.GIT_WORK_TREE
	delete env.GIT_COMMON_DIR
	delete env.GIT_INDEX_FILE
	return { ...env, ...extra }
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	const { stdout } = await exec('git', ['-C', cwd, ...args], {
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
		timeout: GIT_TIMEOUT_MS,
		env: cleanGitEnv(env)
	})
	return stdout.trim()
}

async function commonGitDirectory(worktree: string): Promise<string> {
	const common = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
	return fs.realpathSync(common)
}

async function assertWorktreeRoot(worktree: string): Promise<void> {
	const root = await git(worktree, ['rev-parse', '--show-toplevel'])
	if (fs.realpathSync(root) !== fs.realpathSync(worktree)) {
		throw new Error(`Git resolved the workspace to an ancestor repository (${root})`)
	}
}

async function gitOperation(worktree: string): Promise<string | null> {
	for (const [name, marker] of [
		['rebase', 'rebase-merge'],
		['rebase', 'rebase-apply'],
		['merge', 'MERGE_HEAD'],
		['cherry-pick', 'CHERRY_PICK_HEAD'],
		['revert', 'REVERT_HEAD']
	] as const) {
		const resolved = await git(worktree, ['rev-parse', '--git-path', marker])
		if (fs.existsSync(path.isAbsolute(resolved) ? resolved : path.join(worktree, resolved))) return name
	}
	return null
}

/** A hard-killed relay cannot run `finally`; the next capture reclaims its refs. */
async function pruneForkWorkspaceRefs(worktree: string): Promise<void> {
	const refs = await git(worktree, ['for-each-ref', '--format=%(refname)', 'refs/conductor-remote/forks'])
	for (const ref of refs.split('\n').filter(Boolean)) {
		const match = ref.match(/^refs\/conductor-remote\/forks\/(\d+)-[^/]+\/(?:head|index|worktree)$/)
		if (!match || Date.now() - Number(match[1]) <= STALE_REF_MS) continue
		await git(worktree, ['update-ref', '-d', ref]).catch(() => undefined)
	}
}

/**
 * Snapshot the files visible to Git without changing the source's real index.
 * Ignored build output stays behind; tracked files and ordinary untracked files go.
 */
export async function captureForkWorkspace(worktree: string): Promise<ForkWorkspaceSnapshot> {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-fork-'))
	const index = path.join(temp, 'index')
	const alternateIndex = { GIT_INDEX_FILE: index }
	try {
		await assertWorktreeRoot(worktree)
		const [commonDir, head, conflicts, operation] = await Promise.all([
			commonGitDirectory(worktree),
			git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
			git(worktree, ['ls-files', '-u']),
			gitOperation(worktree)
		])
		if (!head) throw new Error('the source workspace has no commit to fork')
		if (operation) throw new Error(`the source workspace is in the middle of a Git ${operation}`)
		if (conflicts) throw new Error('the source workspace has unresolved Git conflicts')
		await pruneForkWorkspaceRefs(worktree)
		// Seed from the real index rather than HEAD. A newly-staged file may already
		// match .gitignore; `git add` keeps it only when the alternate index knows it
		// is tracked, which is the same subtlety Conductor's checkpointer handles.
		const indexTree = await git(worktree, ['write-tree'])
		await git(worktree, ['read-tree', indexTree], alternateIndex)
		await git(worktree, ['add', '-A', '--', '.'], alternateIndex)
		const tree = await git(worktree, ['write-tree'], alternateIndex)
		const ref = `refs/conductor-remote/forks/${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
		const retained = [
			[`${ref}/head`, head],
			[`${ref}/index`, indexTree],
			[`${ref}/worktree`, tree]
		] as const
		try {
			for (const [name, object] of retained) await git(worktree, ['update-ref', name, object])
		} catch (err) {
			for (const [name, object] of retained) {
				await git(worktree, ['update-ref', '-d', name, object]).catch(() => undefined)
			}
			throw err
		}
		return { tree, head, indexTree, ref, commonDir }
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
}

/**
 * Replace a brand-new destination with the captured Git layers. The destination keeps
 * its new branch name, but that branch moves to the source commit and receives the
 * source's staged/unstaged state. Refuse any prior destination change: even during
 * setup, silently erasing work is the wrong race.
 */
export async function materializeForkWorkspace(snapshot: ForkWorkspaceSnapshot, worktree: string): Promise<void> {
	await assertWorktreeRoot(worktree)
	const commonDir = await commonGitDirectory(worktree)
	if (commonDir !== snapshot.commonDir) {
		throw new Error('the new workspace belongs to a different Git repository')
	}
	const dirty = await git(worktree, ['status', '--porcelain=v1'])
	if (dirty) throw new Error('the new workspace changed files before the fork snapshot could be installed')

	const destinationHead = await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
	await git(worktree, ['read-tree', '--reset', '-u', snapshot.tree])
	const installed = await git(worktree, ['write-tree'])
	if (installed !== snapshot.tree) throw new Error('Git did not install the complete fork snapshot')
	// Restore the source index without touching those checked-out bytes, then move
	// only the destination branch ref. The branch name remains Conductor's own.
	await git(worktree, ['read-tree', '--reset', snapshot.indexTree])
	const staged = await git(worktree, ['write-tree'])
	if (staged !== snapshot.indexTree) throw new Error('Git did not restore the fork’s staged state')
	await git(worktree, ['update-ref', 'HEAD', snapshot.head, destinationHead])
	await git(worktree, ['update-index', '-q', '--refresh']).catch(() => undefined)
}

/** Drop the private reachability refs once the destination owns the files. */
export async function releaseForkWorkspace(snapshot: ForkWorkspaceSnapshot): Promise<void> {
	const errors: unknown[] = []
	for (const [suffix, object] of [
		['head', snapshot.head],
		['index', snapshot.indexTree],
		['worktree', snapshot.tree]
	] as const) {
		try {
			await git(snapshot.commonDir, [
				'--git-dir',
				snapshot.commonDir,
				'update-ref',
				'-d',
				`${snapshot.ref}/${suffix}`,
				object
			])
		} catch (err) {
			errors.push(err)
		}
	}
	if (errors.length) throw errors[0]
}
