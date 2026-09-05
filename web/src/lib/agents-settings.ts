import type { QueryClient } from '@tanstack/react-query'
import { ApiError, client } from './api.ts'
import { roleModelProblem } from './role-editor.ts'
import type {
	AgentDefinition,
	AgentsConfig,
	AgentsResponse,
	AutoModelTuple,
	CachedModelGroup,
	RoutingConfig,
	RoutingConfigResponse
} from './types.ts'

export const MAX_AGENTS = 32
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/

export const copyAgents = (config: AgentsConfig): AgentsConfig => ({
	version: 1,
	agents: config.agents.map(agent => ({ ...agent }))
})

export const normalizeAgentName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-')

export function newAgentProblem(name: string, agents: AgentDefinition[]): string | null {
	if (agents.length >= MAX_AGENTS) return `Keep at most ${MAX_AGENTS} agents.`
	if (name && !AGENT_NAME.test(name))
		return 'Start with a letter; use up to 64 lowercase letters, numbers, dashes, or underscores.'
	if (agents.some(agent => agent.name === name)) return 'That agent already exists.'
	return null
}

export function isRoutableAgent(agent: AgentDefinition): boolean {
	return !!agent.description?.trim() && agent.routing !== false
}

/** Keep both fallbacks usable until the agents-first save has finished. */
export function agentRoutingLock(name: string, fallback: string, savedFallback: string): string | undefined {
	if (name === fallback)
		return 'Choose and save a different fallback before removing this agent or turning off Auto routing. The fallback needs a description.'
	if (name === savedFallback) return 'Save the new fallback before removing this agent or turning off Auto routing.'
	return undefined
}

export function isRouterModel(model: string): boolean {
	return (
		/^(?:GPT-)?\d[\d.]*(?: (?:Luna|Terra|Sol|Astra))?$/.test(model) ||
		/^opencode(?:-go)?\/muse-spark-[a-z0-9.-]+-contributor(?:-free)?$/.test(model)
	)
}

export function routerModelProblem(router: AutoModelTuple, groups: CachedModelGroup[]): string | null {
	return (
		roleModelProblem(router, groups) ??
		(!isRouterModel(router.model)
			? 'The router supports Codex models and the exact Muse Spark OpenCode options.'
			: router.effort === 'ultracode'
				? 'The router CLI supports reasoning effort up to max.'
				: null)
	)
}

export function routingDraftProblems(config: RoutingConfig, agents: AgentDefinition[]): string[] {
	const issues: string[] = []
	if (!agents.some(agent => agent.name === config.fallback && isRoutableAgent(agent)))
		issues.push('Choose a fallback agent with a description and Auto routing enabled.')
	if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 2000 || config.timeoutMs > 30000)
		issues.push('Maximum selection time must be between 2 and 30 seconds.')
	if (config.rules.length > 12000) issues.push('Keep routing rules within 12,000 characters.')
	return issues
}

export interface AgentsSettingsSaveResult {
	agents?: AgentsResponse
	routing?: RoutingConfigResponse
	error?: string
	agentIssues?: AgentsResponse['issues']
	routingIssues?: string[]
}

/** A partial save is a receipt too: retry only the half whose PATCH did not succeed. */
export async function saveAgentsSettings(
	queryClient: QueryClient,
	agents?: AgentsConfig,
	routing?: RoutingConfig
): Promise<AgentsSettingsSaveResult> {
	const result: AgentsSettingsSaveResult = {}
	let half: 'agents' | 'routing' = agents ? 'agents' : 'routing'
	try {
		if (agents) {
			const saved = await client.updateAgents(copyAgents(agents))
			if (!saved.ok) {
				result.error = saved.error.message
				result.agentIssues = saved.issues
				return result
			}
			result.agents = saved.config
			queryClient.setQueryData(['agents'], saved.config)
		}
		if (routing) {
			half = 'routing'
			result.routing = await client.updateRouting(routing)
			queryClient.setQueryData(['routing'], result.routing)
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		result.error = result.agents ? `Agents saved. Auto routing was not saved: ${message}` : message
		if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'issues' in error.body) {
			// These are the endpoint's wire issues, retained by ApiError on non-2xx responses.
			if (half === 'agents') result.agentIssues = error.body.issues as AgentsResponse['issues']
			else result.routingIssues = error.body.issues as string[]
		}
	} finally {
		if (result.agents || result.routing) {
			await Promise.all(
				['agents', 'routing', 'roles', 'auto-model-config'].map(key =>
					queryClient.invalidateQueries({ queryKey: [key] })
				)
			)
		}
	}
	return result
}
