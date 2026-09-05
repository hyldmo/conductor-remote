import { useId } from 'react'
import { isRoutableAgent } from '../../lib/agents-settings.ts'
import type { AgentDefinition } from '../../lib/types.ts'
import { RoleEditorCard } from './RoleEditorCard.tsx'

export function AgentEditorCard({
	agent,
	models,
	agentType,
	invalid,
	routingLock,
	canRemove,
	onChange,
	onRemove
}: {
	agent: AgentDefinition
	models: string[]
	agentType: string | null
	invalid?: string
	routingLock?: string
	canRemove: boolean
	onChange: (agent: AgentDefinition) => void
	onRemove: () => void
}) {
	const hintId = useId()
	const hasDescription = !!agent.description?.trim()
	return (
		<RoleEditorCard
			name={agent.name}
			role={agent}
			models={models}
			agentType={agentType}
			invalid={invalid}
			onChange={role => onChange({ ...agent, ...role, effort: role.effort, fast: role.fast, preamble: role.preamble })}
			onRemove={onRemove}
			canRemove={canRemove && !routingLock}
			removeReason={routingLock ?? (!canRemove ? 'Keep at least one agent.' : undefined)}
		>
			<label className="mt-3 block text-xs text-muted">
				Description — Auto routing reads this to pick {agent.name}
				<textarea
					value={agent.description ?? ''}
					onChange={event => {
						const description = event.target.value
						if (routingLock && isRoutableAgent(agent) && !description.trim()) return
						onChange({ ...agent, description })
					}}
					rows={2}
					maxLength={1000}
					aria-describedby={hintId}
					className="mt-1.5 block w-full resize-y rounded-xl border border-border bg-bg px-2.5 py-2 text-base leading-relaxed outline-none focus:border-accent/60"
				/>
			</label>
			<p id={hintId} className="mt-1 text-[11px] text-faint">
				Leave empty to keep this agent out of Auto routing.
			</p>
			{hasDescription ? (
				<label className="mt-2 flex items-center gap-2 text-xs text-muted">
					<input
						type="checkbox"
						checked={agent.routing !== false}
						disabled={!!routingLock && isRoutableAgent(agent)}
						aria-label={`Use ${agent.name} in Auto routing`}
						onChange={event => onChange({ ...agent, routing: event.target.checked })}
					/>
					Use in Auto routing
				</label>
			) : null}
		</RoleEditorCard>
	)
}
