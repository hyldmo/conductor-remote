import type { Element } from 'hast'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { Markdown, fenceSource } = await import('../../web/src/components/transcript/Markdown.tsx')

const render = (markdown: string) => renderToStaticMarkup(<Markdown>{markdown}</Markdown>)

describe('a fenced block in a message', () => {
	it('carries a Copy control', () => {
		const html = render('```ts\nconst a = 1\n```')
		expect(html).toContain('aria-label="Copy code"')
		expect(html).toContain('<pre')
	})

	it('carries one with no info string too', () => {
		expect(render('```\nyarn verify\n```')).toContain('aria-label="Copy code"')
	})

	it('gives an empty fence nothing to copy', () => {
		expect(render('```\n```')).not.toContain('aria-label="Copy code"')
	})
})

describe('inline code', () => {
	it('gets no Copy control', () => {
		expect(render('run `yarn verify` first')).not.toContain('aria-label="Copy code"')
	})
})

describe('what a fence copies', () => {
	const fence = (value: string): Element => ({
		type: 'element',
		tagName: 'pre',
		properties: {},
		children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value }] }]
	})

	it('is the code without the newline every fence ends on', () => {
		expect(fenceSource(fence('const a = 1\n'))).toBe('const a = 1')
	})

	it('keeps the newlines inside the block, and a blank last line', () => {
		expect(fenceSource(fence('a\n\nb\n'))).toBe('a\n\nb')
		expect(fenceSource(fence('a\n\n'))).toBe('a\n')
	})

	it('reads through nested elements', () => {
		const node: Element = {
			type: 'element',
			tagName: 'pre',
			properties: {},
			children: [
				{
					type: 'element',
					tagName: 'code',
					properties: {},
					children: [
						{ type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: 'const' }] },
						{ type: 'text', value: ' a\n' }
					]
				}
			]
		}
		expect(fenceSource(node)).toBe('const a')
	})
})
