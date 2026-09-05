import { isDefaultEffortLevel, readDefaultEfforts, writeDefaultEfforts } from '../../agents/conductor-settings.ts'
import { decodeRoles, roleModelIssues } from '../../agents/roles.ts'
import { attachRunActivity } from '../../dev-server/run-activity.ts'
import { attachChangeStats } from '../../git/change-stats.ts'
import { attachPrStatus } from '../../git/pr.ts'
import { updateStatus } from '../../host/autoupdate.ts'
import type { SearchWorkspace } from '../../reads/types.ts'
import { isRoute, routes } from '../../routes.ts'

import { foldHits, queryTokens, type SearchResult } from '../../search/coordinator.ts'

import { scrubWorkflowSecrets } from '../../shared.ts'

import { isToolUsageRange } from '../../usage/tool-usage.ts'

import type { DelegationError, RolesConfig } from '../../wire.ts'

import { describeActuator } from '../../writes/actuator.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createStateRoutes(
	services: Pick<
		RelayServices,
		| 'reads'
		| 'attachDelegationState'
		| 'attachWorkflowState'
		| 'wireUiQuarantine'
		| 'parkedPrompts'
		| 'firstPrompts'
		| 'json'
		| 'orchestration'
		| 'orchestrationUnavailableReason'
		| 'actuator'
		| 'search'
		| 'modelCache'
		| 'readBody'
		| 'planUsage'
		| 'toolUsage'
		| 'roleStore'
	> &
		Partial<Pick<RelayServices, 'autoModels'>>
): RouteHandler {
	const {
		reads,
		attachDelegationState,
		attachWorkflowState,
		wireUiQuarantine,
		parkedPrompts,
		firstPrompts,
		json,
		orchestration,
		orchestrationUnavailableReason,
		actuator,
		search,
		modelCache,
		readBody,
		planUsage,
		toolUsage,
		roleStore
	} = services
	return async (req, res, url) => {
		const { pathname } = url

		// GET /api/state — workspace list with active-session status
		if (isRoute(routes.state, req.method, pathname)) {
			const update = updateStatus()
			const workspaces = reads.listWorkspaces()
			attachChangeStats(workspaces) // serves the cache now; refreshes stale git stats in the background
			attachPrStatus(workspaces) // colours pr_status from cache; refreshes stale entries in the background
			attachRunActivity(workspaces) // flags a live Run wrapper from a cached ps snapshot
			attachDelegationState(workspaces)
			const workflows = attachWorkflowState(workspaces)
			const uiQuarantine = wireUiQuarantine()
			// An undelivered first prompt rides along with its workspace: the phone renders it
			// in that chat rather than tracking delivery itself (see src/delivery/firstprompt.ts).
			// Prompts parked for the lock screen ride the same way, one list per workspace,
			// each entry naming its chat (src/delivery/parked.ts).
			const parked = parkedPrompts.list()
			const auto = services.autoModels?.pending() ?? []
			for (const ws of workspaces) {
				ws.pending_prompt = firstPrompts.get(ws.id) ?? auto.find(p => p.workspaceId === ws.id && !p.sessionId)
				const mine = [...parked, ...auto.filter((p): p is typeof p & { sessionId: string } => !!p.sessionId)].filter(
					p => p.workspaceId === ws.id
				)
				if (mine.length) ws.parked_prompts = mine
			}
			return json(req, res, 200, {
				workspaces,
				workflows,
				...(uiQuarantine ? { uiQuarantine } : {}),
				...(orchestration.writable
					? {}
					: { workflowWarning: scrubWorkflowSecrets(orchestrationUnavailableReason()).slice(0, 500) }),
				actuator: await describeActuator(actuator),
				version: update.current,
				update
			})
		}

		// GET /api/search?q= — find a workspace by its name or by what was said in its chats.
		//
		// Two sources, merged. `findWorkspacesByName` matches the workspace's own identity
		// and wins ties, because someone who types a name wants that workspace and not the
		// twelve chats that mention it. The transcript index answers the harder question —
		// "which workspace did I do this in" — and is the only one that can, since the
		// words you remember are usually the agent's, not the branch's.
		//
		// Both reach archived workspaces. That is the point: 1,846 of the 1,886 here are
		// archived, so a search limited to the live sidebar would miss almost everything.
		//
		// `repo=` (repeatable) and `archived=0` scope both halves. They are resolved to
		// chat ids and pushed *into* the FTS query rather than applied to its top 300
		// chunks, or excluded work would fill every slot (src/search/coordinator.ts ▸ search).
		if (isRoute(routes.search, req.method, pathname)) {
			const q = url.searchParams.get('q') ?? ''
			const repos = [...new Set(url.searchParams.getAll('repo').filter(Boolean))]
			// Archived search predates the toggle and stays the default for cached PWAs and MCP.
			const includeArchived = url.searchParams.get('archived') !== '0'
			// 12, not 50: an OR query over common words ("add", "remove") has a long weak tail,
			// and past the first screenful nobody scrolls — they retype instead.
			const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 12) || 12))
			const index = search.status()
			const tokens = queryTokens(q)
			if (!tokens.length) return json(req, res, 200, { query: q, repos, results: [], index })

			const scoped = repos.length > 0 || !includeArchived
			const scope = scoped
				? { sessionIds: reads.searchSessionIds(repos.length ? repos : undefined, includeArchived) }
				: {}
			const hits = await search.search(q, scope)
			const targets = reads.searchTargets([...new Set(hits.map(h => h.sessionId))])
			const fromChats = foldHits<SearchWorkspace>(hits, sid => {
				const workspace = targets.get(sid)?.workspace ?? null
				return !includeArchived && workspace?.archived ? null : workspace
			})

			const remaining = new Map(fromChats.map(r => [r.workspace.id, r]))
			const merged: SearchResult<SearchWorkspace>[] = []
			for (const workspace of reads.findWorkspacesByName(
				tokens,
				limit,
				repos.length ? repos : undefined,
				includeArchived
			)) {
				const evidence = remaining.get(workspace.id)
				remaining.delete(workspace.id)
				// Keep the chat evidence when there is any: the snippet is what tells you this
				// is the right "fix-lamp-thing" out of three with similar names.
				merged.push(
					evidence
						? { ...evidence, byName: true }
						: { workspace, sessionId: null, hits: 0, score: 0, at: null, snippets: [], byName: true }
				)
			}
			merged.push(...remaining.values())

			return json(req, res, 200, {
				query: q,
				repos,
				index,
				results: merged.slice(0, limit).map(r => ({
					...r,
					sessionTitle: r.sessionId ? (targets.get(r.sessionId)?.sessionTitle ?? null) : null
				}))
			})
		}

		// GET /api/repos — repos a new workspace can be created in
		if (isRoute(routes.repos, req.method, pathname)) {
			return json(req, res, 200, { repos: reads.listRepos() })
		}

		// GET /api/models — prior live picker reads, without activating Conductor. A
		// new workspace has no chat yet, so this is its only safe source of choices.
		if (isRoute(routes.modelCatalog, req.method, pathname)) {
			return json(req, res, 200, { groups: modelCache.list(), defaultModel: modelCache.defaultModel() })
		}

		// GET/PATCH /api/models/defaults — the live user-wide effort defaults.
		// These are file-backed settings, not the stale rows conductor.db still carries.
		if (isRoute(routes.modelDefaults, req.method, pathname)) {
			return json(req, res, 200, { defaultEfforts: readDefaultEfforts() })
		}

		if (isRoute(routes.updateModelDefaults, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as { claude?: unknown; codex?: unknown }
			const patch: Parameters<typeof writeDefaultEfforts>[0] = {}
			if (body.claude !== undefined) {
				if (!isDefaultEffortLevel(body.claude)) return json(req, res, 400, { error: 'unknown Claude effort level' })
				patch.claude = body.claude
			}
			if (body.codex !== undefined) {
				if (!isDefaultEffortLevel(body.codex)) return json(req, res, 400, { error: 'unknown Codex effort level' })
				patch.codex = body.codex
			}
			if (Object.keys(patch).length === 0) return json(req, res, 400, { error: 'nothing to change' })
			return json(req, res, 200, { defaultEfforts: writeDefaultEfforts(patch) })
		}

		// GET /api/usage — structured subscription limits from the CLIs Conductor
		// itself bundles. Both reads are prompt-free and cached; `refresh=1` is the
		// explicit user action in the sheet, never a background poll.
		if (isRoute(routes.planUsage, req.method, pathname)) {
			return json(req, res, 200, await planUsage.read(url.searchParams.get('refresh') === '1'))
		}

		if (isRoute(routes.toolUsage, req.method, pathname)) {
			const range = url.searchParams.get('range') ?? '24h'
			if (!isToolUsageRange(range)) return json(req, res, 400, { error: 'Choose 24h, 7d, or 30d for tool usage.' })
			return json(req, res, 200, await toolUsage.read(range, url.searchParams.get('refresh') === '1'))
		}

		if (isRoute(routes.roles, req.method, pathname)) {
			const stored = roleStore.read()
			return json(req, res, 200, {
				...stored.config,
				issues: roleModelIssues(stored.config, modelCache.list()),
				...(stored.warning ? { warning: stored.warning } : {})
			})
		}

		if (isRoute(routes.updateRoles, req.method, pathname)) {
			let config: RolesConfig
			try {
				config = decodeRoles(JSON.parse((await readBody(req)) || '{}'))
			} catch (err) {
				const error: DelegationError = {
					code: 'invalid_request',
					message: err instanceof Error ? err.message : String(err),
					retryable: false
				}
				return json(req, res, 400, { ok: false, error })
			}
			const issues = roleModelIssues(config, modelCache.list())
			if (issues.length) return json(req, res, 409, { ok: false, error: issues[0].error, issues })
			const written = roleStore.write(config)
			if (!written.ok) {
				return json(req, res, 500, {
					ok: false,
					error: { code: 'state_invalid', message: written.error, retryable: true }
				})
			}
			return json(req, res, 200, { ok: true, config: written.config })
		}
		return NOT_HANDLED
	}
}
