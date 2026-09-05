import { AlertTriangle, Trash2, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { agentTypeCanExposeEffort, agentTypeCanExposeFastMode, modelAgentType } from '../../../../src/shared.ts'
import { EFFORT_LABELS } from '../../lib/agent.ts'
import { cn } from '../../lib/cn.ts'
import { nextRoleEffort, roleWithEffort, roleWithModel } from '../../lib/role-editor.ts'
import type { DelegatedRole } from '../../lib/types.ts'
import { RoleChip } from '../orchestration/RoleChip.tsx'
import { EffortBars, ProviderMark } from './AgentIcons.tsx'
import { ModelPicker } from './ModelPicker.tsx'

/** Pure role row, exported so invalid/stale-model behavior can be checked without a browser. */
export function RoleEditorCard({
	name,
	role,
	models,
	agentType = null,
	invalid,
	onChange,
	onRemove,
	canRemove = false,
	removeReason,
	showPreamble = true,
	children
}: {
	name: string
	role: DelegatedRole
	models: string[]
	agentType?: string | null
	invalid?: string | null
	onChange: (role: DelegatedRole) => void
	onRemove?: () => void
	canRemove?: boolean
	removeReason?: string
	showPreamble?: boolean
	children?: ReactNode
}) {
	const effectiveAgentType = agentType ?? modelAgentType(role.model) ?? null
	const effortAvailable = agentTypeCanExposeEffort(effectiveAgentType)
	const fastAvailable = agentTypeCanExposeFastMode(effectiveAgentType)

	return (
		<section className={cn('rounded-2xl border bg-surface p-3', invalid ? 'border-del/50' : 'border-border')}>
			<div className="mb-2 flex items-center gap-2">
				<RoleChip name={name} />
				<span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
				{onRemove ? (
					<button
						type="button"
						disabled={!canRemove}
						onClick={onRemove}
						aria-label={`Remove ${name} agent`}
						className="flex size-7 shrink-0 items-center justify-center rounded-lg text-faint active:bg-surface-2 disabled:opacity-35"
					>
						<Trash2 size={14} />
					</button>
				) : null}
			</div>
			{removeReason ? <p className="mb-2 text-[11px] text-faint">{removeReason}</p> : null}
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<ModelPicker
					value={role.model}
					models={models}
					placement="below"
					empty="No picker models are cached yet."
					onSelect={model => onChange(roleWithModel(role, model))}
					renderTrigger={({ picking, toggle }) => (
						<button
							type="button"
							onClick={toggle}
							aria-label={`Choose model for ${name}, currently ${role.model}`}
							aria-haspopup="menu"
							aria-expanded={picking}
							className={cn(
								'flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-lg border px-2 text-xs active:bg-surface-2',
								invalid ? 'border-del text-del' : 'border-border text-muted'
							)}
						>
							<ProviderMark agentType={agentType} model={role.model} className="size-3.5" />
							<span className="truncate">{role.model}</span>
						</button>
					)}
				/>
				{effortAvailable ? (
					<button
						type="button"
						onClick={() => onChange(roleWithEffort(role, nextRoleEffort(role.effort, effectiveAgentType)))}
						aria-label={`Reasoning effort for ${name}: ${role.effort ? EFFORT_LABELS[role.effort] : 'default'}`}
						className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-muted active:bg-surface-2"
					>
						<EffortBars effort={role.effort ?? ''} />
						{role.effort ? EFFORT_LABELS[role.effort] : 'Effort'}
					</button>
				) : null}
				{fastAvailable ? (
					<button
						type="button"
						onClick={() => onChange({ ...role, fast: !role.fast })}
						aria-label={`Fast mode for ${name} ${role.fast ? 'on' : 'off'}`}
						aria-pressed={role.fast === true}
						className={cn(
							'flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted active:bg-surface-2',
							role.fast && 'bg-surface-2 text-text'
						)}
					>
						<Zap size={13} /> Fast
					</button>
				) : null}
			</div>
			{invalid ? (
				<p className="mt-2 flex items-start gap-1.5 text-xs text-del">
					<AlertTriangle size={13} className="mt-0.5 shrink-0" />
					<span>{invalid}</span>
				</p>
			) : null}
			{children}
			{showPreamble ? (
				<details className="mt-2">
					<summary className="cursor-pointer select-none text-[11px] text-faint">Role instructions</summary>
					<p className="mt-1 text-[11px] text-faint">
						Applied to delegated chats only. Auto routing uses the model settings above.
					</p>
					<textarea
						value={role.preamble ?? ''}
						onChange={event => onChange({ ...role, preamble: event.target.value })}
						rows={4}
						maxLength={50000}
						aria-label={`${name} role preamble`}
						className="mt-1.5 block w-full resize-y rounded-xl border border-border bg-bg px-2.5 py-2 text-base leading-relaxed outline-none focus:border-accent/60"
					/>
				</details>
			) : null}
		</section>
	)
}
