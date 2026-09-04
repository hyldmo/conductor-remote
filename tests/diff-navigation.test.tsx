import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiffFile, Workspace, WorkspaceDiff } from '../src/wire.ts'
import { Patch } from '../web/src/components/Patch.tsx'
import { filesForScope, patchForFile, preparePatch, splitWorkspacePatch } from '../web/src/lib/diff.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { DiffFileViewer, DiffView } = await import('../web/src/components/DiffView.tsx')

const files: DiffFile[] = [
	{ path: 'one.ts', added: 1, removed: 0 },
	{ path: 'two.ts', added: 1, removed: 1 }
]

const patch = [
	'diff --git a/one.ts b/one.ts',
	'--- a/one.ts',
	'+++ b/one.ts',
	'@@ -0,0 +1 @@',
	'+one',
	'diff --git a/two.ts b/two.ts',
	'--- a/two.ts',
	'+++ b/two.ts',
	'@@ -1 +1 @@',
	'-old',
	'+two'
].join('\n')

const diff: WorkspaceDiff = {
	base: 'origin/main',
	mergeBase: null,
	files,
	patch,
	truncated: false,
	dirty: false,
	unpushed: false
}

const review = {
	workspace: { id: 'workspace-1', worktree: '/workspace' } as Workspace,
	query: { data: diff, isLoading: false, isError: false, error: null },
	filesQuery: {
		data: { files: ['three.ts', 'one.ts'], truncated: false },
		isLoading: false,
		isError: false,
		error: null
	},
	fileQuery: {
		data: { path: 'two.ts', patch: patch.slice(patch.indexOf('diff --git a/two.ts')) },
		isLoading: false,
		isError: false,
		error: null
	}
}

const renderReview = (scope: 'changed' | 'all') =>
	renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<DiffView review={review} scope={scope} selectedFile={null} onSelectFile={vi.fn()} />
		</QueryClientProvider>
	)

describe('diff file navigation', () => {
	it('switches between changed files and every previewable workspace file', () => {
		expect(filesForScope('changed', files, ['one.ts', 'three.ts'])).toBe(files)
		expect(filesForScope('all', files, ['three.ts', 'one.ts'])).toEqual([
			{ path: 'one.ts', added: 1, removed: 0 },
			{ path: 'three.ts', added: 0, removed: 0 }
		])
	})

	it('renders the selected scope in the file rail', () => {
		const changed = renderReview('changed')
		const all = renderReview('all')

		expect(changed).toContain('one.ts')
		expect(changed).toContain('two.ts')
		expect(changed).not.toContain('three.ts')
		expect(all).toContain('one.ts')
		expect(all).not.toContain('two.ts')
		expect(all).toContain('three.ts')
	})

	it('splits a workspace patch into independently viewable files', () => {
		const sections = splitWorkspacePatch(patch)

		expect(sections).toHaveLength(2)
		expect(sections[0]).toContain('a/one.ts')
		expect(sections[0]).not.toContain('a/two.ts')
		expect(sections[1]).toContain('a/two.ts')
	})

	it('renders only the file selected from an ordinary bounded workspace patch', () => {
		const selected = patchForFile(patch, files, 'two.ts')
		const html = renderToStaticMarkup(<Patch patch={selected ?? ''} />)

		expect(html).toContain('a/two.ts')
		expect(html).toContain('+two')
		expect(html).not.toContain('a/one.ts')
	})

	it('renders a selected file from its own patch response', () => {
		const truncatedReview = {
			...review,
			query: {
				...review.query,
				data: { ...diff, patch: patch.slice(0, patch.indexOf('diff --git a/two.ts')), truncated: true }
			}
		}
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<DiffFileViewer
					review={truncatedReview}
					filePath="two.ts"
					scope="changed"
					onSelectFile={vi.fn()}
					onShowFiles={vi.fn()}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>
		)

		expect(html).toContain('a/two.ts')
		expect(html).toContain('+two')
		expect(html).not.toContain('a/one.ts')
	})

	it('makes Conductor bare edit hunks renderable without losing their status', () => {
		const prepared = preparePatch('updated src/one.ts\n@@ -1 +1 @@\n-old\n+const one = 1', 'src/one.ts')

		expect(prepared.preamble).toBe('updated src/one.ts')
		expect(prepared.patch).toBe('--- src/one.ts\n+++ src/one.ts\n@@ -1 +1 @@\n-old\n+const one = 1')
	})
})
