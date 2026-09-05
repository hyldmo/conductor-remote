import { decodeImportAgents, scanClaudeAgents } from '../../agents/agent-import.ts'
import { isRoute, routes } from '../../routes.ts'
import type { AgentImportOutcome, AgentsResponse, ImportAgentsRequest, ImportAgentsResult } from '../../wire.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createAgentImportRoutes(
	services: Pick<RelayServices, 'agentStore' | 'readBody' | 'json'>,
	agentsResponse: () => AgentsResponse
): RouteHandler {
	const { agentStore, readBody, json } = services
	return async (req, res, url) => {
		if (isRoute(routes.agentImportCandidates, req.method, url.pathname))
			return json(req, res, 200, scanClaudeAgents(agentStore).response)
		if (!isRoute(routes.importAgents, req.method, url.pathname)) return NOT_HANDLED
		let request: ImportAgentsRequest
		try {
			request = decodeImportAgents(JSON.parse(await readBody(req)))
		} catch (error) {
			return json(req, res, 400, { error: error instanceof Error ? error.message : 'Invalid import request.' })
		}
		const { response, sources } = scanClaudeAgents(agentStore)
		const skipped = new Map(response.skipped.map(entry => [entry.name, entry.reason]))
		const results = request.names.map((name): AgentImportOutcome => {
			if (request.names.indexOf(name) !== request.names.lastIndexOf(name))
				return { name, ok: false, error: 'This name was requested more than once. Select each agent only once.' }
			const bytes = sources.get(name)
			if (!bytes)
				return {
					name,
					ok: false,
					error: skipped.get(name) ?? 'No importable file with this name was found in the scan. Refresh the list.'
				}
			return agentStore.importFile(name, bytes, request.overwrite)
		})
		return json(req, res, 200, { results, config: agentsResponse() } satisfies ImportAgentsResult)
	}
}
