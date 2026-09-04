import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, LoaderCircle, Plus, Save, Trash2, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
	agentTypeCanExposeEffort,
	agentTypeCanExposeFastMode,
	modelAgentType,
	modelCatalogIncludes
} from '../../../src/shared.ts'
import { useModelCatalog, useRoles } from '../hooks.ts'
import { EFFORT_LABELS } from '../lib/agent.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import type { AgentEffort, CachedModelGroup, DelegatedRole, RolesConfig } from '../lib/types.ts'
import { EffortBars, ProviderMark } from './AgentIcons.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { Spinner } from './ui.tsx'

const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/
const ROLE_EFFORTS: AgentEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

const copyConfig = (config: RolesConfig): RolesConfig => ({
	version: 1,
	roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, { ...role }]))
})

const defaultPreamble = (role: string) =>
	`You are the ${role} agent for this workspace. End your final answer with a \`## Baton\` section: Decision, Evidence, Files changed, Risks, Suggested next role.`

function nextRoleEffort(effort: AgentEffort | undefined, agentType: string | null): AgentEffort | undefined {
	const efforts = agentType === 'codex' ? ROLE_EFFORTS : ROLE_EFFORTS.filter(value => value !== 'none')
	const choices: Array<AgentEffort | undefined> = [undefined, ...efforts]
	const current = choices.indexOf(effort)
	return choices[(current + 1) % choices.length]
}

function roleWithEffort(role: DelegatedRole, effort: AgentEffort | undefined): DelegatedRole {
	const next = { ...role }
	if (effort === undefined) delete next.effort
	else next.effort = effort
	return next
}

/** Selecting a provider also drops settings that provider cannot render. */
export function roleWithModel(role: DelegatedRole, model: string): DelegatedRole {
	const next: DelegatedRole = { ...role, model }
	const agentType = modelAgentType(model)
	if (!agentTypeCanExposeEffort(agentType)) delete next.effort
	if (!agentTypeCanExposeFastMode(agentType)) delete next.fast
	return next
}

export function roleModelProblem(role: DelegatedRole, groups: CachedModelGroup[]): string | null {
	if (!modelCatalogIncludes(role.model, groups)) return 'Choose an exact model from Conductor’s picker.'
	const agentType = modelAgentType(role.model)
	if (!agentType) return 'This model label does not identify a supported provider.'
	if (role.effort !== undefined && !agentTypeCanExposeEffort(agentType)) {
		return 'Conductor does not expose a reasoning control for this provider. Select its model again to clear Effort.'
	}
	if (role.effort === 'none' && agentType !== 'codex') return 'None effort is available only for Codex.'
	if (role.fast !== undefined && !agentTypeCanExposeFastMode(agentType)) {
		return 'Conductor does not expose a Fast control for this provider. Select its model again to clear Fast.'
	}
	return null
}

/** Each cache group is a whole-menu snapshot; provider identity comes from the exact label. */
export function roleAgentType(role: DelegatedRole, groups: CachedModelGroup[]): string | null {
	if (!modelCatalogIncludes(role.model, groups)) return null
	return modelAgentType(role.model) ?? null
}

/** A draft cannot be validated while the picker-backed catalog is still unknown. */
export function roleDraftCanSave(
	dirty: boolean,
	busy: boolean,
	groups: CachedModelGroup[] | undefined,
	invalidCount: number
): boolean {
	return dirty && !busy && groups !== undefined && invalidCount === 0
}

/** Durable role identity shown on a tab even after its successful job file is gone. */
export function RoleChip({ name }: { name: string }) {
	return (
		<span className="max-w-20 shrink-0 truncate rounded bg-accent/10 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-accent">
			{name}
		</span>
	)
}

/** Pure role row, exported so invalid/stale-model behavior can be checked without a browser. */
export function RoleEditorCard({
	name,
	role,
	models,
	agentType = null,
	invalid,
	onChange,
	onRemove,
	canRemove
}: {
	name: string
	role: DelegatedRole
	models: string[]
	agentType?: string | null
	invalid?: string | null
	onChange: (role: DelegatedRole) => void
	onRemove: () => void
	canRemove: boolean
}) {
	const effectiveAgentType = agentType ?? modelAgentType(role.model) ?? null
	const effortAvailable = agentTypeCanExposeEffort(effectiveAgentType)
	const fastAvailable = agentTypeCanExposeFastMode(effectiveAgentType)

	return (
		<section className={cn('rounded-2xl border bg-surface p-3', invalid ? 'border-del/50' : 'border-border')}>
			<div className="mb-2 flex items-center gap-2">
				<RoleChip name={name} />
				<span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
				<button
					type="button"
					disabled={!canRemove}
					onClick={onRemove}
					aria-label={`Remove ${name} role`}
					className="flex size-7 shrink-0 items-center justify-center rounded-lg text-faint active:bg-surface-2 disabled:invisible"
				>
					<Trash2 size={14} />
				</button>
			</div>
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
			<details className="mt-2">
				<summary className="cursor-pointer select-none text-[11px] text-faint">Role preamble</summary>
				<textarea
					value={role.preamble ?? ''}
					onChange={event => onChange({ ...role, preamble: event.target.value })}
					rows={4}
					aria-label={`${name} role preamble`}
					className="mt-1.5 block w-full resize-y rounded-xl border border-border bg-bg px-2.5 py-2 text-base leading-relaxed outline-none focus:border-accent/60"
				/>
			</details>
		</section>
	)
}

/** Global role editor; saving changes relay configuration only and performs no UI write. */
export function RolesSettings({ onClose }: { onClose: () => void }) {
	const queryClient = useQueryClient()
	const rolesQuery = useRoles()
	const modelCatalog = useModelCatalog()
	const [draft, setDraft] = useState<RolesConfig | null>(null)
	const [dirty, setDirty] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [newRole, setNewRole] = useState('')

	useEffect(() => {
		if (rolesQuery.data && !dirty) setDraft(copyConfig(rolesQuery.data))
	}, [rolesQuery.data, dirty])

	const groups = modelCatalog.data?.groups
	const models = useMemo(() => groups?.flatMap(group => group.models) ?? [], [groups])
	const remoteIssues = new Map(rolesQuery.data?.issues.map(issue => [issue.role, issue.error.message]) ?? [])
	const config = draft
	const invalid = new Map<string, string>()
	if (config) {
		for (const [name, role] of Object.entries(config.roles)) {
			const problem = groups ? roleModelProblem(role, groups) : remoteIssues.get(name)
			if (problem) invalid.set(name, problem)
		}
	}

	const changeRole = (name: string, role: DelegatedRole) => {
		if (!config) return
		setDraft({ version: 1, roles: { ...config.roles, [name]: role } })
		setDirty(true)
		setError(null)
	}

	const removeRole = (name: string) => {
		if (!config || Object.keys(config.roles).length <= 1) return
		const { [name]: _removed, ...roles } = config.roles
		setDraft({ version: 1, roles })
		setDirty(true)
	}

	const normalizedNewRole = newRole.trim().toLowerCase().replace(/\s+/g, '-')
	const addError =
		newRole && !ROLE_NAME.test(normalizedNewRole)
			? 'Use lowercase letters, numbers, dashes, or underscores.'
			: normalizedNewRole && config?.roles[normalizedNewRole]
				? 'That role already exists.'
				: null
	const addRole = () => {
		if (!config || !normalizedNewRole || addError) return
		setDraft({
			version: 1,
			roles: {
				...config.roles,
				[normalizedNewRole]: {
					model: 'Choose a model',
					fast: false,
					preamble: defaultPreamble(normalizedNewRole)
				}
			}
		})
		setNewRole('')
		setDirty(true)
	}

	const save = async () => {
		if (!config || !roleDraftCanSave(dirty, busy, groups, invalid.size)) return
		setBusy(true)
		setError(null)
		try {
			const result = await client.updateRoles(config)
			if (!result.ok) {
				setError(result.error.message)
				return
			}
			setDraft(copyConfig(result.config))
			setDirty(false)
			await queryClient.invalidateQueries({ queryKey: ['roles'] })
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return createPortal(
		<div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label="Roles settings">
			<header className="pt-safe flex items-center gap-2 border-b border-border-soft px-3 pb-2.5">
				<div className="min-w-0 flex-1">
					<h2 className="text-[15px] font-semibold">Roles</h2>
					<p className="text-[11px] text-faint">Cross-provider delegated chats</p>
				</div>
				<button
					type="button"
					disabled={!roleDraftCanSave(dirty, busy, groups, invalid.size)}
					onClick={() => void save()}
					className="flex h-9 items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-35"
				>
					{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}
					Save
				</button>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close roles settings"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>

			<div className="pb-safe min-h-0 flex-1 overflow-y-auto p-3">
				{rolesQuery.isLoading && !config ? (
					<Spinner label="Loading roles…" />
				) : rolesQuery.isError && !config ? (
					<p className="rounded-xl border border-del/40 bg-del/5 p-3 text-sm text-del">
						{rolesQuery.error instanceof Error ? rolesQuery.error.message : 'Could not load roles.'}
					</p>
				) : config ? (
					<div className="mx-auto flex max-w-xl flex-col gap-2.5">
						{modelCatalog.isError ? (
							<div className="flex items-center gap-2 rounded-xl border border-del/40 bg-del/5 p-3 text-xs text-del">
								<span className="min-w-0 flex-1">Could not load the saved Conductor model catalog.</span>
								<button
									type="button"
									onClick={() => void modelCatalog.refetch()}
									className="shrink-0 rounded-lg border border-del/40 px-2 py-1 font-semibold"
								>
									Retry
								</button>
							</div>
						) : null}
						{rolesQuery.data?.warning ? (
							<p className="rounded-xl border border-del/40 bg-del/5 p-3 text-xs text-del">
								{rolesQuery.data.warning} The file was preserved; saving replaces it only after validation.
							</p>
						) : null}
						{Object.entries(config.roles).map(([name, role]) => (
							<RoleEditorCard
								key={name}
								name={name}
								role={role}
								models={models}
								agentType={groups ? roleAgentType(role, groups) : null}
								invalid={invalid.get(name)}
								onChange={next => changeRole(name, next)}
								onRemove={() => removeRole(name)}
								canRemove={Object.keys(config.roles).length > 1}
							/>
						))}
						<div className="rounded-2xl border border-dashed border-border p-2.5">
							<div className="flex items-center gap-2">
								<input
									value={newRole}
									onChange={event => setNewRole(event.target.value)}
									onKeyDown={event => {
										if (event.key === 'Enter') addRole()
									}}
									placeholder="Add a role"
									aria-label="New role name"
									className="min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-faint"
								/>
								<button
									type="button"
									disabled={!normalizedNewRole || !!addError}
									onClick={addRole}
									className="flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted active:bg-surface-2 disabled:opacity-35"
								>
									<Plus size={14} /> Add
								</button>
							</div>
							{addError ? <p className="mt-1.5 px-1 text-xs text-del">{addError}</p> : null}
						</div>
						{invalid.size ? (
							<p className="text-xs text-del">Choose the missing picker models before saving or delegating.</p>
						) : null}
						{error ? <p className="rounded-xl border border-del/40 bg-del/5 p-3 text-xs text-del">{error}</p> : null}
						<p className="px-1 text-[11px] leading-relaxed text-faint">
							Roles configure ordinary chats. Changes apply only to future jobs; accepted jobs keep their frozen model
							and effort.
						</p>
					</div>
				) : null}
			</div>
		</div>,
		document.body
	)
}
