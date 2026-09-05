import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { ToolUsageResponse, ToolUsageRow } from '../../src/wire.ts'
import { summarizeToolUsage, toolUsageName } from '../../web/src/lib/tool-usage.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })
const { ToolUsageContent } = await import('../../web/src/components/agents/ToolUsageSection.tsx')

const tool = (name: string, calls: number, totalTokens: number, largestCallTokens: number): ToolUsageRow => ({
	name,
	calls,
	inputTokens: totalTokens / 4,
	outputTokens: (totalTokens * 3) / 4,
	totalTokens,
	largestCallTokens
})
const data: ToolUsageResponse = {
	range: '24h',
	since: '2026-09-04T12:00:00Z',
	until: '2026-09-05T12:00:00Z',
	fetchedAt: 0,
	providers: [
		{
			provider: 'codex',
			sessionCount: 2,
			tools: [tool('Read', 10, 4000, 800), tool('mcp__browser__snapshot', 1, 2000, 2000)]
		},
		{ provider: 'claude', sessionCount: 1, tools: [tool('Read', 1, 1000, 1000)] }
	]
}

describe('Models tool context breakdown', () => {
	test('merges provider totals with a weighted per-call average and the maximum largest call', () => {
		const summary = summarizeToolUsage(data)
		expect(summary.sessionCount).toBe(3)
		expect(summary.totalTokens).toBe(7000)
		expect(summary.tools[0]).toMatchObject({ name: 'Read', calls: 11, totalTokens: 5000, largestCallTokens: 1000 })
		expect(summarizeToolUsage(data, 'codex').tools[0].totalTokens).toBe(4000)
		expect(data.providers[0].tools[0].totalTokens).toBe(4000)
	})

	test('ranks a rare expensive call above frequent small calls when sorting by average or maximum', () => {
		expect(summarizeToolUsage(data, 'all', 'total').tools[0].name).toBe('Read')
		expect(summarizeToolUsage(data, 'all', 'average').tools[0].name).toBe('mcp__browser__snapshot')
		expect(summarizeToolUsage(data, 'all', 'largest').tools[0].name).toBe('mcp__browser__snapshot')
	})

	test('shows estimated tokens, the input/result split, expandable details, and full MCP identity', () => {
		const html = renderToStaticMarkup(<ToolUsageContent data={data} />)
		for (const label of [
			'≈7k tokens',
			'12',
			'calls ·',
			'3',
			'chats',
			'Inputs',
			'Results',
			'71% of tool tokens',
			'Total inputs',
			'Total results',
			'Average / call',
			'Largest call',
			'Tokens per call',
			'<details',
			'mcp__browser__snapshot'
		])
			expect(html).toContain(label)
		expect(toolUsageName('mcp__browser__snapshot')).toEqual({ label: 'snapshot', server: 'browser' })
	})

	test('shows an honest empty state for a provider with no activity', () => {
		const html = renderToStaticMarkup(<ToolUsageContent data={data} provider="cursor" />)
		expect(html).toContain('No saved tool calls in this period for this provider.')
		expect(html).not.toContain('NaN')
		expect(html).not.toContain('≈0')
	})
})
