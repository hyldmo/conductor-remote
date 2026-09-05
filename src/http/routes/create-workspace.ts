import { freezeAutoModelConfig } from '../../agents/auto-model/config.ts'
import type { ParkedAgentPatch } from '../../delivery/parked.ts'
import { stagedAttachments } from '../../files/staged-attachments.ts'
import { isRoute, routes } from '../../routes.ts'

import type { AutoModelConfig, CreateWorkspaceRequest } from '../../wire.ts'

import { EFFORT_LABELS } from '../../writes/agent-options.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createCreateWorkspaceRoutes(
	services: Pick<
		RelayServices,
		'readBody' | 'json' | 'STAGED_ATTACHMENTS_DIR' | 'reads' | 'createWorkspaceAndRead' | 'firstPrompts'
	> &
		Partial<Pick<RelayServices, 'autoModels' | 'autoModelConfig' | 'modelCache'>>
): RouteHandler {
	const { readBody, json, STAGED_ATTACHMENTS_DIR, reads, createWorkspaceAndRead, firstPrompts } = services
	return async (req, res, url) => {
		const { pathname } = url

		// POST /api/workspaces { repo, prompt, model?/effort?/plan?/fast?, send? }
		// — create a workspace via Conductor's deep link, then configure its first chat.
		if (isRoute(routes.createWorkspace, req.method, pathname)) {
			const body = JSON.parse((await readBody(req)) || '{}') as CreateWorkspaceRequest
			const attachmentIds = body.attachmentIds ?? []
			if (body.auto !== undefined && typeof body.auto !== 'boolean')
				return json(req, res, 400, { error: 'auto must be a boolean' })
			if (body.auto && [body.model, body.effort, body.fast, body.plan].some(value => value !== undefined))
				return json(req, res, 400, {
					error: 'Auto chooses the agent settings. Omit manual model, effort, Fast, and Plan.'
				})
			let autoConfig: AutoModelConfig | undefined
			if (body.auto) {
				if (!services.autoModels || !services.autoModelConfig || !services.modelCache)
					return json(req, res, 503, { error: 'Auto is unavailable.' })
				try {
					autoConfig = freezeAutoModelConfig(services.autoModelConfig.read(), services.modelCache.list())
				} catch (error) {
					return json(req, res, 409, { error: error instanceof Error ? error.message : 'Invalid Auto settings.' })
				}
			}
			if ('workflow' in body) return json(req, res, 400, { error: 'Workflow starts through POST /api/workflows.' })
			if (body.model !== undefined && typeof body.model !== 'string')
				return json(req, res, 400, { error: 'model must be a picker label' })
			if (body.effort !== undefined && typeof body.effort !== 'string')
				return json(req, res, 400, { error: 'effort must be a string' })
			const effort = body.effort?.trim() || undefined
			if (effort && !EFFORT_LABELS[effort])
				return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
			if (body.plan !== undefined && typeof body.plan !== 'boolean')
				return json(req, res, 400, { error: 'plan must be a boolean' })
			if (body.fast !== undefined && typeof body.fast !== 'boolean')
				return json(req, res, 400, { error: 'fast must be a boolean' })
			const requestedAgent: ParkedAgentPatch = {
				model: body.model?.trim() || undefined,
				effort,
				plan: body.plan,
				fast: body.fast
			}
			if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string'))
				return json(req, res, 400, { error: 'attachment ids must be a list of strings' })
			const attachments = stagedAttachments(STAGED_ATTACHMENTS_DIR, attachmentIds)
			if (!attachments) return json(req, res, 409, { error: 'an attached file is no longer available; add it again' })
			// The prompt is optional — a bare `path=` opens an empty workspace, like
			// Conductor's own New workspace — but *something* has to say where it goes.
			const objective = [...attachments.map(attachment => attachment.token), (body.prompt ?? '').trim()]
				.filter(Boolean)
				.join('\n')
			if (!objective && !body.repo) return json(req, res, 400, { error: 'need a repo or a prompt' })
			const prompt = objective
			const agent = requestedAgent
			const configureAgent = Object.values(agent).some(value => value !== undefined)
			// Resolve the repo to a real path: an unmatched `path` would silently land
			// the workspace in whichever repo Conductor happens to list first.
			const repo = body.repo ? reads.listRepos().find(r => r.name === body.repo) : undefined
			if (body.repo && !repo) return json(req, res, 404, { error: `unknown repo ${body.repo}` })
			if (repo && !repo.root_path) return json(req, res, 409, { error: `${repo.name} has no checkout path` })
			const { result, created } = await createWorkspaceAndRead(prompt, repo?.root_path ?? null, repo?.name, !!body.auto)
			if (!result.ok) return json(req, res, 502, result)
			if (!created) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor didn’t create a workspace — check it’s running and not showing a dialog.'
				})
			}
			// Return as soon as the row exists (~2s) — waiting for delivery would block the
			if (autoConfig && services.autoModels) {
				const sessions = reads.listSessions(created.id)
				services.autoModels.accept({
					workspaceId: created.id,
					sessionId: sessions.length === 1 ? sessions[0].id : undefined,
					text: prompt,
					repo: created.repo_name ?? body.repo ?? '',
					config: autoConfig,
					attachmentIds,
					sendImmediately: body.sendImmediately
				})
				return json(req, res, 200, {
					ok: true,
					workspaceId: created.id,
					workspace: created,
					pendingPrompt: prompt || undefined,
					sent: false
				})
			}
			// request through Conductor's whole setup, measured at 30s+ on a real repo and
			// past any budget a phone should hold a request open for. The queue delivers on
			// its own schedule and the phone watches it in /api/state; `send:true` opts API
			// callers into waiting.
			// Whatever happens, the prompt is already pre-filled in Conductor's composer.
			const settled =
				prompt || configureAgent
					? firstPrompts.enqueue(
							created.id,
							prompt,
							body.sendImmediately !== false,
							attachmentIds,
							configureAgent ? agent : undefined
						)
					: null
			const failed = settled && body.send === true ? await settled : null
			settled?.catch(() => undefined) // fire-and-forget: it reports failure, it never rejects
			return json(req, res, 200, {
				ok: true,
				workspaceId: created.id,
				workspace: reads.getWorkspace(created.id) ?? created,
				pendingPrompt: prompt || undefined,
				model: agent.model,
				sent: body.send === true && !!prompt && !failed,
				configured: body.send === true && configureAgent && !failed,
				warning:
					failed?.error &&
					`Workspace created; the initial ${configureAgent ? 'agent settings and prompt' : 'prompt'} didn’t finish (${failed.error}).`
			})
		}
		return NOT_HANDLED
	}
}
