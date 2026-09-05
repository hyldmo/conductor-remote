import type { ToolUsageResponse, ToolUsageRow } from './types.ts'

export type ToolUsageSort = 'total' | 'average' | 'largest'

export function toolUsageMetric(tool: ToolUsageRow, sort: ToolUsageSort): number {
	if (sort === 'average') return tool.calls ? tool.totalTokens / tool.calls : 0
	return sort === 'largest' ? tool.largestCallTokens : tool.totalTokens
}

export function summarizeToolUsage(data: ToolUsageResponse, provider = 'all', sort: ToolUsageSort = 'total') {
	const grouped = new Map<string | null, ToolUsageRow>()
	let sessionCount = 0
	for (const group of data.providers) {
		if (provider !== 'all' && group.provider !== provider) continue
		sessionCount += group.sessionCount
		for (const row of group.tools) {
			const previous = grouped.get(row.name)
			if (!previous) {
				grouped.set(row.name, { ...row })
				continue
			}
			previous.calls += row.calls
			previous.inputTokens += row.inputTokens
			previous.outputTokens += row.outputTokens
			previous.totalTokens += row.totalTokens
			previous.largestCallTokens = Math.max(previous.largestCallTokens, row.largestCallTokens)
		}
	}
	const tools = [...grouped.values()].sort(
		(a, b) => toolUsageMetric(b, sort) - toolUsageMetric(a, sort) || (a.name ?? '').localeCompare(b.name ?? '')
	)
	return {
		tools,
		sessionCount,
		calls: tools.reduce((sum, row) => sum + row.calls, 0),
		totalTokens: tools.reduce((sum, row) => sum + row.totalTokens, 0),
		inputTokens: tools.reduce((sum, row) => sum + row.inputTokens, 0),
		outputTokens: tools.reduce((sum, row) => sum + row.outputTokens, 0)
	}
}

/** Keep MCP function names readable without losing their server identity. */
export function toolUsageName(name: string | null): { label: string; server: string | null } {
	if (!name) return { label: 'Unmatched tool results', server: null }
	if (!name.startsWith('mcp__')) return { label: name, server: null }
	const parts = name.slice(5).split('__')
	return parts.length > 1
		? { label: parts.at(-1)!, server: parts.slice(0, -1).join('__') }
		: { label: name, server: null }
}
