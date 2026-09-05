import { useMemo } from 'react'
import { isRoutableAgent, isRouterModel } from '../../lib/agents-settings.ts'
import type { AgentDefinition, RoutingConfig } from '../../lib/types.ts'
import { RoleEditorCard } from './RoleEditorCard.tsx'

const inputClass =
	'w-full rounded-xl border border-border bg-bg px-3 py-2 text-base outline-none focus:border-accent/60'

export function RoutingSettingsSection({
	config,
	agents,
	models,
	invalid,
	onChange
}: {
	config: RoutingConfig
	agents: AgentDefinition[]
	models: string[]
	invalid?: string | null
	onChange: (config: RoutingConfig) => void
}) {
	const routerModels = useMemo(() => models.filter(isRouterModel), [models])
	const routableAgents = agents.filter(isRoutableAgent)
	const hasFallback = routableAgents.some(agent => agent.name === config.fallback)
	return (
		<>
			<p className="text-sm text-muted">
				Auto reads your first message and attachments, then selects a model once. You can change the model afterward.
			</p>
			<label className="flex items-center gap-3 text-sm">
				<input
					type="checkbox"
					checked={config.defaultAuto}
					onChange={event => onChange({ ...config, defaultAuto: event.target.checked })}
				/>
				Use Auto by default for new workspaces and chats
			</label>
			<RoleEditorCard
				name="Router"
				role={config.router}
				models={routerModels}
				invalid={invalid}
				onChange={({ model, effort, fast }) => onChange({ ...config, router: { model, effort, fast } })}
				showPreamble={false}
			/>
			<p className="text-xs text-muted">
				Luna is the initial router. Muse Spark’s free and contributor options remain separate choices.
			</p>
			<label className="block text-sm">
				Fallback agent
				<select
					className={`${inputClass} mt-1`}
					value={hasFallback ? config.fallback : ''}
					aria-invalid={!hasFallback}
					onChange={event => onChange({ ...config, fallback: event.target.value })}
				>
					{!hasFallback ? (
						<option value="" disabled>
							Choose a fallback agent
						</option>
					) : null}
					{routableAgents.map(agent => (
						<option key={agent.name} value={agent.name}>
							{agent.name} · {agent.model}
						</option>
					))}
				</select>
			</label>
			<p className="text-xs text-muted">
				Used when the router times out, returns an invalid choice, or lacks essential context.
			</p>
			<label className="block text-sm">
				Routing rules
				<textarea
					className={`${inputClass} mt-1`}
					rows={8}
					maxLength={12000}
					value={config.rules}
					onChange={event => onChange({ ...config, rules: event.target.value })}
				/>
			</label>
			<label className="block text-sm">
				Maximum selection time (seconds)
				<input
					className={`${inputClass} mt-1`}
					type="number"
					min={2}
					max={30}
					step="0.001"
					value={config.timeoutMs === 0 ? '' : config.timeoutMs / 1000}
					onChange={event => onChange({ ...config, timeoutMs: Number(event.target.value) * 1000 })}
				/>
			</label>
		</>
	)
}
