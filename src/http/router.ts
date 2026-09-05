import http from 'node:http'

import { UiBusyError, uiQueueDepth, withUiPriority } from '../writes/ui-lock.ts'
import { NOT_HANDLED } from './router-types.ts'
import { createAutoModelRoutes } from './routes/auto-model.ts'
import { createCreateWorkspaceRoutes } from './routes/create-workspace.ts'
import { createFilesRoutes } from './routes/files.ts'
import { createPromptsRoutes } from './routes/prompts.ts'
import { createSessionsRoutes } from './routes/sessions.ts'
import { createStateRoutes } from './routes/state.ts'
import { createSystemRoutes } from './routes/system.ts'
import { createVoiceRoutes } from './routes/voice.ts'
import { createWorkflowsRoutes } from './routes/workflows.ts'
import { createWorkspacesRoutes } from './routes/workspaces.ts'
import type { RelayServices } from './services.ts'

export function createRelayServer(services: RelayServices) {
	const { handleMcpHttp, serveStatic, authed, json, PayloadTooLargeError, workflowHttpError } = services
	const handlers = [
		createAutoModelRoutes(services),
		createStateRoutes(services),
		createWorkflowsRoutes(services),
		createVoiceRoutes(services),
		createSystemRoutes(services),
		createCreateWorkspaceRoutes(services),
		createFilesRoutes(services),
		createWorkspacesRoutes(services),
		createSessionsRoutes(services),
		createPromptsRoutes(services)
	]

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://x')
		const { pathname } = url

		// POST /mcp — the MCP Streamable HTTP transport, for a client that can only reach a
		// URL (an agent on another machine, or a hosted one). Same tools as
		// `conductor-remote mcp`'s stdio, same token gate as /api/*, and — because this runs
		// *inside* the relay — the same UI lock, with no second process to sit outside it.
		//
		// Deliberately minimal: this server never initiates a message, so there is no SSE
		// stream to open and GET is answered 405, which the spec allows. It keeps no session
		// either, so no `Mcp-Session-Id` is issued and every request stands alone.
		if (pathname === '/mcp') return handleMcpHttp(req, res)

		if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname)

		// Everything under /api requires the shared secret.
		if (!authed(req)) return json(req, res, 401, { error: 'unauthorized' })

		// Who is asking decides who waits for Conductor's window. An agent (src/mcp.ts sets
		// this header) yields the UI lock to the person holding the phone — see src/writes/ui-lock.ts ▸
		// uiTurn. Anything unlabelled is treated as the person, because the phone is the
		// only caller that predates the header and mislabelling it would be the bad way round.
		const priority = req.headers['x-relay-client'] === 'mcp' ? 'background' : 'interactive'
		return withUiPriority(priority, async () => {
			try {
				for (const handler of handlers) {
					if ((await handler(req, res, url)) !== NOT_HANDLED) return
				}
				return json(req, res, 404, { error: 'no route', pathname })
			} catch (err) {
				if (err instanceof PayloadTooLargeError) return json(req, res, 413, { error: err.message })
				const workflowError = workflowHttpError(err)
				if (workflowError) {
					console.warn(
						`[workflow] ${req.method} ${pathname}: ${workflowError.error.code}: ${workflowError.error.message}`
					)
					return json(req, res, workflowError.status, { ok: false, error: workflowError.error })
				}
				// A refused UI turn is not a server fault and a retry is the right move, so it gets
				// 503 + Retry-After rather than a 500 that reads as "the relay is broken".
				if (err instanceof UiBusyError) {
					res.setHeader('retry-after', '15')
					return json(req, res, 503, { error: err.message, busy: true, queue: uiQueueDepth() })
				}
				// Log the detail locally; don't reflect internals (paths, stack strings) back over the wire.
				console.error(`[relay] ${req.method} ${pathname} failed:`, err)
				return json(req, res, 500, { error: 'internal error' })
			}
		})
	})
	return server
}
