import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { attachChangeStats } from '../src/change-stats.ts'
import { sumNumstat, workspaceDiff, workspaceDiffStats } from '../src/git.ts'
import type { Workspace } from '../src/reads.ts'

describe('workspace diff stats', () => {
	let repo = ''

	const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })

	beforeEach(() => {
		repo = mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-git-stats-'))
		git('init', '--quiet')
		git('config', 'user.email', 'test@example.com')
		git('config', 'user.name', 'Test')
		writeFileSync(path.join(repo, 'tracked.txt'), 'alpha\nbeta\n')
		git('add', 'tracked.txt')
		git('commit', '--quiet', '-m', 'base')
	})

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true })
	})

	test('counts committed-base, worktree, and untracked lines like the full diff', async () => {
		writeFileSync(path.join(repo, 'tracked.txt'), 'alpha changed\nbeta\ngamma\n')
		writeFileSync(path.join(repo, 'new.txt'), 'one\ntwo')
		writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]))

		const stats = await workspaceDiffStats(repo, 'HEAD')
		const full = await workspaceDiff(repo, 'HEAD')
		const fromFull = full.files.reduce(
			(total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
			{ added: 0, removed: 0 }
		)

		expect(stats).toEqual({ added: 4, removed: 1 })
		expect(stats).toEqual(fromFull)
	})

	test('ignores binary markers while summing numstat', () => {
		expect(sumNumstat('12\t3\tsrc/a.ts\n-\t-\tpublic/a.png\n')).toEqual({ added: 12, removed: 3 })
	})

	test('serves state immediately, then attaches the background result', async () => {
		writeFileSync(path.join(repo, 'tracked.txt'), 'alpha changed\nbeta\ngamma\n')
		const workspace = {
			worktree: repo,
			baseBranch: 'HEAD',
			updated_at: '2026-09-03 18:00:00',
			session_status: 'working'
		} as Workspace

		attachChangeStats([workspace])
		expect(workspace.change_stats).toBeNull()
		await vi.waitFor(() => {
			attachChangeStats([workspace])
			expect(workspace.change_stats).toEqual({ added: 2, removed: 1 })
		})
	})
})
