import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useModelDefaults, usePlanUsage } from '../hooks.ts'
import { EFFORT_LABELS, EFFORT_ORDER } from '../lib/agent.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import type {
	DefaultEfforts,
	ModelDefaultsResponse,
	PlanUsageProviderId,
	PlanUsageResponse,
	PlanUsageWindow,
	ProviderPlanUsage
} from '../lib/types.ts'
import { planName, resetLabel } from '../lib/usage.ts'
import { ProviderMark } from './AgentIcons.tsx'
import { Empty } from './ui.tsx'

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

type EffortProvider = keyof DefaultEfforts

const PROVIDERS: Array<{ provider: PlanUsageProviderId; label: string }> = [
	{ provider: 'claude', label: 'Claude Code' },
	{ provider: 'codex', label: 'Codex' },
	{ provider: 'cursor', label: 'Cursor Agent' },
	{ provider: 'opencode', label: 'OpenCode' }
]

function effortProvider(provider: PlanUsageProviderId): EffortProvider | null {
	return provider === 'claude' || provider === 'codex' ? provider : null
}

export function ProviderCard({
	usage,
	defaultEffort,
	defaultsLoading = false,
	savingDefault = false,
	onDefaultEffortChange
}: {
	usage: ProviderPlanUsage
	defaultEffort?: string | null
	defaultsLoading?: boolean
	savingDefault?: boolean
	onDefaultEffortChange?: (effort: string) => void
}) {
	const editableProvider = effortProvider(usage.provider)
	const unknownEffort = defaultEffort && !EFFORT_ORDER.includes(defaultEffort) ? defaultEffort : null
	const visibleBuckets = usage.buckets.filter(
		bucket => bucket.label !== 'GPT-5.3-Codex-Spark' || bucket.windows.some(window => window.usedPercent !== 0)
	)
	return (
		<section className="rounded-2xl border border-border bg-surface-2 p-3.5">
			<div className={cn('flex items-center gap-2', (editableProvider || visibleBuckets.length) && 'mb-3')}>
				<ProviderMark agentType={usage.provider} model={null} className="size-5" />
				<h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{usage.label}</h3>
				{usage.plan ? <span className="pill shrink-0 text-[11px]">{planName(usage.plan)}</span> : null}
			</div>
			{editableProvider ? (
				<label className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border-soft bg-surface px-3 py-2">
					<span className="min-w-0">
						<span className="block text-xs font-medium">Default effort</span>
						<span className="block text-[11px] text-faint">New chats</span>
					</span>
					<span className="relative shrink-0">
						<select
							aria-label={`${usage.label} default effort`}
							value={defaultEffort ?? ''}
							disabled={defaultsLoading || savingDefault || !onDefaultEffortChange}
							onChange={event => onDefaultEffortChange?.(event.target.value)}
							className="h-8 min-w-28 appearance-none rounded-lg border border-border bg-surface-2 py-1 pl-2.5 pr-7 text-xs text-text outline-none disabled:opacity-50"
						>
							<option value="" disabled>
								{defaultsLoading ? 'Reading…' : 'Choose effort'}
							</option>
							{unknownEffort ? <option value={unknownEffort}>{unknownEffort}</option> : null}
							{EFFORT_ORDER.map(effort => (
								<option key={effort} value={effort}>
									{EFFORT_LABELS[effort]}
								</option>
							))}
						</select>
						<span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-faint">
							{savingDefault ? <RefreshCw size={12} className="animate-spin" /> : <ChevronDown size={12} />}
						</span>
					</span>
				</label>
			) : null}
			{visibleBuckets.length ? (
				<div className="space-y-4">
					{visibleBuckets.map(bucket => (
						<div key={bucket.id} className="space-y-3">
							{visibleBuckets.length > 1 || bucket.label !== usage.label ? (
								<div className="text-xs font-medium text-muted">{bucket.label}</div>
							) : null}
							{bucket.windows.map(window => (
								<UsageBar key={window.id} window={window} />
							))}
						</div>
					))}
				</div>
			) : usage.status === 'error' && editableProvider ? (
				<p className="text-xs text-del">{usage.message ?? 'Could not read plan usage.'}</p>
			) : null}
		</section>
	)
}

function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Global model defaults and provider allowances. */
export function PlanUsageSheet({ onClose }: { onClose: () => void }) {
	const usage = usePlanUsage(true)
	const defaults = useModelDefaults()
	const queryClient = useQueryClient()
	const [refreshing, setRefreshing] = useState(false)
	const [refreshError, setRefreshError] = useState<string>()
	const [savingProvider, setSavingProvider] = useState<EffortProvider>()
	const [defaultsError, setDefaultsError] = useState<string>()
	const providers = PROVIDERS.map(
		provider =>
			usage.data?.providers.find(candidate => candidate.provider === provider.provider) ?? {
				...provider,
				status: 'unavailable' as const,
				plan: null,
				buckets: []
			}
	)

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

	const saveDefaultEffort = async (provider: EffortProvider, effort: string) => {
		if (savingProvider) return
		setSavingProvider(provider)
		setDefaultsError(undefined)
		const previous = defaults.data
		if (previous) {
			queryClient.setQueryData<ModelDefaultsResponse>(['model-defaults'], {
				defaultEfforts: { ...previous.defaultEfforts, [provider]: effort }
			})
		}
		try {
			const saved = await client.patchModelDefaults({ [provider]: effort })
			queryClient.setQueryData<ModelDefaultsResponse>(['model-defaults'], saved)
		} catch (error) {
			if (previous) queryClient.setQueryData<ModelDefaultsResponse>(['model-defaults'], previous)
			setDefaultsError(error instanceof Error ? error.message : 'Could not save the default effort.')
		} finally {
			setSavingProvider(undefined)
		}
	}

	return createPortal(
		<>
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Models"
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-md flex-col rounded-t-3xl border border-border-soft bg-surface shadow-xl md:inset-0 md:m-auto md:h-fit md:rounded-3xl"
			>
				<div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
					<div className="min-w-0 flex-1">
						<h2 className="text-base font-semibold">Models</h2>
						<p className="truncate text-xs text-muted">Defaults and plan usage</p>
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
					{providers.map(provider => {
						const editableProvider = effortProvider(provider.provider)
						return (
							<ProviderCard
								key={provider.provider}
								usage={provider}
								defaultEffort={editableProvider ? defaults.data?.defaultEfforts[editableProvider] : undefined}
								defaultsLoading={defaults.isLoading || savingProvider !== undefined}
								savingDefault={savingProvider === editableProvider}
								onDefaultEffortChange={
									editableProvider ? effort => void saveDefaultEffort(editableProvider, effort) : undefined
								}
							/>
						)
					})}
					{usage.isLoading && !usage.data ? (
						<p className="text-center text-xs text-faint">Reading plan usage…</p>
					) : usage.isError && !usage.data ? (
						<Empty>{(usage.error as Error)?.message ?? 'Could not read plan usage.'}</Empty>
					) : null}
					{refreshError ? <p className="text-xs text-del">{refreshError}</p> : null}
					{defaultsError ? <p className="text-xs text-del">{defaultsError}</p> : null}
					{defaults.isError ? (
						<p className="text-xs text-del">{(defaults.error as Error)?.message ?? 'Could not read model defaults.'}</p>
					) : null}
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
