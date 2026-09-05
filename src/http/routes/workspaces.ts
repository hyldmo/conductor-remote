import { listSourceFiles, workspaceDiff, workspaceFileDiff } from '../../git/diff.ts'

import { mergePr } from '../../git/merge.ts'

import { routeParam, routes } from '../../routes.ts'
import type { ChatTab } from '../../writes/types.ts'
import {
	archiveWorkspace,
	continueWorkspace,
	setWorkspaceStatus,
	WORKSPACE_STATUS_LABELS
} from '../../writes/workspaces.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { WorkflowAttachedWorkspace } from '../services/workflow-state.ts'
import type { RelayServices } from '../services.ts'
export function createWorkspacesRoutes(
	services: Pick<
		RelayServices,
		| 'reads'
		| 'json'
		| 'delegationStore'
		| 'attachWorkflowState'
		| 'openChat'
		| 'readBody'
		| 'locateChat'
		| 'sleep'
		| 'devServers'
	>
): RouteHandler {
	const { reads, json, delegationStore, attachWorkflowState, openChat, readBody, locateChat, sleep, devServers } =
		services
	return async (req, res, url) => {
		const { pathname } = url

		// GET /api/workspaces/:id — one workspace by id, archived included. `/api/state` lists
		// only the live ones, so this is what lets the phone open a chat search found in work
		// that has been put away: the worktree is gone, the transcript is not.
		const workspaceById = routeParam(routes.workspace, req.method, pathname)

		if (workspaceById) {
			const found = reads.getAnyWorkspace(workspaceById)
			if (!found) return json(req, res, 404, { error: 'workspace not found' })
			return json(req, res, 200, { workspace: found })
		}

		// GET /api/workspaces/:id/sessions
		const listSessionsIn = routeParam(routes.sessions, req.method, pathname)

		if (listSessionsIn) {
			const ws = reads.getWorkspace(listSessionsIn)
			const store = ws ? delegationStore(ws) : null
			const roles = store?.sessionRoles()
			const enriched = ws as WorkflowAttachedWorkspace | null
			if (enriched) attachWorkflowState([enriched])
			const sessionRoles = { ...(roles?.sessions ?? {}), ...(enriched?.session_roles ?? {}) }
			return json(req, res, 200, {
				sessions: reads.listSessions(listSessionsIn),
				...(Object.keys(sessionRoles).length ? { session_roles: sessionRoles } : {})
			})
		}

		const closedSessionsIn = routeParam(routes.closedSessions, req.method, pathname)

		if (closedSessionsIn) {
			if (!reads.getAnyWorkspace(closedSessionsIn)) return json(req, res, 404, { error: 'workspace not found' })
			return json(req, res, 200, { sessions: reads.listClosedSessions(closedSessionsIn) })
		}

		// POST /api/workspaces/:id/sessions — open a new chat (Cmd+T) in the workspace
		const newChatIn = routeParam(routes.newChat, req.method, pathname)

		if (newChatIn) {
			const workspaceId = newChatIn
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const opened = await openChat(ws)
			if ('error' in opened) return json(req, res, 502, opened.result)
			return json(req, res, 200, { ok: true, sessionId: opened.sessionId })
		}

		// GET /api/workspaces/:id/diff
		const diffOf = routeParam(routes.diff, req.method, pathname)

		if (diffOf) {
			const ws = reads.getWorkspace(diffOf)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
			const diff = await workspaceDiff(ws.worktree, ws.baseBranch)
			return json(req, res, 200, diff)
		}

		// GET /api/workspaces/:id/diff/file?path=… — the complete patch for the file
		// currently on screen. The aggregate endpoint stays bounded for phone-sized
		// responses, while a late file no longer disappears behind that bound.
		const fileDiffOf = routeParam(routes.fileDiff, req.method, pathname)

		if (fileDiffOf) {
			const ws = reads.getWorkspace(fileDiffOf)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
			const file = url.searchParams.get('path')
			if (!file) return json(req, res, 400, { error: 'file path is required' })
			const diff = await workspaceFileDiff(ws.worktree, ws.baseBranch, file)
			if (!diff) return json(req, res, 404, { error: 'changed file not found' })
			return json(req, res, 200, diff)
		}

		// GET /api/workspaces/:id/files — previewable worktree files for the diff window's
		// All-files rail and for linking `tests/foo.ts` in a message only when it really exists.
		// A workspace with no worktree has no list for either caller.
		const filesOf = routeParam(routes.workspaceFiles, req.method, pathname)

		if (filesOf) {
			const ws = reads.getWorkspace(filesOf)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			if (!ws.worktree) return json(req, res, 200, { files: [], truncated: false })
			return json(req, res, 200, await listSourceFiles(ws.worktree))
		}

		// POST /api/workspaces/:id/merge — merge the workspace's open PR (mirrors Conductor's merge button)
		const mergeOf = routeParam(routes.merge, req.method, pathname)

		if (mergeOf) {
			const ws = reads.getWorkspace(mergeOf)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const result = await mergePr(ws)
			return json(req, res, result.ok ? 200 : 409, result)
		}

		// POST /api/workspaces/:id/continue { sessionId? } — press the Continue action
		// Conductor draws for a merged PR. The native handler checks out a fresh branch,
		// updates its own workspace record and stages Branch continued.md in the selected
		// chat. Only it can do all three consistently; this relay keeps its DB read-only.
		const continueOf = routeParam(routes.continueWorkspace, req.method, pathname)

		if (continueOf) {
			const workspaceId = continueOf
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) {
				const known = reads.getAnyWorkspace(workspaceId)
				if (known?.archived) {
					return json(req, res, 409, { ok: false, error: 'Archived workspaces cannot be continued.' })
				}
				return json(req, res, 404, { error: 'workspace not found' })
			}
			const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string }
			const requestedSession = body.sessionId || ws.active_session_id
			let tab: ChatTab | undefined
			if (requestedSession) {
				const located = locateChat(ws, requestedSession)
				if ('error' in located) return json(req, res, 409, { ok: false, error: located.error })
				if (body.sessionId && !located.session) {
					return json(req, res, 409, { ok: false, error: 'chat is no longer one of the workspace’s tabs' })
				}
				tab = located.tab
			}
			const previousBranch = ws.branch
			if (!previousBranch) return json(req, res, 409, { ok: false, error: 'workspace has no branch to continue' })
			const result = await continueWorkspace({ workspace: ws, sessionId: requestedSession, tab })
			if (!result.ok) return json(req, res, 502, result)

			// AXPress only proves the button accepted a click. Conductor then fetches the
			// target and changes the worktree asynchronously, so the branch column is the
			// receipt. A generous wait covers the fetch without ever writing that column.
			let continued = reads.getWorkspace(workspaceId)
			for (let i = 0; i < 60 && (!continued?.branch || continued.branch === previousBranch); i++) {
				await sleep(500)
				continued = reads.getWorkspace(workspaceId)
			}
			if (!continued?.branch || continued.branch === previousBranch) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor did not record a new branch within 30 seconds. Check it on your Mac before retrying.'
				})
			}
			return json(req, res, 200, { ok: true, previousBranch, workspace: continued })
		}

		// POST /api/workspaces/:id/status { status } — move it between the sidebar's status groups.
		// Conductor derives that status from a PR it sometimes never links (a PR merged inside its
		// poll window is invisible to it afterwards), which strands finished work in "In progress"
		// with no way to correct it from a phone. This is that way.
		const statusOf = routeParam(routes.workspaceStatus, req.method, pathname)

		if (statusOf) {
			const workspaceId = statusOf
			const body = JSON.parse((await readBody(req)) || '{}') as { status?: string }
			const status = body.status ?? ''
			if (!WORKSPACE_STATUS_LABELS[status]) {
				const allowed = Object.keys(WORKSPACE_STATUS_LABELS).join(', ')
				return json(req, res, 400, { error: `status must be one of ${allowed}` })
			}
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const result = await setWorkspaceStatus(ws, status)
			if (!result.ok) return json(req, res, 502, result)
			// The menu press lands in the DB a beat later. Confirm rather than assume —
			// and if Conductor wrote something else, say what, instead of "didn't work".
			let observed = ws.manual_status ?? ''
			for (let i = 0; i < 10 && observed !== status; i++) {
				await new Promise(r => setTimeout(r, 300))
				observed = reads.getWorkspace(workspaceId)?.manual_status ?? ''
			}
			if (observed !== status) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: observed
						? `Conductor recorded the status as “${observed}”, not “${status}”.`
						: 'Conductor didn’t record the change — it may have been asleep. Try again.'
				})
			}
			return json(req, res, 200, { ok: true, workspace: reads.getWorkspace(workspaceId) })
		}

		// POST /api/workspaces/:id/archive { stopAgents? } — put the workspace away, the way
		// Conductor's own ⌘⇧A does. The one write here that destroys something: the worktree
		// goes, and any agent still working goes with it. So the running agents are counted
		// from the DB *before* the UI is touched and refused unless the caller has said it
		// meant that — the phone's own dialog then says so in the same words Conductor's does.
		const archiveOf = routeParam(routes.archiveWorkspace, req.method, pathname)

		if (archiveOf) {
			const workspaceId = archiveOf
			const body = JSON.parse((await readBody(req)) || '{}') as { stopAgents?: boolean }
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) {
				// Already archived is the answer the caller asked for, not a 404. A phone whose
				// answer went missing retries, and `getWorkspace` only sees the live sidebar.
				const known = reads.getAnyWorkspace(workspaceId)
				if (known?.archived) return json(req, res, 200, { ok: true, alreadyArchived: true, workspace: known })
				return json(req, res, 404, { error: 'workspace not found' })
			}
			const working = reads.listSessions(ws.id).filter(s => s.status === 'working').length
			if (working > 0 && body.stopAgents !== true) {
				return json(req, res, 409, {
					ok: false,
					agentsRunning: true,
					error: `${working} agent${working === 1 ? ' is' : 's are'} still working here. Archiving stops them.`
				})
			}
			const result = await archiveWorkspace(ws, body.stopAgents === true)
			if (!result.ok) return json(req, res, 502, result)
			// `state` becoming 'archived' is the receipt, like the status change above: the
			// keystroke is fire-and-forget and Conductor writes the row a beat later.
			let archived = reads.getAnyWorkspace(workspaceId)
			for (let i = 0; i < 20 && !archived?.archived; i++) {
				await sleep(300)
				archived = reads.getAnyWorkspace(workspaceId)
			}
			if (!archived?.archived) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error:
						'Conductor took the archive but the workspace is still in the sidebar. Try again, or archive it on your Mac.'
				})
			}
			return json(req, res, 200, { ok: true, strategy: result.strategy, workspace: archived })
		}

		// Conductor's Run configs plus tailnet-only HTTPS forwards for the active
		// one's ports. Reads never touch Conductor's UI; start/stop use the same
		// Accessibility lock and target assertion as every other UI write.
		const devServerOf = routeParam(routes.devServer, req.method, pathname)

		if (devServerOf) {
			const ws = reads.getWorkspace(devServerOf)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			return json(req, res, 200, await devServers.state(ws))
		}

		const startDevServerIn = routeParam(routes.startDevServer, req.method, pathname)

		if (startDevServerIn) {
			const ws = reads.getWorkspace(startDevServerIn)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const body = JSON.parse((await readBody(req)) || '{}') as { runConfigId?: unknown }
			if (body.runConfigId !== undefined && (typeof body.runConfigId !== 'string' || !body.runConfigId.trim())) {
				return json(req, res, 400, { error: 'runConfigId must be a non-empty string' })
			}
			const result = await devServers.start(ws, body.runConfigId as string | undefined)
			return json(req, res, result.ok ? 200 : result.available ? 502 : 409, result)
		}

		const stopDevServerIn = routeParam(routes.stopDevServer, req.method, pathname)

		if (stopDevServerIn) {
			const ws = reads.getWorkspace(stopDevServerIn)
			if (!ws) return json(req, res, 404, { error: 'workspace not found' })
			const result = await devServers.stop(ws)
			return json(req, res, result.ok ? 200 : 502, result)
		}
		return NOT_HANDLED
	}
}
