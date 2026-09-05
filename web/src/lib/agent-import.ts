import type { QueryClient } from '@tanstack/react-query'
import { client } from './api.ts'
import type { AgentDefinition, AgentsConfig, ImportAgentsRequest, ImportAgentsResult } from './types.ts'

/** Imported replacements update unchanged fields; unsaved edits, additions and removals keep their intent. */
export function mergeImportedAgents(
	draft: AgentsConfig,
	before: AgentsConfig,
	result: ImportAgentsResult
): AgentsConfig {
	const imported = new Set(result.results.filter(outcome => outcome.ok).map(outcome => outcome.name))
	const saved = new Map(before.agents.map(agent => [agent.name, agent]))
	const incoming = new Map(
		result.config.agents.filter(agent => imported.has(agent.name)).map(agent => [agent.name, agent])
	)
	const fields = ['model', 'description', 'effort', 'fast', 'routing', 'preamble'] as const
	const agents = draft.agents.map((agent): AgentDefinition => {
		const previous = saved.get(agent.name)
		const replacement = incoming.get(agent.name)
		if (!previous || !replacement) return agent
		return {
			...replacement,
			...Object.fromEntries(fields.filter(key => agent[key] !== previous[key]).map(key => [key, agent[key]]))
		}
	})
	const localNames = new Set(agents.map(agent => agent.name))
	for (const agent of incoming.values()) {
		// A previously saved name missing from the draft was deliberately removed locally.
		if (!localNames.has(agent.name) && !saved.has(agent.name)) agents.push({ ...agent })
	}
	return { version: 1, agents }
}

export async function importAgentDefinitions(
	queryClient: QueryClient,
	request: ImportAgentsRequest
): Promise<ImportAgentsResult> {
	const result = await client.importAgents(request)
	queryClient.setQueryData(['agents'], result.config)
	await Promise.all(
		['agents', 'routing', 'roles', 'auto-model-config', 'agent-import-candidates'].map(key =>
			queryClient.invalidateQueries({ queryKey: [key] })
		)
	)
	return result
}
