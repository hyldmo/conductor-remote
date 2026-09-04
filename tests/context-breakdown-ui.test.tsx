import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { ContextBreakdownResponse } from '../src/wire.ts'
import { formatContextShare, formatContextTokens } from '../web/src/lib/format.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { ContextBreakdownContent } = await import('../web/src/components/ContextBreakdownSheet.tsx')

const breakdown: ContextBreakdownResponse = {
	totalTokens: 100_000,
	usedPercent: 50,
	compacted: true,
	categories: { initial: 20_000, chat: 30_000, thinking: 10_000, tools: 40_000 },
	forkTokens: { concise: 12_400, reasoning: 18_000, full: 31_000 }
}

describe('context breakdown sheet', () => {
	test('shows composition and every fork choice in the same vocabulary as the fork menu', () => {
		const html = renderToStaticMarkup(<ContextBreakdownContent data={breakdown} />)

		expect(html).toContain('Inside this context')
		expect(html).toContain('Initial context')
		expect(html).toContain('Thinking')
		expect(html).toContain('Tool calls')
		expect(html).toContain('50% used')
		expect(html).toContain('Last message only')
		expect(html).toContain('Concise')
		expect(html).toContain('With reasoning')
		expect(html).toContain('Full transcript')
		expect(html).toContain('including history before compaction')
		expect(html).toContain('the source&#x27;s initial context is not copied')
		expect(html).toContain('Concise: 12.4k estimated tokens')
		expect(html).toContain('With reasoning: 18k estimated tokens')
		expect(html).toContain('Full transcript: 31k estimated tokens')
		expect(html).toContain('bg-context-initial')
		expect(html).toContain('bg-context-chat')
		expect(html).toContain('bg-working')
		expect(html).toContain('bg-context-tools')
	})

	test('formats token estimates compactly', () => {
		expect(formatContextTokens(999)).toBe('999')
		expect(formatContextTokens(12_400)).toBe('12.4k')
		expect(formatContextTokens(144_338)).toBe('144k')
		expect(formatContextTokens(1_000_000)).toBe('1M')
	})

	test('does not present a small nonzero category as zero percent', () => {
		expect(formatContextShare(0, 100_000)).toBe('0%')
		expect(formatContextShare(508, 142_960)).toBe('<1%')
		expect(formatContextShare(30_936, 142_960)).toBe('22%')
	})

	test('explains equal fork sizes when the provider saved no reasoning', () => {
		const html = renderToStaticMarkup(
			<ContextBreakdownContent
				data={{ ...breakdown, forkTokens: { concise: 12_400, reasoning: 12_400, full: 31_000 } }}
			/>
		)

		expect(html).toContain('No saved reasoning is available to copy')
	})
})
