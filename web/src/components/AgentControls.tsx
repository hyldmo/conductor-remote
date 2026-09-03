import { Map as MapIcon, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { EFFORT_LABELS, supportsPlanMode } from '../lib/agent.ts'
import { cn } from '../lib/cn.ts'
import { EffortBars, ProviderMark } from './AgentIcons.tsx'
import { ModelPicker } from './ModelPicker.tsx'

/**
 * The compact agent-control row shared by an existing chat and the first-message
 * composer. State ownership stays with the caller: a chat stages against values
 * Conductor has already persisted, while a new workspace has only explicit choices.
 */
export function AgentControls({
	model,
	providerModel,
	agentType,
	models,
	modelPickerOpen,
	onModelPickerOpenChange,
	modelsFetching = false,
	modelsError = false,
	defaultModel,
	onSetDefaultModel,
	settingDefaultModel,
	fast,
	effort,
	plan,
	showEmptyEffort = false,
	modelStaged = false,
	fastStaged = false,
	effortStaged = false,
	planStaged = false,
	onModelChange,
	onFastChange,
	onEffortChange,
	onPlanChange,
	status
}: {
	model: string
	providerModel: string | null
	agentType: string | null
	models: string[]
	modelPickerOpen?: boolean
	onModelPickerOpenChange?: (open: boolean) => void
	modelsFetching?: boolean
	modelsError?: boolean
	defaultModel?: string
	onSetDefaultModel?: (model: string) => void
	settingDefaultModel?: string
	fast?: boolean
	effort?: string
	plan?: boolean
	/** Keep the control visible while a new workspace's inherited effort is unavailable. */
	showEmptyEffort?: boolean
	modelStaged?: boolean
	fastStaged?: boolean
	effortStaged?: boolean
	planStaged?: boolean
	onModelChange: (model: string) => void
	onFastChange: () => void
	onEffortChange: () => void
	onPlanChange: () => void
	status?: ReactNode
}) {
	const planAvailable = supportsPlanMode(agentType, providerModel)

	return (
		<div className="min-w-0 flex-1">
			<div className="flex min-w-0 items-center gap-0.5">
				{/* Only the model control opens a menu; the other settings stay one-tap ghost controls. */}
				<div className="min-w-0">
					<ModelPicker
						value={model}
						models={models}
						open={modelPickerOpen}
						onOpenChange={onModelPickerOpenChange}
						isFetching={modelsFetching}
						isError={modelsError}
						defaultModel={defaultModel}
						onSetDefault={onSetDefaultModel}
						settingDefault={settingDefaultModel}
						onSelect={onModelChange}
						renderTrigger={({ picking, toggle }) => (
							<button
								type="button"
								onClick={toggle}
								aria-label={`Change model, currently ${model}`}
								aria-haspopup="menu"
								aria-expanded={picking}
								className={cn(
									'flex h-8 max-w-full min-w-0 items-center gap-1 rounded-md px-1 text-[13px] font-medium text-muted transition active:bg-surface-2 active:text-text',
									modelStaged && 'text-accent'
								)}
							>
								<ProviderMark agentType={agentType} model={providerModel} className="size-[15px]" />
								<span className="truncate">{model}</span>
							</button>
						)}
					/>
				</div>
				<button
					type="button"
					onClick={onFastChange}
					aria-label={`Fast mode ${fast === undefined ? 'default' : fast ? 'on' : 'off'}`}
					aria-pressed={fast === true}
					className={cn(
						'flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition active:bg-surface-2 active:text-text',
						fast && 'text-text',
						fastStaged && 'text-accent'
					)}
				>
					<Zap size={17} />
				</button>
				{effort || showEmptyEffort ? (
					<button
						type="button"
						onClick={onEffortChange}
						aria-label={`Reasoning effort: ${effort ? EFFORT_LABELS[effort] : 'default'}`}
						className={cn(
							'flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-[13px] font-medium text-muted transition active:bg-surface-2 active:text-text',
							effortStaged && 'text-accent'
						)}
					>
						<EffortBars effort={effort ?? ''} />
						<span className="max-[340px]:hidden">{effort ? EFFORT_LABELS[effort] : 'Effort'}</span>
					</button>
				) : null}
				{planAvailable ? (
					<button
						type="button"
						onClick={onPlanChange}
						aria-label={`Plan mode ${plan === undefined ? 'default' : plan ? 'on' : 'off'}`}
						aria-pressed={plan === true}
						className={cn(
							'flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition active:bg-surface-2 active:text-text',
							plan && 'text-text',
							planStaged && 'text-accent'
						)}
					>
						<MapIcon size={17} />
					</button>
				) : null}
			</div>
			{status ? <div className="px-2 pt-0.5 text-[11px] text-faint">{status}</div> : null}
		</div>
	)
}
