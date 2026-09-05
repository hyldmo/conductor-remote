import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { captureForkWorkspace, materializeForkWorkspace, releaseForkWorkspace } from '../../src/git/fork-workspace.ts'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function write(root: string, name: string, body: string): void {
	const file = path.join(root, name)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, body)
}

function repository(): { root: string; source: string; target: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-fork-test-'))
	roots.push(root)
	const primary = path.join(root, 'primary')
	const source = path.join(root, 'source')
	const target = path.join(root, 'target')
	fs.mkdirSync(primary)
	git(primary, 'init', '-q')
	git(primary, 'config', 'user.name', 'Conductor Remote Test')
	git(primary, 'config', 'user.email', 'test@conductor.remote')
	write(primary, '.gitignore', 'ignored.txt\nstaged-ignored.txt\n')
	write(primary, 'kept.txt', 'base\n')
	write(primary, 'deleted.txt', 'delete me\n')
	git(primary, 'add', '-A')
	git(primary, 'commit', '-qm', 'base')
	const base = git(primary, 'rev-parse', 'HEAD')
	git(primary, 'worktree', 'add', '-q', '-b', 'fork-source', source, base)
	git(primary, 'worktree', 'add', '-q', '-b', 'fork-target', target, base)
	return { root, source, target }
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('fork workspace snapshots', () => {
	test('preserves every source layer without touching its index or the destination branch name', async () => {
		const { source, target } = repository()

		// A committed source change is code too: the destination branch should move to
		// this source commit while keeping Conductor's newly assigned branch name.
		write(source, 'committed.txt', 'from a source commit\n')
		git(source, 'add', 'committed.txt')
		git(source, 'commit', '-qm', 'source moved on')

		// Preserve the source's real staged/unstaged distinction while snapshotting the
		// final bytes the next agent would actually see.
		write(source, 'kept.txt', 'staged version\n')
		git(source, 'add', 'kept.txt')
		write(source, 'kept.txt', 'working version\n')
		fs.rmSync(path.join(source, 'deleted.txt'))
		write(source, 'new.txt', 'untracked but useful\n')
		write(source, 'ignored.txt', 'local build output\n')
		write(source, 'staged-ignored.txt', 'staged version\n')
		git(source, 'add', '-f', 'staged-ignored.txt')
		write(source, 'staged-ignored.txt', 'working version\n')
		const sourceHead = git(source, 'rev-parse', 'HEAD')
		const sourceStatus = git(source, 'status', '--porcelain=v1')
		const sourceIndex = git(source, 'diff', '--cached')

		const snapshot = await captureForkWorkspace(source)
		expect(git(source, 'for-each-ref', '--format=%(objectname)', snapshot.ref).split('\n')).toEqual(
			expect.arrayContaining([snapshot.head, snapshot.indexTree, snapshot.tree])
		)
		await materializeForkWorkspace(snapshot, target)

		expect(fs.readFileSync(path.join(target, 'kept.txt'), 'utf8')).toBe('working version\n')
		expect(fs.readFileSync(path.join(target, 'committed.txt'), 'utf8')).toBe('from a source commit\n')
		expect(fs.readFileSync(path.join(target, 'new.txt'), 'utf8')).toBe('untracked but useful\n')
		expect(fs.readFileSync(path.join(target, 'staged-ignored.txt'), 'utf8')).toBe('working version\n')
		expect(fs.existsSync(path.join(target, 'deleted.txt'))).toBe(false)
		expect(fs.existsSync(path.join(target, 'ignored.txt'))).toBe(false)
		expect(git(target, 'rev-parse', 'HEAD')).toBe(sourceHead)
		expect(git(target, 'symbolic-ref', '--short', 'HEAD')).toBe('fork-target')
		expect(git(target, 'status', '--porcelain=v1')).toBe(sourceStatus)
		expect(git(target, 'diff', '--cached')).toBe(sourceIndex)

		// Capturing never staged the working copy or moved the source branch.
		expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead)
		expect(git(source, 'status', '--porcelain=v1')).toBe(sourceStatus)
		expect(git(source, 'diff', '--cached')).toBe(sourceIndex)

		await releaseForkWorkspace(snapshot)
		expect(git(source, 'for-each-ref', '--format=%(objectname)', snapshot.ref)).toBe('')
	})

	test('refuses to overwrite tracked files changed by destination setup', async () => {
		const { source, target } = repository()
		const snapshot = await captureForkWorkspace(source)
		write(target, 'kept.txt', 'setup changed this\n')

		await expect(materializeForkWorkspace(snapshot, target)).rejects.toThrow(/changed files/)
		expect(fs.readFileSync(path.join(target, 'kept.txt'), 'utf8')).toBe('setup changed this\n')
		await releaseForkWorkspace(snapshot)
	})

	test('refuses a destination from another repository', async () => {
		const sourceRepo = repository()
		const otherRepo = repository()
		const snapshot = await captureForkWorkspace(sourceRepo.source)

		await expect(materializeForkWorkspace(snapshot, otherRepo.target)).rejects.toThrow(/different Git repository/)
		expect(git(otherRepo.target, 'status', '--porcelain=v1')).toBe('')
		await releaseForkWorkspace(snapshot)
	})

	test('refuses to flatten an in-progress Git operation into a misleading snapshot', async () => {
		const { source } = repository()
		const marker = git(source, 'rev-parse', '--git-path', 'MERGE_HEAD')
		const mergeHead = path.isAbsolute(marker) ? marker : path.join(source, marker)
		fs.writeFileSync(mergeHead, `${git(source, 'rev-parse', 'HEAD')}\n`)

		await expect(captureForkWorkspace(source)).rejects.toThrow(/middle of a Git merge/)
	})
})
