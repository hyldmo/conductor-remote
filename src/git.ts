import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { isPreviewableSource } from './shared.ts'

const exec = promisify(execFile)

export interface DiffFile {
	path: string
	added: number
	removed: number
}

/** Aggregate line changes for the compact workspace-sidebar readout. */
export interface DiffStats {
	added: number
	removed: number
}

export interface WorkspaceDiff {
	base: string
	mergeBase: string | null
	files: DiffFile[]
	patch: string
	truncated: boolean
	/** Uncommitted changes in the worktree (drives the "Commit & push" action). */
	dirty: boolean
	/** Commits on HEAD not yet on the remote-tracking branch (also drives "Commit & push"). */
	unpushed: boolean
}

/** One changed file's complete patch, fetched independently of the aggregate preview cap. */
export interface WorkspaceFileDiff {
	path: string
	patch: string
}

const MAX_PATCH_BYTES = 400_000
const MAX_LISTED_FILES = 20_000

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec('git', ['-C', cwd, ...args], {
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
		timeout: 15000
	})
	return stdout
}

/** `git diff --no-index` reports an ordinary difference with exit code 1. */
async function noIndexDiff(cwd: string, file: string): Promise<string> {
	try {
		const { stdout } = await exec('git', ['-C', cwd, 'diff', '--no-index', '--no-color', '--', '/dev/null', file], {
			encoding: 'utf8',
			maxBuffer: 8 * 1024 * 1024,
			timeout: 10000
		})
		return stdout
	} catch (err) {
		return (err as { stdout?: string }).stdout ?? ''
	}
}

/**
 * Patch for untracked files. `git diff` ignores them, but a reviewer wants to
 * see new files — so we synthesize a "new file" diff via `--no-index` against
 * /dev/null. This never touches the index (no `add -N`), so the live worktree
 * the agent is using is left untouched.
 */
async function untrackedDiff(cwd: string): Promise<{ files: DiffFile[]; patch: string }> {
	let listing = ''
	try {
		listing = await git(cwd, ['ls-files', '--others', '--exclude-standard'])
	} catch {
		return { files: [], patch: '' }
	}
	const paths = listing.split('\n').filter(Boolean)
	const files: DiffFile[] = []
	const patches: string[] = []
	for (const p of paths) {
		const out = await noIndexDiff(cwd, p)
		if (!out) continue
		const added = out.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length
		files.push({ path: p, added, removed: 0 })
		patches.push(out)
	}
	return { files, patch: patches.join('') }
}

/**
 * Count untracked text without building the full patches used by the diff viewer.
 * `git diff` does not include these files until they enter the index, so each one
 * needs the same `/dev/null` comparison as `untrackedDiff`; `--numstat` keeps that
 * comparison to one short line even when the new file is large.
 */
async function untrackedStats(cwd: string): Promise<DiffStats> {
	let listing = ''
	try {
		listing = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
	} catch {
		return { added: 0, removed: 0 }
	}
	const stats = { added: 0, removed: 0 }
	for (const file of listing.split('\0').filter(Boolean)) {
		let out = ''
		try {
			out = await git(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', file])
		} catch (err) {
			// --no-index exits 1 for the ordinary "these differ" result.
			out = (err as { stdout?: string }).stdout ?? ''
		}
		const counted = sumNumstat(out)
		stats.added += counted.added
		stats.removed += counted.removed
	}
	return stats
}

/** Resolve the base ref, preferring the remote-tracking form if it exists. */
async function resolveBase(cwd: string, base: string): Promise<string> {
	for (const ref of [`origin/${base}`, base]) {
		try {
			await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
			return ref
		} catch {
			// try next
		}
	}
	return base
}

/** The commit a workspace diff compares its index and worktree against. */
async function diffBasis(
	cwd: string,
	base: string
): Promise<{ ref: string; mergeBase: string | null; against: string }> {
	const ref = await resolveBase(cwd, base)
	let mergeBase: string | null = null
	try {
		mergeBase = (await git(cwd, ['merge-base', ref, 'HEAD'])).trim()
	} catch {
		mergeBase = null
	}
	return { ref, mergeBase, against: mergeBase ?? ref }
}

/** Aggregate the numeric columns of `git diff --numstat`; binary-file dashes count as zero lines. */
export function sumNumstat(numstat: string): DiffStats {
	const stats = { added: 0, removed: 0 }
	for (const line of numstat.split('\n')) {
		if (!line) continue
		const [rawAdded, rawRemoved] = line.split('\t')
		const added = rawAdded === '-' ? 0 : Number(rawAdded)
		const removed = rawRemoved === '-' ? 0 : Number(rawRemoved)
		if (Number.isFinite(added)) stats.added += added
		if (Number.isFinite(removed)) stats.removed += removed
	}
	return stats
}

/**
 * The sidebar's cheap counterpart to `workspaceDiff`: the same base and the same
 * tracked + untracked semantics, without materialising up to 400 KB of patch text.
 */
export async function workspaceDiffStats(worktree: string, base: string): Promise<DiffStats> {
	const { against } = await diffBasis(worktree, base)
	const tracked = sumNumstat(await git(worktree, ['diff', '--numstat', against]).catch(() => ''))
	const untracked = await untrackedStats(worktree)
	return { added: tracked.added + untracked.added, removed: tracked.removed + untracked.removed }
}

/**
 * Everything the workspace changed relative to its target branch — committed
 * plus uncommitted — which is what a reviewer wants to see. Computed straight
 * from the worktree, so it's independent of Conductor entirely.
 */
export async function workspaceDiff(worktree: string, base: string): Promise<WorkspaceDiff> {
	const { ref, mergeBase, against } = await diffBasis(worktree, base)

	const numstat = await git(worktree, ['diff', '--numstat', against]).catch(() => '')
	const files: DiffFile[] = numstat
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [added, removed, ...rest] = line.split('\t')
			return {
				path: rest.join('\t'),
				added: added === '-' ? 0 : Number(added),
				removed: removed === '-' ? 0 : Number(removed)
			}
		})

	const trackedPatch = await git(worktree, ['diff', against]).catch(() => '')
	const untracked = await untrackedDiff(worktree)
	files.push(...untracked.files)

	let patch = trackedPatch + untracked.patch
	const truncated = patch.length > MAX_PATCH_BYTES
	if (truncated) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n… diff truncated (${patch.length} bytes) …`

	const { dirty, unpushed } = await localState(worktree)

	return { base: ref, mergeBase, files, patch, truncated, dirty, unpushed }
}

/**
 * The complete patch for one selected changed file. The phone asks for this separately
 * so a file remains reviewable even when its section follows the aggregate 400 KB cap.
 */
export async function workspaceFileDiff(
	worktree: string,
	base: string,
	requestedPath: string
): Promise<WorkspaceFileDiff | null> {
	if (!requestedPath || requestedPath.includes('\0') || path.isAbsolute(requestedPath)) return null

	const root = path.resolve(worktree)
	const relative = path.relative(root, path.resolve(root, requestedPath))
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null

	const { against } = await diffBasis(worktree, base)
	// A literal pathspec prevents a filename beginning with `:` from becoming Git pathspec syntax.
	const literalPathspec = `:(literal)${relative}`
	const tracked = await git(worktree, ['diff', '--no-color', against, '--', literalPathspec]).catch(() => '')
	if (tracked) return { path: relative, patch: tracked }

	// `git diff <base>` omits untracked files. Only synthesize a patch when Git says this
	// exact path is untracked and not ignored; never let the request name an arbitrary file.
	const untracked = await git(worktree, [
		'ls-files',
		'--others',
		'--exclude-standard',
		'-z',
		'--',
		literalPathspec
	]).catch(() => '')
	if (!untracked.split('\0').includes(relative)) return null

	const patch = await noIndexDiff(worktree, relative)
	return patch ? { path: relative, patch } : null
}

/**
 * Local publish state of the worktree: does it have uncommitted changes, and are
 * there commits not yet on its remote-tracking branch? Together these drive the
 * bar's "Commit & push" action (you must land local work before a PR reflects it).
 */
async function localState(worktree: string): Promise<{ dirty: boolean; unpushed: boolean }> {
	const status = await git(worktree, ['status', '--porcelain']).catch(() => '')
	const dirty = status.trim() !== ''
	let unpushed = false
	try {
		// `@{upstream}` throws when no upstream is configured — then there's nothing to compare against.
		const count = (await git(worktree, ['rev-list', '--count', '@{upstream}..HEAD'])).trim()
		unpushed = Number(count) > 0
	} catch {
		unpushed = false
	}
	return { dirty, unpushed }
}

/**
 * Every previewable source file in the worktree, shared by chat mention links and the
 * diff window's All-files rail.
 *
 * Agents name files in prose all day — "updated `tests/foo.ts`" — and the phone links
 * a mention only when it matches a real file. The same list lets a reviewer browse
 * source beyond the changed set. Tracked plus untracked-not-ignored: an agent that just
 * wrote a file should appear in both places long before anything commits it.
 *
 * Two things keep the payload small. Only previewable extensions ship, because
 * `/api/files` refuses everything else anyway, and 20,000 paths is the ceiling — a
 * repo whose build output isn't ignored would otherwise send its whole `node_modules`
 * to a phone. `-z`, because a path may legally contain a newline.
 */
export async function listSourceFiles(worktree: string): Promise<{ files: string[]; truncated: boolean }> {
	let listing = ''
	try {
		listing = await git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
	} catch {
		return { files: [], truncated: false }
	}
	const files = listing.split('\0').filter(p => p !== '' && isPreviewableSource(p))
	return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES }
}
