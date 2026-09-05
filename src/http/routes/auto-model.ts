import { autoModelIssues, decodeAutoModelConfig } from '../../agents/auto-model/config.ts'
import { isRoute, routes } from '../../routes.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createAutoModelRoutes(
	services: Pick<RelayServices, 'autoModelConfig' | 'modelCache' | 'readBody' | 'json'>
): RouteHandler {
	const { autoModelConfig, modelCache, readBody, json } = services
	return async (req, res, url) => {
		if (isRoute(routes.autoModelConfig, req.method, url.pathname)) {
			const config = autoModelConfig.read()
			return json(req, res, 200, { config, issues: autoModelIssues(config, modelCache.list()) })
		}
		if (isRoute(routes.updateAutoModelConfig, req.method, url.pathname)) {
			try {
				const config = decodeAutoModelConfig(JSON.parse(await readBody(req)))
				const issues = autoModelIssues(config, modelCache.list())
				if (issues.length) return json(req, res, 400, { error: issues.join(' ') })
				autoModelConfig.write(config)
				return json(req, res, 200, { config, issues: [] })
			} catch {
				return json(req, res, 400, { error: 'Invalid Auto settings. Check the profiles, fallback, and router.' })
			}
		}
		return NOT_HANDLED
	}
}
