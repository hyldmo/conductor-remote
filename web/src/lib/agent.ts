import { AGENT_EFFORTS } from '../../../src/shared.ts'
import type { DefaultEfforts } from './types.ts'

export const EFFORT_LABELS: Record<string, string> = {
	none: 'None',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultracode: 'Ultracode'
}

/** Phone taps keep their existing Low→Ultracode cycle; a stored Codex None advances to Low. */
export const EFFORT_ORDER = AGENT_EFFORTS.filter(effort => effort !== 'none')

export function nextEffort(effort: string | undefined) {
	const choices: readonly string[] = EFFORT_ORDER
	return EFFORT_ORDER[(choices.indexOf(effort ?? '') + 1) % EFFORT_ORDER.length]
}

export type AgentProvider = 'claude' | 'cursor' | 'openai' | 'opencode'

/** Infer the provider from Conductor's model labels, then fall back to its session harness. */
export function providerForAgent(agentType: string | null, model: string | null): AgentProvider | undefined {
	const label = model?.toLowerCase() ?? ''
	if (/^(?:anthropic\/|claude|fable|haiku|opus|sonnet)/.test(label)) return 'claude'
	if (/^(?:openai\/|gpt|o[1-9]|\d)/.test(label)) return 'openai'
	if (/^(?:cursor\/|composer|grok)/.test(label)) return 'cursor'
	if (/^opencode(?:-go)?\//.test(label)) return 'opencode'

	const agent = agentType?.toLowerCase()
	if (agent === 'claude' || agent === 'anthropic') return 'claude'
	if (agent === 'codex' || agent === 'openai') return 'openai'
	if (agent === 'cursor') return 'cursor'
	if (agent === 'acp' || agent === 'opencode') return 'opencode'
	return undefined
}

/** Conductor currently renders its Plan toggle only for Claude-backed models. */
export function supportsPlanMode(agentType: string | null, model: string | null): boolean {
	return providerForAgent(agentType, model) === 'claude'
}

/** Conductor currently renders per-session reasoning controls only for these harnesses. */
export function supportsEffortControl(agentType: string | null, model: string | null): boolean {
	const provider = providerForAgent(agentType, model)
	return provider === 'claude' || provider === 'openai'
}

/** Conductor currently renders its Fast control only for these harnesses. */
export function supportsFastMode(agentType: string | null, model: string | null): boolean {
	const provider = providerForAgent(agentType, model)
	return provider === 'claude' || provider === 'openai'
}

/** The configured effort a new chat inherits from the provider selected by its model. */
export function defaultEffortForModel(model: string | null, defaults: DefaultEfforts | undefined): string | undefined {
	const provider = providerForAgent(null, model)
	const effort = provider === 'claude' ? defaults?.claude : provider === 'openai' ? defaults?.codex : undefined
	return EFFORT_ORDER.find(value => value === effort)
}

/** Advance the visible value, dropping the override when the cycle reaches the inherited default. */
export function nextEffortOverride(effort: string | undefined, inherited: string | undefined) {
	const next = nextEffort(effort)
	if (next === inherited || (!inherited && effort === EFFORT_ORDER.at(-1))) return undefined
	return next
}
