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

	it('smoothly scrolls only the diff panel to the selected file', () => {
		const scrollIntoView = vi.fn()
		const anchor = {
			getBoundingClientRect: () => ({ top: 640 }),
			scrollIntoView
		}
		const scrollTo = vi.fn()
		const panel = {
			contains: vi.fn(() => true),
			getBoundingClientRect: () => ({ top: 140 }),
			scrollTo,
			scrollTop: 120
		}
		const getElementById = vi.fn(() => anchor)
		vi.stubGlobal('document', { getElementById })

		scrollToPatchFile('diff-file-1', panel as unknown as HTMLElement)

		expect(getElementById).toHaveBeenCalledWith('diff-file-1')
		expect(panel.contains).toHaveBeenCalledWith(anchor)
		expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 620 })
		expect(scrollIntoView).not.toHaveBeenCalled()
	})
})
