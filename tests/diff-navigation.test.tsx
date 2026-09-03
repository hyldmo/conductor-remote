import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Patch, scrollToPatchFile } from '../web/src/components/Patch.tsx'

describe('diff file navigation', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('anchors each file header in patch order', () => {
		const patch = [
			'diff --git a/one.ts b/one.ts',
			'--- a/one.ts',
			'+++ b/one.ts',
			'diff --git a/two.ts b/two.ts',
			'--- a/two.ts',
			'+++ b/two.ts'
		].join('\n')
		const html = renderToStaticMarkup(<Patch patch={patch} fileAnchorIds={['diff-file-0', 'diff-file-1']} />)

		expect(html).toContain('id="diff-file-0"')
		expect(html).toContain('id="diff-file-1"')
		expect(html.indexOf('id="diff-file-0"')).toBeLessThan(html.indexOf('id="diff-file-1"'))
	})

	it('smoothly brings the selected file to the top of the panel', () => {
		const scrollIntoView = vi.fn()
		const getElementById = vi.fn(() => ({ scrollIntoView }))
		vi.stubGlobal('document', { getElementById })

		scrollToPatchFile('diff-file-1')

		expect(getElementById).toHaveBeenCalledWith('diff-file-1')
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start', inline: 'nearest' })
	})
})
