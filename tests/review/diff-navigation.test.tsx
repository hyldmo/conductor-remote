import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiffFile, Workspace, WorkspaceDiff } from '../../src/wire.ts'
import { Patch } from '../../web/src/components/review/Patch.tsx'
import {
	buildDiffFileTree,
	filesForScope,
	filesInFlatOrder,
	filesInTreeOrder,
	patchForFile,
	preparePatch,
	splitWorkspacePatch
} from '../../web/src/lib/diff.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { DiffFileList, DiffFileViewer, DiffView } = await import('../../web/src/components/review/DiffView.tsx')

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
			<DiffView review={review} scope={scope} showFolders selectedFile={null} onSelectFile={vi.fn()} />
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

	it('groups files into sorted folders with aggregate change counts', () => {
		const nested: DiffFile[] = [
			{ path: 'README.md', added: 0, removed: 0 },
			{ path: 'src/index.ts', added: 4, removed: 1 },
			{ path: 'src/lib/file10.ts', added: 0, removed: 3 },
			{ path: 'src/lib/file2.ts', added: 2, removed: 0 },
			{ path: 'tests/diff.test.ts', added: 1, removed: 1 }
		]
		const tree = buildDiffFileTree(nested)

		expect(tree.map(node => `${node.kind}:${node.name}`)).toEqual(['folder:src', 'folder:tests', 'file:README.md'])
		const src = tree[0]
		expect(src).toMatchObject({ kind: 'folder', path: 'src', fileCount: 3, added: 6, removed: 4 })
		if (src?.kind !== 'folder') throw new Error('src folder missing')
		expect(src.children.map(node => `${node.kind}:${node.name}`)).toEqual(['folder:lib', 'file:index.ts'])
		expect(filesInTreeOrder(nested).map(file => file.path)).toEqual([
			'src/lib/file2.ts',
			'src/lib/file10.ts',
			'src/index.ts',
			'tests/diff.test.ts',
			'README.md'
		])
	})

	it('opens Changed folders and keeps All folders compact until selected', () => {
		const nested: DiffFile[] = [
			{ path: 'README.md', added: 0, removed: 0 },
			{ path: 'src/index.ts', added: 4, removed: 1 },
			{ path: 'src/lib/format.ts', added: 2, removed: 0 }
		]
		const renderTree = (scope: 'changed' | 'all', selectedFile: string | null = null) =>
			renderToStaticMarkup(
				<DiffFileList files={nested} scope={scope} showFolders selectedFile={selectedFile} onSelectFile={vi.fn()} />
			)

		const changed = renderTree('changed')
		expect(changed).toContain('aria-label="Collapse src, 2 files"')
		expect(changed).toContain('data-folder-icon="src"')
		expect(changed).toContain('data-folder-expanded="true"')
		expect(changed).toContain('aria-label="src/index.ts"')
		expect(changed).toContain('data-file-icon="typescript"')

		const all = renderTree('all')
		expect(all).toContain('aria-label="Expand src, 2 files"')
		expect(all).toContain('data-folder-expanded="false"')
		expect(all).not.toContain('aria-label="src/index.ts"')
		expect(all).toContain('aria-label="README.md"')

		const selected = renderTree('all', 'src/lib/format.ts')
		expect(selected).toContain('aria-label="Collapse src, 2 files"')
		expect(selected).toContain('aria-label="Collapse src/lib, 1 file"')
		expect(selected).toContain('aria-label="src/lib/format.ts"')
	})

	it('can show the same files as a flat, full-path list', () => {
		const nested: DiffFile[] = [
			{ path: 'src/file10.ts', added: 0, removed: 3 },
			{ path: 'README.md', added: 0, removed: 0 },
			{ path: 'src/file2.ts', added: 2, removed: 0 }
		]
		const html = renderToStaticMarkup(
			<DiffFileList files={nested} scope="changed" showFolders={false} selectedFile={null} onSelectFile={vi.fn()} />
		)

		expect(filesInFlatOrder(nested).map(file => file.path)).toEqual(['README.md', 'src/file2.ts', 'src/file10.ts'])
		expect(html).toContain('aria-label="Changed files"')
		expect(html).not.toContain('Collapse src')
		expect(html).toContain('data-file-icon="typescript"')
		expect(html).toContain('>src/file2.ts<')
		expect(html).toContain('>src/file10.ts<')
	})

	it.each(['changed', 'all'] as const)('shows a rename at its destination in the %s file list', scope => {
		const renamed: DiffFile = {
			path: 'src/search/coordinator.ts',
			oldPath: 'src/search.ts',
			added: 0,
			removed: 0
		}
		const scoped = filesForScope(scope, [renamed], [renamed.path])
		for (const showFolders of [true, false]) {
			const html = renderToStaticMarkup(
				<DiffFileList
					files={scoped}
					scope={scope}
					showFolders={showFolders}
					selectedFile={renamed.path}
					onSelectFile={vi.fn()}
				/>
			)
			expect(html).toContain('aria-label="src/search/coordinator.ts, renamed from src/search.ts"')
			expect(html).toContain('title="src/search.ts → src/search/coordinator.ts"')
			expect(html).toContain('aria-pressed="true"')
			expect(html).toContain('>R<')
			if (showFolders) {
				expect(html).toContain('aria-label="Collapse src/search, 1 file"')
				expect(html).toContain('>coordinator.ts<')
			} else {
				expect(html).toContain('>src/search/coordinator.ts<')
			}
		}
	})

	it.each([false, true])('opens a pure rename with both paths (aggregate truncated: %s)', truncated => {
		const renamed: DiffFile = { path: 'new.ts', oldPath: 'old.ts', added: 0, removed: 0 }
		const renamePatch = [
			'diff --git a/old.ts b/new.ts',
			'similarity index 100%',
			'rename from old.ts',
			'rename to new.ts'
		].join('\n')
		const renameReview = {
			...review,
			query: {
				...review.query,
				data: { ...diff, files: [renamed], patch: truncated ? '' : renamePatch, truncated }
			},
			fileQuery: { ...review.fileQuery, data: { path: renamed.path, patch: renamePatch } }
		}
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<DiffFileViewer
					review={renameReview}
					filePath={renamed.path}
					scope="changed"
					showFolders
					onSelectFile={vi.fn()}
					onShowFiles={vi.fn()}
					onClose={vi.fn()}
				/>
			</QueryClientProvider>
		)
		expect(html).toContain('title="old.ts → new.ts"')
		expect(html).toContain('rename from old.ts')
		expect(html).toContain('rename to new.ts')
		expect(html).not.toContain('No textual patch')
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
					showFolders
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
