import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DiffFile } from '../src/wire.ts'
import { Patch } from '../web/src/components/Patch.tsx'
import { patchForFile, splitWorkspacePatch } from '../web/src/lib/diff.ts'

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

describe('diff file navigation', () => {
	it('splits a workspace patch into independently viewable files', () => {
		const sections = splitWorkspacePatch(patch)

		expect(sections).toHaveLength(2)
		expect(sections[0]).toContain('a/one.ts')
		expect(sections[0]).not.toContain('a/two.ts')
		expect(sections[1]).toContain('a/two.ts')
	})

	it('renders only the file selected in the changed-files rail', () => {
		const selected = patchForFile(patch, files, 'two.ts')
		const html = renderToStaticMarkup(<Patch patch={selected ?? ''} />)

		expect(html).toContain('a/two.ts')
		expect(html).toContain('+two')
		expect(html).not.toContain('a/one.ts')
	})

	it('reports a file whose section fell beyond the workspace patch limit', () => {
		const firstSectionOnly = splitWorkspacePatch(patch)[0] ?? ''

		expect(patchForFile(firstSectionOnly, files, 'two.ts')).toBeNull()
	})
})
