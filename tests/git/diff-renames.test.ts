import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { workspaceDiff, workspaceFileDiff } from '../../src/git/diff.ts'
import { buildDiffFileTree, filesForScope, patchForFile } from '../../web/src/lib/diff.ts'

describe('renamed diff files', () => {
	let repo = ''
	const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
	const write = (file: string, content: string | Buffer) => {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
		writeFileSync(path.join(repo, file), content)
	}
	const commit = () => {
		git('add', '-A')
		git('commit', '--quiet', '-m', 'fixture')
		return git('rev-parse', 'HEAD').trim()
	}
	const rename = (from: string, to: string) => {
		mkdirSync(path.dirname(path.join(repo, to)), { recursive: true })
		git('mv', '--', from, to)
	}
	const content = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i}\n`).join('')

	beforeEach(() => {
		repo = mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-diff-renames-'))
		git('init', '--quiet')
		git('config', 'user.email', 'test@example.com')
		git('config', 'user.name', 'Test')
		git('config', 'commit.gpgsign', 'false')
		git('config', 'core.hooksPath', '/dev/null')
		git('config', 'diff.renames', 'true')
	})

	afterEach(() => rmSync(repo, { recursive: true, force: true }))

	test.each([
		['old.ts', 'new.ts'],
		['src/search.ts', 'src/search/coordinator.ts'],
		['src/old/file.ts', 'src/new/file.ts'],
		['src/old.ts', 'src/{literal => name}.ts'],
		['src/ældre\t"old"\nname.ts', 'src/nye\t"new"\nname.ts'],
		[':old[1].ts', ':new[1].ts']
	])('keeps real paths and rename patches for %s → %s', async (oldPath, newPath) => {
		write(oldPath, content)
		const base = commit()
		rename(oldPath, newPath)

		// Both an indexed rename and a committed rename compare against the same base.
		for (const committed of [false, true]) {
			if (committed) commit()
			const diff = await workspaceDiff(repo, base)
			expect(diff.files).toEqual([{ path: newPath, oldPath, added: 0, removed: 0 }])
			expect(filesForScope('all', diff.files, [newPath])).toEqual(diff.files)
			const selected = await workspaceFileDiff(repo, base, newPath)
			expect(selected?.path).toBe(newPath)
			expect(selected?.patch).toBe(diff.patch)
			expect(selected?.patch).toContain('rename from ')
			expect(selected?.patch).toContain('rename to ')
			expect(selected?.patch).not.toContain('new file mode')
		}
	})

	test('groups an edited move under its destination and keeps the selected patch aligned', async () => {
		const oldPath = 'src/search.ts'
		const newPath = 'src/search/coordinator.ts'
		write(oldPath, content)
		write('a-first.txt', 'first before\n')
		write('z-last.txt', 'last before\n')
		const base = commit()
		rename(oldPath, newPath)
		write(newPath, content.replace('const line10 = 10', 'const line10 = 42'))
		write('a-first.txt', 'first after\n')
		write('z-last.txt', 'last after\n')

		const diff = await workspaceDiff(repo, base)
		expect(diff.files).toContainEqual({ path: newPath, oldPath, added: 1, removed: 1 })
		expect(buildDiffFileTree(diff.files)[0]).toMatchObject({
			kind: 'folder',
			path: 'src',
			children: [
				{
					kind: 'folder',
					path: 'src/search',
					children: [{ kind: 'file', name: 'coordinator.ts', path: newPath }]
				}
			]
		})
		const aggregate = patchForFile(diff.patch, diff.files, newPath)
		const selected = await workspaceFileDiff(repo, base, newPath)
		expect(selected?.patch.trim()).toBe(aggregate?.trim())
		expect(selected?.patch).toContain(`rename from ${oldPath}`)
		expect(selected?.patch).toContain('-const line10 = 10')
		expect(selected?.patch).toContain('+const line10 = 42')
		expect(selected?.patch).not.toContain('a-first.txt')
		expect(selected?.patch).not.toContain('z-last.txt')
	})

	test('keeps binary renames as a single zero-line change', async () => {
		const binary = Buffer.from(`\0${'unchanged binary content'.repeat(32)}`)
		write('old.bin', binary)
		const base = commit()
		rename('old.bin', 'new.bin')
		write('new.bin', Buffer.concat([binary, Buffer.from('new chunk')]))

		const diff = await workspaceDiff(repo, base)
		expect(diff.files).toEqual([{ path: 'new.bin', oldPath: 'old.bin', added: 0, removed: 0 }])
		expect((await workspaceFileDiff(repo, base, 'new.bin'))?.patch).toBe(diff.patch)
	})

	test('preserves literal tracked and untracked names alongside a rename', async () => {
		const tracked = 'tracked\t"æ"\n{a => b}.ts'
		const untracked = 'untracked\t"ø"\n{a => b}.ts'
		write('old.ts', content)
		write(tracked, 'before\n')
		const base = commit()
		rename('old.ts', 'new.ts')
		write(tracked, 'after\n')
		write(untracked, 'new source\n')

		const diff = await workspaceDiff(repo, base)
		expect(diff.files).toHaveLength(3)
		expect(diff.files).toContainEqual({ path: tracked, added: 1, removed: 1 })
		expect(diff.files).toContainEqual({ path: untracked, added: 1, removed: 0 })
		for (const file of diff.files) {
			const selected = await workspaceFileDiff(repo, base, file.path)
			expect(selected?.patch.trim()).toBe(patchForFile(diff.patch, diff.files, file.path)?.trim())
		}
	})
})
