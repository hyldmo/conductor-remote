import { decodeAgents } from '../../agents/agent-file.ts'
import { agentsRoles } from '../../agents/agent-store.ts'
import { roleModelIssues } from '../../agents/roles.ts'
import { decodeRoutingConfig, routingIssues } from '../../agents/routing.ts'
import { isRoute, routes } from '../../routes.ts'
import type { AgentsConfig, AgentsResponse, UpdateAgentsResult } from '../../wire.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createAgentsRoutes(
	services: Pick<RelayServices, 'agentStore' | 'routingConfig' | 'modelCache' | 'readBody' | 'json'>
): RouteHandler {
	const { agentStore, routingConfig, modelCache, readBody, json } = services
	const issuesFor = (config: AgentsConfig) =>
		roleModelIssues(agentsRoles(config.agents), modelCache.list()).map(({ role, error }) => ({ agent: role, error }))
	function response(): AgentsResponse {
		const stored = agentStore.read()
		return { ...stored, issues: issuesFor(stored) }
	}
	return async (req, res, url) => {
		if (isRoute(routes.agents, req.method, url.pathname)) return json(req, res, 200, response())
		if (isRoute(routes.updateAgents, req.method, url.pathname)) {
			let config: AgentsConfig
			try {
				config = decodeAgents(JSON.parse((await readBody(req)) || '{}'))
			} catch (error) {
				return json(req, res, 400, {
					ok: false,
					error: {
						code: 'invalid_request',
						message: error instanceof Error ? error.message : String(error),
						retryable: false
					}
				} satisfies UpdateAgentsResult)
			}
			const issues = issuesFor(config)
			if (issues.length)
				return json(req, res, 409, { ok: false, error: issues[0].error, issues } satisfies UpdateAgentsResult)
			const written = agentStore.write(config)
			if (!written.ok) {
				return json(req, res, 500, {
					ok: false,
					error: { code: 'state_invalid', message: written.error, retryable: true }
				} satisfies UpdateAgentsResult)
			}
			return json(req, res, 200, { ok: true, config: response() } satisfies UpdateAgentsResult)
		}
		if (isRoute(routes.routing, req.method, url.pathname)) {
			const config = routingConfig.read()
			return json(req, res, 200, { config, issues: routingIssues(config, agentStore.read().agents, modelCache.list()) })
		}
		if (isRoute(routes.updateRouting, req.method, url.pathname)) {
			try {
				const config = decodeRoutingConfig(JSON.parse(await readBody(req)))
				const issues = routingIssues(config, agentStore.read().agents, modelCache.list())
				if (issues.length) return json(req, res, 400, { error: issues.join(' '), issues })
				routingConfig.write(config)
				return json(req, res, 200, { config: routingConfig.read(), issues: [] })
			} catch (error) {
				return json(req, res, 400, { error: error instanceof Error ? error.message : 'Invalid routing settings.' })
			}
		}
		return NOT_HANDLED
	}
}
