import { createWorkspaceSchema, hasAgentSettings } from '../../contracts/agent-inputs.ts'
import { parseInput } from '../../contracts/validation.ts'
import { stagedAttachments } from '../../files/staged-attachments.ts'
import { isRoute, routes } from '../../routes.ts'

import { parseJsonBody } from '../input.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createCreateWorkspaceRoutes(
	services: Pick<
		RelayServices,
		'readBody' | 'json' | 'STAGED_ATTACHMENTS_DIR' | 'reads' | 'createWorkspaceAndRead' | 'firstPrompts'
	>
): RouteHandler {
	const { readBody, json, STAGED_ATTACHMENTS_DIR, reads, createWorkspaceAndRead, firstPrompts } = services
	return async (req, res, url) => {
		const { pathname } = url

		// POST /api/workspaces { repo, prompt, model?/effort?/plan?/fast?, send? }
		// — create a workspace via Conductor's deep link, then configure its first chat.
		if (isRoute(routes.createWorkspace, req.method, pathname)) {
			const input = parseJsonBody(await readBody(req))
			if (input && typeof input === 'object' && 'workflow' in input)
				return json(req, res, 400, { error: 'Workflow starts through POST /api/workflows.' })
			const body = parseInput(createWorkspaceSchema, input)
			const { attachmentIds, model, effort, plan, fast } = body
			const requestedAgent = { model, effort, plan, fast }
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
			const configureAgent = hasAgentSettings(agent)
			// Resolve the repo to a real path: an unmatched `path` would silently land
			// the workspace in whichever repo Conductor happens to list first.
			const repo = body.repo ? reads.listRepos().find(r => r.name === body.repo) : undefined
			if (body.repo && !repo) return json(req, res, 404, { error: `unknown repo ${body.repo}` })
			if (repo && !repo.root_path) return json(req, res, 409, { error: `${repo.name} has no checkout path` })
			const { result, created } = await createWorkspaceAndRead(prompt, repo?.root_path ?? null, repo?.name)
			if (!result.ok) return json(req, res, 502, result)
			if (!created) {
				return json(req, res, 502, {
					ok: false,
					strategy: result.strategy,
					error: 'Conductor didn’t create a workspace — check it’s running and not showing a dialog.'
				})
			}
			// Return as soon as the row exists (~2s) — waiting for delivery would block the
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
							body.sendImmediately,
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
