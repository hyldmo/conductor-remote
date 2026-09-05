import {
	agentTypeCanExposeEffort,
	agentTypeCanExposeFastMode,
	currentModelCatalog,
	modelAgentType,
	modelPickerLabel
} from '../../../src/shared.ts'
import type { AgentEffort, CachedModelGroup, DelegatedRole } from './types.ts'

const ROLE_EFFORTS: AgentEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

export function nextRoleEffort(effort: AgentEffort | undefined, agentType: string | null): AgentEffort | undefined {
	const efforts = agentType === 'codex' ? ROLE_EFFORTS : ROLE_EFFORTS.filter(value => value !== 'none')
	const choices: Array<AgentEffort | undefined> = [undefined, ...efforts]
	const current = choices.indexOf(effort)
	return choices[(current + 1) % choices.length]
}

export function roleWithEffort(role: DelegatedRole, effort: AgentEffort | undefined): DelegatedRole {
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
	if (!currentModelCatalog(groups).includes(modelPickerLabel(role.model))) {
		return 'Choose an exact model from Conductor’s current picker catalog.'
	}
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

/** Each provider uses its latest observed menu; identity comes from the exact model label. */
export function roleAgentType(role: DelegatedRole, groups: CachedModelGroup[]): string | null {
	if (!currentModelCatalog(groups).includes(modelPickerLabel(role.model))) return null
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
