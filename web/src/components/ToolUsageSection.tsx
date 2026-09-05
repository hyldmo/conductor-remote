import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useToolUsage } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { formatContextShare, formatContextTokens } from '../lib/format.ts'
import { summarizeToolUsage, type ToolUsageSort, toolUsageMetric, toolUsageName } from '../lib/tool-usage.ts'
import type { ToolUsageRange, ToolUsageResponse, ToolUsageRow } from '../lib/types.ts'

const SELECT_CLASS = 'h-9 min-w-0 rounded-lg border border-border-soft bg-surface px-2 text-xs text-text'
const PROVIDERS = [
	['claude', 'Claude Code'],
	['codex', 'Codex'],
	['cursor', 'Cursor Agent'],
	['opencode', 'OpenCode']
] as const

function TokenBar({ inputs, outputs, scale }: { inputs: number; outputs: number; scale: number }) {
	return (
		<div
			role="img"
			aria-label={`Inputs: approximately ${formatContextTokens(inputs)} tokens; results: approximately ${formatContextTokens(outputs)} tokens`}
			className="flex h-1.5 overflow-hidden rounded-full bg-surface-2"
		>
			<span className="bg-context-tools/40" style={{ width: `${(inputs / Math.max(1, scale)) * 100}%` }} />
			<span className="bg-context-tools" style={{ width: `${(outputs / Math.max(1, scale)) * 100}%` }} />
		</div>
	)
}

function ToolRow({ tool, total, sort }: { tool: ToolUsageRow; total: number; sort: ToolUsageSort }) {
	const name = toolUsageName(tool.name)
	const shown = toolUsageMetric(tool, sort)
	return (
		<details className="group border-t border-border-soft first:border-t-0">
			<summary className="cursor-pointer list-none px-3 py-3 [&::-webkit-details-marker]:hidden">
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1" title={tool.name ?? undefined}>
						<div className="break-words text-xs font-medium [overflow-wrap:anywhere]">{name.label}</div>
						{name.server ? <div className="mt-0.5 break-all text-[11px] text-faint">{name.server}</div> : null}
					</div>
					<span className="shrink-0 text-xs font-medium tabular-nums">≈{formatContextTokens(Math.round(shown))}</span>
					<ChevronDown size={14} className="mt-0.5 shrink-0 text-faint transition-transform group-open:rotate-180" />
				</div>
				<div className="mt-1 flex justify-between gap-2 text-[11px] tabular-nums text-muted">
					<span>
						{tool.calls.toLocaleString()} {tool.name ? (tool.calls === 1 ? 'call' : 'calls') : 'results'}
					</span>
					<span>
						{sort === 'average'
							? 'tokens / call'
							: sort === 'largest'
								? 'largest call'
								: `${formatContextShare(tool.totalTokens, total)} of tool tokens`}
					</span>
				</div>
				{sort === 'total' ? (
					<div className="mt-2">
						<TokenBar inputs={tool.inputTokens} outputs={tool.outputTokens} scale={total} />
					</div>
				) : null}
			</summary>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-soft bg-surface-2/50 px-3 py-3 text-xs">
				{[
					['Total inputs', tool.inputTokens],
					['Total results', tool.outputTokens],
					['Average / call', tool.calls ? Math.round(tool.totalTokens / tool.calls) : 0],
					['Largest call', tool.largestCallTokens]
				].map(([label, value]) => (
					<div key={label}>
						<dt className="text-[11px] text-muted">{label}</dt>
						<dd className="mt-0.5 font-medium tabular-nums">≈{formatContextTokens(value as number)} tokens</dd>
					</div>
				))}
			</dl>
			{!tool.name ? (
				<p className="px-3 pb-3 text-[11px] text-muted">
					These saved results have no matching tool call to identify them.
				</p>
			) : null}
		</details>
	)
}

export function ToolUsageContent({ data, provider = 'all' }: { data: ToolUsageResponse; provider?: string }) {
	const [sort, setSort] = useState<ToolUsageSort>('total')
	const [showAll, setShowAll] = useState(false)
	const summary = summarizeToolUsage(data, provider, sort)
	if (!summary.tools.length) {
		return (
			<p className="py-6 text-center text-xs text-muted">
				No saved tool calls in this period{provider === 'all' ? '.' : ' for this provider.'}
			</p>
		)
	}
	const shownTools = showAll ? summary.tools : summary.tools.slice(0, 8)
	return (
		<div className="space-y-3">
			<div>
				<div className="flex items-baseline justify-between gap-2">
					<span className="text-sm font-semibold tabular-nums">≈{formatContextTokens(summary.totalTokens)} tokens</span>
					<span className="text-[11px] tabular-nums text-muted">
						{summary.calls.toLocaleString()} calls · {summary.sessionCount}{' '}
						{summary.sessionCount === 1 ? 'chat' : 'chats'}
					</span>
				</div>
				<div className="mt-2">
					<TokenBar inputs={summary.inputTokens} outputs={summary.outputTokens} scale={summary.totalTokens} />
				</div>
				<div className="mt-2 grid grid-cols-2 gap-3 text-[11px] text-muted">
					<div>
						<span className="mr-1.5 inline-block size-2 rounded-full bg-context-tools/40" />
						Inputs <span className="tabular-nums">≈{formatContextTokens(summary.inputTokens)}</span>
					</div>
					<div>
						<span className="mr-1.5 inline-block size-2 rounded-full bg-context-tools" />
						Results <span className="tabular-nums">≈{formatContextTokens(summary.outputTokens)}</span>
					</div>
				</div>
			</div>
			<div className="flex items-center justify-between gap-3">
				<label htmlFor="tool-usage-sort" className="text-xs text-muted">
					Rank tools by
				</label>
				<select
					id="tool-usage-sort"
					value={sort}
					onChange={event => setSort(event.target.value as ToolUsageSort)}
					className={SELECT_CLASS}
				>
					<option value="total">Total tokens</option>
					<option value="average">Tokens per call</option>
					<option value="largest">Largest call</option>
				</select>
			</div>
			<div className="overflow-hidden rounded-xl border border-border-soft">
				{shownTools.map(tool => (
					<ToolRow key={tool.name ?? '\0unknown'} tool={tool} total={summary.totalTokens} sort={sort} />
				))}
			</div>
			{summary.tools.length > 8 ? (
				<button
					type="button"
					onClick={() => setShowAll(!showAll)}
					className="min-h-9 w-full rounded-lg text-xs font-medium text-muted active:bg-surface-2"
				>
					{showAll ? 'Show fewer tools' : `Show all ${summary.tools.length} tools`}
				</button>
			) : null}
		</div>
	)
}

/** The global Models sheet owns this mounted, on-demand view of saved tool traffic. */
export function ToolUsageSection() {
	const [range, setRange] = useState<ToolUsageRange>('24h')
	const [provider, setProvider] = useState('all')
	const [refreshing, setRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState<string>()
	const query = useToolUsage(range)
	const queryClient = useQueryClient()
	const refresh = async () => {
		if (refreshing) return
		setRefreshing(true)
		setRefreshError(undefined)
		try {
			const data = await client.toolUsage(range, true)
			queryClient.setQueryData(['tool-usage', range], data)
		} catch (error) {
			setRefreshError(error instanceof Error ? error.message : 'Could not refresh tool usage.')
		} finally {
			setRefreshing(false)
		}
	}
	return (
		<section aria-labelledby="tool-usage-heading" className="space-y-3 border-t border-border-soft pt-4">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<h3 id="tool-usage-heading" className="text-sm font-semibold">
						Tool context
					</h3>
					<p className="mt-0.5 text-[11px] text-muted">Estimated input and result tokens across chats</p>
				</div>
				<button
					type="button"
					onClick={() => void refresh()}
					disabled={refreshing || query.isFetching}
					aria-label="Refresh tool usage"
					className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 disabled:opacity-40"
				>
					<RefreshCw size={14} className={refreshing || query.isFetching ? 'animate-spin' : undefined} />
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<select
					aria-label="Tool usage period"
					value={range}
					onChange={event => {
						setRange(event.target.value as ToolUsageRange)
						setRefreshError(undefined)
					}}
					className={SELECT_CLASS}
				>
					<option value="24h">Last 24 hours</option>
					<option value="7d">Last 7 days</option>
					<option value="30d">Last 30 days</option>
				</select>
				<select
					aria-label="Tool usage provider"
					value={provider}
					onChange={event => setProvider(event.target.value)}
					className={SELECT_CLASS}
				>
					<option value="all">All providers</option>
					{PROVIDERS.map(([id, label]) => (
						<option key={id} value={id}>
							{label}
						</option>
					))}
					{query.data?.providers
						.filter(group => !PROVIDERS.some(([id]) => id === group.provider))
						.map(group => (
							<option key={group.provider} value={group.provider}>
								{group.provider === 'unknown' ? 'Unknown provider' : group.provider}
							</option>
						))}
				</select>
			</div>
			{query.data ? (
				<ToolUsageContent key={`${range}:${provider}`} data={query.data} provider={provider} />
			) : query.isError ? (
				<div className="space-y-2 py-4 text-center text-xs">
					<p className="text-del">
						{query.error instanceof Error ? query.error.message : 'Could not read tool usage.'}
					</p>
					<button
						type="button"
						onClick={() => void query.refetch()}
						className="min-h-9 rounded-full border border-border px-3 font-medium"
					>
						Try again
					</button>
				</div>
			) : (
				<div role="status" className="flex items-center justify-center gap-2 py-8 text-xs text-muted">
					<LoaderCircle size={14} className="animate-spin" />
					Reading tool usage…
				</div>
			)}
			{refreshError ? (
				<p role="alert" className="text-xs text-del">
					{refreshError}
				</p>
			) : null}
			<p className="text-[11px] leading-relaxed text-faint">
				Saved tool traffic, including archived chats. Each call and result is counted once; this is not billed usage or
				the current context size. Estimates exclude image tokens, tool definitions, and child-agent internals.
			</p>
			{query.data ? (
				<p className="text-[11px] text-faint">
					Through {new Date(query.data.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · cached
					for one minute
				</p>
			) : null}
		</section>
	)
}
