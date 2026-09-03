import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ChangeStats, compactLineCount } from '../web/src/components/ChangeStats.tsx'

describe('workspace change stats', () => {
	test('renders compact additions and deletions in their git colours', () => {
		const html = renderToStaticMarkup(<ChangeStats stats={{ added: 6_100, removed: 14 }} />)
		expect(html).toContain('text-add')
		expect(html).toContain('>+6.1k<')
		expect(html).toContain('text-del')
		expect(html).toContain('>-14<')
		expect(html).toContain('class="sr-only">6,100 lines added, 14 lines removed<')
		expect(html).toContain('aria-hidden="true"')
	})

	test('omits zero sides and hides a clean workspace', () => {
		expect(renderToStaticMarkup(<ChangeStats stats={{ added: 1, removed: 0 }} />)).toContain('1 line added')
		expect(renderToStaticMarkup(<ChangeStats stats={{ added: 0, removed: 0 }} />)).toBe('')
		expect(renderToStaticMarkup(<ChangeStats stats={null} />)).toBe('')
	})

	test('uses the same compact scale as Conductor', () => {
		expect(compactLineCount(850)).toBe('850')
		expect(compactLineCount(1_000)).toBe('1k')
		expect(compactLineCount(22_657)).toBe('23k')
		expect(compactLineCount(23_000)).toBe('23k')
	})
})
