import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlanUsage } from '../hooks.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import type { PlanUsageResponse, PlanUsageWindow, ProviderPlanUsage } from '../lib/types.ts'
import { planName, resetLabel } from '../lib/usage.ts'
import { ProviderMark } from './AgentIcons.tsx'
import { Empty, Spinner } from './ui.tsx'

function UsageBar({ window }: { window: PlanUsageWindow }) {
	const shown = Math.round(window.usedPercent)
	return (
		<div>
			<div className="mb-1 flex items-baseline gap-2 text-xs">
				<span className="min-w-0 flex-1 truncate text-muted">
					{window.active ? <span className="mr-1.5 inline-block size-1.5 rounded-full bg-working" /> : null}
					{window.label}
				</span>
				<span className="font-medium tabular-nums text-text">{shown}%</span>
			</div>
			<div
				role="progressbar"
				aria-label={`${window.label}: ${shown}% used`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={shown}
				className="h-1.5 overflow-hidden rounded-full bg-surface"
			>
				<div
					className={cn(
						'h-full rounded-full transition-[width]',
						shown >= 95 ? 'bg-del' : shown >= 80 ? 'bg-working' : 'bg-accent'
					)}
					style={{ width: `${window.usedPercent}%` }}
				/>
			</div>
			<div className="mt-1 text-[11px] text-faint">{resetLabel(window.resetsAt)}</div>
		</div>
	)
}

function ProviderCard({ usage }: { usage: ProviderPlanUsage }) {
	return (
		<section className="rounded-2xl border border-border bg-surface-2 p-3.5">
			<div className="mb-3 flex items-center gap-2">
				<ProviderMark agentType={usage.provider} model={null} className="size-5" />
				<h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{usage.label}</h3>
				{usage.plan ? <span className="pill shrink-0 text-[11px]">{planName(usage.plan)}</span> : null}
			</div>
			<div className="space-y-4">
				{usage.buckets.map(bucket => (
					<div key={bucket.id} className="space-y-3">
						{usage.buckets.length > 1 || bucket.label !== usage.label ? (
							<div className="text-xs font-medium text-muted">{bucket.label}</div>
						) : null}
						{bucket.windows.map(window => (
							<UsageBar key={window.id} window={window} />
						))}
					</div>
				))}
			</div>
		</section>
	)
}

function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Global provider allowance sheet. No command here sends a model prompt. */
export function PlanUsageSheet({ onClose }: { onClose: () => void }) {
	const usage = usePlanUsage(true)
	const queryClient = useQueryClient()
	const [refreshing, setRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState<string>()
	const available = usage.data?.providers.filter(provider => provider.status === 'available') ?? []
	const unavailable = usage.data?.providers.filter(provider => provider.status !== 'available') ?? []

	const refresh = async () => {
		if (refreshing) return
		setRefreshing(true)
		setRefreshError(undefined)
		try {
			const fresh = await client.planUsage(true)
			queryClient.setQueryData<PlanUsageResponse>(['plan-usage'], fresh)
		} catch (error) {
			setRefreshError(error instanceof Error ? error.message : 'Could not refresh plan usage.')
		} finally {
			setRefreshing(false)
		}
	}

	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Plan usage"
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-md flex-col rounded-t-3xl border border-border-soft bg-surface shadow-xl md:inset-0 md:m-auto md:h-fit md:rounded-3xl"
			>
				<div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
					<div className="min-w-0 flex-1">
						<h2 className="text-base font-semibold">Plan usage</h2>
						<p className="truncate text-xs text-muted">Read from the agent CLIs on this Mac · no prompt sent</p>
					</div>
					<button
						type="button"
						onClick={() => void refresh()}
						disabled={refreshing || (!usage.data && usage.isLoading)}
						aria-label="Refresh plan usage"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2 disabled:opacity-40"
					>
						<RefreshCw size={17} className={refreshing ? 'animate-spin' : undefined} />
					</button>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
					>
						<X size={18} />
					</button>
				</div>

				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
					{usage.isLoading && !usage.data ? (
						<Spinner label="Reading provider limits…" />
					) : usage.isError && !usage.data ? (
						<Empty>{(usage.error as Error)?.message ?? 'Could not read plan usage.'}</Empty>
					) : (
						<>
							{available.map(provider => (
								<ProviderCard key={provider.provider} usage={provider} />
							))}
							{unavailable.length ? (
								<section className="rounded-2xl border border-border-soft px-3.5 py-3">
									<h3 className="mb-2 text-xs font-medium text-muted">Not exposed by the CLI</h3>
									<div className="space-y-2">
										{unavailable.map(provider => (
											<div key={provider.provider} className="flex items-start gap-2 text-xs">
												<ProviderMark agentType={provider.provider} model={null} className="mt-0.5 size-3.5" />
												<p className={provider.status === 'error' ? 'text-del' : 'text-faint'}>
													<span className="font-medium text-muted">{provider.label}:</span> {provider.message}
												</p>
											</div>
										))}
									</div>
								</section>
							) : null}
						</>
					)}
					{refreshError ? <p className="text-xs text-del">{refreshError}</p> : null}
				</div>

				{usage.data ? (
					<div className="shrink-0 border-t border-border-soft px-4 py-2.5 text-[11px] text-faint">
						Updated {clockTime(usage.data.fetchedAt)} · cached for one minute
					</div>
				) : null}
			</div>
		</>,
		document.body
	)
}
