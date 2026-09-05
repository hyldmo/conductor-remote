import { writeAttachment } from '../../files/attachments.ts'

import { noteViewing } from '../../notifications/notify.ts'

import { routeParam, routes } from '../../routes.ts'

import { VIEWING_HEADER } from '../../shared.ts'
import { EFFORT_LABELS, listAgentModels, setDefaultModel } from '../../writes/agent-options.ts'
import { closeChat, restoreChat, stopTurn } from '../../writes/chats.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createSessionsRoutes(
	services: Pick<
		RelayServices,
		| 'json'
		| 'reads'
		| 'workflowFrozenError'
		| 'locateChat'
		| 'modelCache'
		| 'readBody'
		| 'applyAgentPatch'
		| 'actuator'
		| 'sleep'
		| 'attachmentHeaderName'
		| 'readAttachmentBody'
	>
): RouteHandler {
	const {
		json,
		reads,
		workflowFrozenError,
		locateChat,
		modelCache,
		readBody,
		applyAgentPatch,
		actuator,
		sleep,
		attachmentHeaderName,
		readAttachmentBody
	} = services
	return async (req, res, url) => {
		const { pathname } = url

		// GET /api/sessions/:id/messages?after=<rowid>
		const messagesOf = routeParam(routes.messages, req.method, pathname)

		if (messagesOf) {
			// The phone's 1s transcript poll doubles as its "I am reading this chat" heartbeat,
			// which is what keeps a turn ending on screen from also buzzing the lock screen
			// (src/notifications/notify.ts). Only this route is a claim: it is the one read that runs for the
			// chat on screen and for no other.
			const device = req.headers[VIEWING_HEADER]
			if (typeof device === 'string' && device) noteViewing(device, messagesOf)
			const after = Number(url.searchParams.get('after') ?? 0)
			return json(req, res, 200, reads.getMessages(messagesOf, Number.isFinite(after) ? after : 0))
		}

		// GET /api/sessions/:id/context — expensive enough to stay off the session poll.
		const contextOf = routeParam(routes.context, req.method, pathname)

		if (contextOf) {
			const breakdown = reads.getContextBreakdown(contextOf)
			if (!breakdown) return json(req, res, 404, { error: 'chat not found' })
			return json(req, res, 200, breakdown)
		}

		// GET /api/sessions/:id/models?workspaceId= — labels from Conductor's live picker
		const modelsOf = routeParam(routes.models, req.method, pathname)

		if (modelsOf) {
			const sessionId = modelsOf
			const frozen = workflowFrozenError(sessionId)
			if (frozen) return json(req, res, 409, frozen)
			const ws = reads.getWorkspace(url.searchParams.get('workspaceId') ?? '')
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			const result = await listAgentModels({ workspace: ws, sessionId, tab: located.tab })
			if (result.ok && result.models)
				modelCache.remember(located.session?.agent_type, result.models, result.defaultModel)
			return json(req, res, result.ok ? 200 : 502, result)
		}

		// POST /api/sessions/:id/default-model { model, workspaceId? }
		// The picker star is a combined "set default and select" action, so this
		// changes both the user-wide default and this chat's model exactly as the
		// desktop control does.
		const defaultModelOf = routeParam(routes.defaultModel, req.method, pathname)

		if (defaultModelOf) {
			const sessionId = defaultModelOf
			const frozen = workflowFrozenError(sessionId)
			if (frozen) return json(req, res, 409, frozen)
			const body = JSON.parse((await readBody(req)) || '{}') as { model?: unknown; workspaceId?: unknown }
			if (typeof body.model !== 'string' || !body.model.trim()) {
				return json(req, res, 400, { error: 'model must be a picker label' })
			}
			const ws =
				typeof body.workspaceId === 'string'
					? reads.getWorkspace(body.workspaceId)
					: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			const result = await setDefaultModel({ workspace: ws, sessionId, tab: located.tab }, body.model.trim())
			if (!result.ok || !result.model) {
				return json(req, res, 502, { ok: false, error: result.error ?? 'the default model did not change' })
			}
			const session = reads.listSessions(ws.id).find(row => row.id === sessionId)
			modelCache.rememberModel(session?.agent_type, result.model)
			modelCache.rememberDefault(result.model)
			return json(req, res, 200, { ok: true, defaultModel: result.model, session })
		}

		// POST /api/sessions/:id/agent  { effort?, plan?, fast?, model? }
		// Drives the composer's own model/effort/plan/fast controls for one chat.
		const agentOf = routeParam(routes.agent, req.method, pathname)

		if (agentOf) {
			const sessionId = agentOf
			const body = JSON.parse((await readBody(req)) || '{}') as {
				effort?: string
				plan?: boolean
				fast?: boolean
				model?: string
				workspaceId?: string
			}
			if (body.effort && !EFFORT_LABELS[body.effort]) {
				return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
			}
			const frozen = workflowFrozenError(sessionId)
			if (frozen && (body.model !== undefined || body.effort !== undefined || body.fast !== undefined)) {
				return json(req, res, 409, frozen)
			}
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const applied = await applyAgentPatch(ws, sessionId, body)
			if (!applied.ok) return json(req, res, 502, { ok: false, strategy: actuator.name, error: applied.error })
			return json(req, res, 200, { ok: true, session: reads.listSessions(ws.id).find(s => s.id === sessionId) })
		}

		// POST /api/sessions/:id/stop — the desktop app's stop button, for one chat.
		const stopOf = routeParam(routes.stop, req.method, pathname)

		if (stopOf) {
			const sessionId = stopOf
			const body = JSON.parse((await readBody(req)) || '{}') as { workspaceId?: string }
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			// Nothing running is a success, not an error: the phone shows Stop the moment it
			// sends (the optimistic hint) and a turn that ends on its own a beat before the tap
			// is the common case, not a mistake worth a red banner. It also keeps the one
			// keystroke this route presses off an idle chat entirely — Conductor's own
			// composer has no stop button to mis-tap there either.
			const before = reads.listSessions(ws.id).find(s => s.id === sessionId)
			if (before?.status !== 'working') {
				return json(req, res, 200, { ok: true, alreadyIdle: true, session: before })
			}
			const result = await stopTurn({ workspace: ws, sessionId, tab: located.tab })
			if (!result.ok) return json(req, res, 502, result)
			// The DB is the receipt, exactly as it is for agent settings: the keystroke is
			// fire-and-forget, so what counts is `status` leaving `working`. Conductor writes
			// that a beat after it tears the turn down.
			let observed = before.status
			for (let i = 0; i < 20 && observed === 'working'; i++) {
				await sleep(300)
				observed = reads.listSessions(ws.id).find(s => s.id === sessionId)?.status ?? observed
			}
			if (observed === 'working') {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor took the stop but the agent is still working. Try again, or stop it on your Mac.'
				})
			}
			return json(req, res, 200, {
				ok: true,
				strategy: result.strategy,
				session: reads.listSessions(ws.id).find(s => s.id === sessionId)
			})
		}

		const restoreChatId = routeParam(routes.restoreChat, req.method, pathname)

		if (restoreChatId) {
			const body = JSON.parse((await readBody(req)) || '{}') as { workspaceId?: string }
			const ownerId = reads.sessionWorkspaceId(restoreChatId)
			if (!ownerId) return json(req, res, 404, { error: 'chat not found' })
			if (body.workspaceId && body.workspaceId !== ownerId) {
				return json(req, res, 409, { error: 'chat is not in that workspace' })
			}
			if (!reads.getWorkspace(ownerId)) {
				return json(req, res, 409, { error: 'Restore this workspace in Conductor before restoring its tabs.' })
			}
			const result = await restoreChat(ownerId, restoreChatId, () => reads.getSession(restoreChatId) !== null)
			if (!result.ok) return json(req, res, 502, result)
			return json(req, res, 200, { ...result, session: reads.getSession(restoreChatId) })
		}

		// DELETE /api/sessions/:id { workspaceId?, closeRunning? } — Conductor's
		// reversible Close tab action (Command-W). A running chat gets the same
		// explicit "Close anyway" gate as the desktop app.
		const closeChatId = routeParam(routes.closeChat, req.method, pathname)

		if (closeChatId) {
			const sessionId = closeChatId
			const body = JSON.parse((await readBody(req)) || '{}') as {
				workspaceId?: string
				closeRunning?: boolean
			}
			const ownerId = reads.sessionWorkspaceId(sessionId)
			if (!ownerId) return json(req, res, 404, { error: 'chat not found' })
			if (body.workspaceId && body.workspaceId !== ownerId) {
				return json(req, res, 409, { error: 'chat is not in that workspace' })
			}
			const ws = reads.getWorkspace(ownerId)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })

			const before = reads.listSessions(ws.id)
			const session = before.find(s => s.id === sessionId)
			const visibleActiveSession = (): string | null => {
				const visible = reads.listSessions(ws.id)
				const activeId = reads.getWorkspace(ws.id)?.active_session_id
				return visible.some(s => s.id === activeId) ? (activeId ?? null) : (visible[0]?.id ?? null)
			}
			// Closing is a soft delete. A repeat whose first response was lost is already
			// in the requested state, so it is success rather than a stale-link error.
			if (!session) {
				return json(req, res, 200, {
					ok: true,
					alreadyClosed: true,
					activeSessionId: visibleActiveSession()
				})
			}
			if ((session.status === 'working' || session.background_tasks.length > 0) && body.closeRunning !== true) {
				return json(req, res, 409, {
					ok: false,
					agentRunning: true,
					error: 'The agent is still working in this chat. Confirm closing it anyway.'
				})
			}
			const located = locateChat(ws, sessionId)
			if ('error' in located) return json(req, res, 409, { error: located.error })
			const result = await closeChat({ workspace: ws, sessionId, tab: located.tab }, body.closeRunning === true)
			if (!result.ok) {
				// A turn can start after the status read above. The script dismisses
				// Conductor's surprise dialog instead of accepting it, and this sends the
				// caller back through the same explicit confirmation path.
				if (body.closeRunning !== true && result.error?.includes('needs confirmation')) {
					return json(req, res, 409, {
						ok: false,
						agentRunning: true,
						error: 'The agent is still working in this chat. Confirm closing it anyway.'
					})
				}
				return json(req, res, 502, result)
			}

			// Command-W is fire-and-forget. The durable receipt is the same flag all tab
			// reads filter on: this id disappearing from listSessions means Conductor set
			// sessions.is_hidden, not merely that a keystroke happened.
			let visible = true
			for (let i = 0; i < 20 && visible; i++) {
				await sleep(300)
				visible = reads.listSessions(ws.id).some(s => s.id === sessionId)
			}
			if (visible) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor took the close but the chat tab is still open. Try again, or close it on your Mac.'
				})
			}
			return json(req, res, 200, {
				ok: true,
				strategy: result.strategy,
				activeSessionId: visibleActiveSession()
			})
		}

		// POST /api/sessions/:id/attachments?workspaceId= — raw bytes from the phone.
		// Conductor derives an attachment from this on-disk layout plus the composer
		// token, so its own database stays read-only from this relay's point of view.
		const uploadTo = routeParam(routes.uploadAttachment, req.method, pathname)

		if (uploadTo) {
			const sessionId = uploadTo
			const ownerId = reads.sessionWorkspaceId(sessionId)
			const workspaceId = url.searchParams.get('workspaceId') ?? ownerId
			const ws = workspaceId ? reads.getWorkspace(workspaceId) : null
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			if (!ownerId || ownerId !== ws.id) return json(req, res, 409, { error: 'chat is not in that workspace' })
			if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
			const name = attachmentHeaderName(req)
			if (!name) return json(req, res, 400, { error: 'missing attachment name' })
			const bytes = await readAttachmentBody(req)
			if (!bytes.length) return json(req, res, 400, { error: 'empty attachment' })
			const attachment = writeAttachment(ws.worktree, name, bytes)
			return json(req, res, 200, {
				ok: true,
				attachment: {
					name: attachment.name,
					path: attachment.relPath,
					bytes: attachment.bytes,
					token: attachment.token
				}
			})
		}
		return NOT_HANDLED
	}
}
