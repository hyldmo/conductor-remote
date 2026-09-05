import { describe, expect, it } from 'vitest'
import { buildResolver, resolveImageReference } from '../../web/src/lib/fileMentions.ts'

/**
 * Which words in a chat become source links (`web/src/lib/fileMentions.ts`).
 *
 * Both ways of getting this wrong are quiet. Too eager and the transcript underlines
 * ordinary prose — `sessions.status`, `Array.map` — each one opening a sheet that says
 * the file is not there, which reads as a broken relay rather than as a bad guess. Too
 * shy and the feature simply isn't there, which nobody reports. The matcher is pure, so
 * this needs no relay, no worktree and no browser.
 */
const WORKTREE = '/Users/someone/conductor/workspaces/project/berlin'
const FILES = [
	'package.json',
	'src/git.ts',
	'src/server.ts',
	'src/lib/types.ts',
	'tests/foo.test.ts',
	'web/src/lib/types.ts',
	'web/src/components/Markdown.tsx'
]
const resolve = buildResolver(WORKTREE, FILES)

describe('a mention of a file in the workspace', () => {
	it('resolves a worktree-relative path against the worktree', () => {
		expect(resolve('tests/foo.test.ts')).toBe(`${WORKTREE}/tests/foo.test.ts`)
		expect(resolve('./src/git.ts')).toBe(`${WORKTREE}/src/git.ts`)
		expect(resolve('package.json')).toBe(`${WORKTREE}/package.json`)
	})

	it('keeps the line an agent appended, so the sheet opens where it points', () => {
		expect(resolve('src/server.ts:1218')).toBe(`${WORKTREE}/src/server.ts:1218`)
		expect(resolve('src/server.ts:1218:7')).toBe(`${WORKTREE}/src/server.ts:1218:7`)
	})

	it('finds a file named by its tail, at a path boundary only', () => {
		expect(resolve('Markdown.tsx')).toBe(`${WORKTREE}/web/src/components/Markdown.tsx`)
		expect(resolve('components/Markdown.tsx')).toBe(`${WORKTREE}/web/src/components/Markdown.tsx`)
		// `arkdown.tsx` is a suffix of the string, not of the path.
		expect(resolve('arkdown.tsx')).toBeNull()
	})

	it('links nothing when two files answer to the same name', () => {
		expect(resolve('types.ts')).toBeNull()
		expect(resolve('lib/types.ts')).toBeNull()
		// Naming one of them exactly is not ambiguous.
		expect(resolve('web/src/lib/types.ts')).toBe(`${WORKTREE}/web/src/lib/types.ts`)
	})

	it('leaves ordinary code alone', () => {
		expect(resolve('sessions.status')).toBeNull()
		expect(resolve('yarn build')).toBeNull()
		expect(resolve('src/missing.ts')).toBeNull()
		expect(resolve('')).toBeNull()
		expect(resolve('https://example.com/app.ts')).toBeNull()
		expect(resolve('../outside/src/git.ts')).toBeNull()
	})
})

describe('a mention the file list cannot answer', () => {
	it('passes an absolute path through for the relay to allow or refuse', () => {
		// The expose-mode check lives in `src/files/file-preview.ts`, at open time. A path outside
		// the workspace is linked here and refused there, which is the same deal a Markdown
		// link has always had.
		expect(resolve('/Users/someone/other/app.ts')).toBe('/Users/someone/other/app.ts')
		expect(resolve('~/.gstack/plan.md')).toBe('~/.gstack/plan.md')
		expect(resolve('~/.gstack/plan.md:12')).toBe('~/.gstack/plan.md:12')
	})

	it('still refuses a path this relay could never preview', () => {
		expect(resolve('/usr/bin/env')).toBeNull()
		expect(resolve('/etc/hosts')).toBeNull()
	})

	it('resolves only absolute mentions for a workspace with no worktree', () => {
		const archived = buildResolver(null, undefined)
		expect(archived('src/git.ts')).toBeNull()
		expect(archived('/Users/someone/other/app.ts')).toBe('/Users/someone/other/app.ts')
	})
})

describe('an explicit Markdown image reference', () => {
	it('resolves project-relative and absolute raster images', () => {
		expect(resolveImageReference('./.context/qa/result.png', WORKTREE)).toBe(`${WORKTREE}/.context/qa/result.png`)
		expect(resolveImageReference('public/painted%20road.webp', WORKTREE)).toBe(`${WORKTREE}/public/painted road.webp`)
		expect(resolveImageReference('/Users/someone/conductor/workspaces/other/result.JPG', WORKTREE)).toBe(
			'/Users/someone/conductor/workspaces/other/result.JPG'
		)
	})

	it('rejects remote, escaping and executable paths, but still identifies an archived relative image', () => {
		expect(resolveImageReference('https://example.com/result.png', WORKTREE)).toBeNull()
		expect(resolveImageReference('../other/result.png', WORKTREE)).toBeNull()
		expect(resolveImageReference('./result.svg', WORKTREE)).toBeNull()
		expect(resolveImageReference('./result.png', null)).toBe('result.png')
	})
})
