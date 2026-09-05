import {
	agentTypeCanExposeEffort,
	agentTypeCanExposeFastMode,
	modelAgentType,
	modelLabel,
	modelPickerLabel,
	shortModel
} from '../shared.ts'

/** The durable fields needed to compare a requested role snapshot with one chat. */
export interface AgentConfigState {
	agentType: string | null
	model: string | null
	effort: string | null
	plan: boolean
	fast: boolean
}

/** One UI pass. Model changes deliberately never share a pass with rerendered controls. */
export interface AgentConfigWrite {
	model?: string
	effort?: string
	plan?: boolean
	toggleFast?: boolean
	/** Selects provider-specific UI spellings such as Codex's “Ultra”. */
	agentType?: string | null
}

export interface AgentConfigPatch {
	model?: string
	effort?: string
	plan?: boolean
	fast?: boolean
}

interface AgentConfigDeps {
	read: () => AgentConfigState | undefined
	write: (options: AgentConfigWrite) => Promise<{ ok: boolean; error?: string }>
	wait: () => Promise<void>
	confirmAttempts?: number
}

function modelMatches(state: AgentConfigState, requested: string, allowPrefix = false): boolean {
	const label = modelPickerLabel(requested).trim()
	const expectedAgentType = modelAgentType(label)
	const actualLabel = modelPickerLabel(modelLabel(state.model, [label]))
	const stored = shortModel(state.model).toLowerCase()
	const wanted = label.toLowerCase()
	const selected =
		actualLabel.toLowerCase() === wanted ||
		stored === wanted ||
		stored.endsWith(`:${wanted}`) ||
		(allowPrefix && actualLabel.toLowerCase().startsWith(wanted))
	return (!expectedAgentType || state.agentType === expectedAgentType) && selected
}

function matches(state: AgentConfigState, patch: AgentConfigPatch): boolean {
	return (
		(!patch.model || modelMatches(state, patch.model, true)) &&
		(!patch.effort || state.effort === patch.effort) &&
		(patch.plan === undefined || state.plan === patch.plan) &&
		(patch.fast === undefined || state.fast === patch.fast)
	)
}

async function confirm(
	deps: AgentConfigDeps,
	predicate: (state: AgentConfigState) => boolean
): Promise<AgentConfigState | undefined> {
	const attempts = deps.confirmAttempts ?? 10
	for (let attempt = 0; attempt < attempts; attempt++) {
		const current = deps.read()
		if (current && predicate(current)) return current
		if (attempt + 1 < attempts) await deps.wait()
	}
	return undefined
}

function modelFailure(model: string): string {
	const agentType = modelAgentType(model)
	const provider = agentType === 'claude' ? 'Claude' : agentType === 'codex' ? 'Codex' : agentType
	return provider
		? `Conductor did not record model ${model} on the expected ${provider} provider.`
		: `Conductor did not record model ${model}.`
}

/**
 * Apply one desired role snapshot without holding stale AX references across a
 * provider-changing rerender. The model gets its own UI pass and DB receipt;
 * only then are the new provider's controls reacquired and changed by delta.
 */
export async function applyAgentConfig(
	patch: AgentConfigPatch,
	deps: AgentConfigDeps
): Promise<{ ok: boolean; error?: string }> {
	let current = deps.read()
	if (!current) return { ok: false, error: 'the chat is gone' }

	if (patch.model && !modelMatches(current, patch.model)) {
		const requestedModel = patch.model
		const selected = await deps.write({ model: requestedModel })
		if (!selected.ok) return selected
		// setModel accepts a unique picker prefix. It has already proved uniqueness
		// before this receipt, so the stored full label may legitimately be longer.
		current = await confirm(deps, state => modelMatches(state, requestedModel, true))
		if (!current) return { ok: false, error: modelFailure(requestedModel) }
	}

	if (patch.effort !== undefined && !agentTypeCanExposeEffort(current.agentType)) {
		return { ok: false, error: 'Conductor does not expose a reasoning control for the selected provider.' }
	}
	if (patch.fast !== undefined && !agentTypeCanExposeFastMode(current.agentType)) {
		return { ok: false, error: 'Conductor does not expose a Fast control for the selected provider.' }
	}

	const controls: AgentConfigWrite = {}
	if (patch.effort && current.effort !== patch.effort) controls.effort = patch.effort
	if (patch.plan !== undefined && current.plan !== patch.plan) controls.plan = patch.plan
	if (patch.fast !== undefined && current.fast !== patch.fast) controls.toggleFast = true

	if (Object.keys(controls).length) {
		controls.agentType = current.agentType
		const applied = await deps.write(controls)
		if (!applied.ok) return applied
	}

	const recorded = await confirm(deps, state => matches(state, patch))
	if (!recorded) {
		return { ok: false, error: 'Conductor did not record every requested agent setting.' }
	}
	return { ok: true }
}
