import { hasAgentSettings, sendPromptSchema } from '../../contracts/agent-inputs.ts'
import { parseInput } from '../../contracts/validation.ts'
import { attachmentPrompt, writeAttachment } from '../../files/attachments.ts'
import {
	discardStagedAttachment,
	materializeStagedAttachments,
	stageAttachment
} from '../../files/staged-attachments.ts'
import { captureForkWorkspace, materializeForkWorkspace, releaseForkWorkspace } from '../../git/fork-workspace.ts'
import { acceptDelegation, delegationHttpStatus } from '../../orchestration/delegation/intake.ts'
import { WorkflowCoordinatorError } from '../../orchestration/workflow/errors.ts'
import type { Workspace } from '../../reads/types.ts'
import { routeParam, routes } from '../../routes.ts'
import { renderTranscript, transcriptMessage, transcriptThrough } from '../../transcript/parser.ts'
import { lockBlocked } from '../../writes/guards.ts'
import { parseJsonBody } from '../input.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createPromptsRoutes(
	services: Pick<
		RelayServices,
		| 'orchestration'
		| 'orchestrationUnavailableReason'
		| 'readBody'
		| 'json'
		| 'workflowOwningSession'
		| 'reads'
		| 'roleStore'
		| 'modelCache'
		| 'delegationStore'
		| 'delegationQueue'
		| 'workflowFrozenError'
		| 'sendBudget'
		| 'sendOnce'
		| 'firstPrompts'
		| 'actuator'
		| 'STAGED_ATTACHMENTS_DIR'
		| 'applyAgentPatch'
		| 'parkedPrompts'
		| 'PARKED_ERROR'
		| 'deliverPrompt'
		| 'createWorkspaceAndRead'
		| 'sleep'
		| 'openChat'
	>
): RouteHandler {
	const {
		orchestration,
		orchestrationUnavailableReason,
		readBody,
		json,
		workflowOwningSession,
		reads,
		roleStore,
		modelCache,
		delegationStore,
		delegationQueue,
		workflowFrozenError,
		sendBudget,
		sendOnce,
		firstPrompts,
		actuator,
		STAGED_ATTACHMENTS_DIR,
		applyAgentPatch,
		parkedPrompts,
		PARKED_ERROR,
		deliverPrompt,
		createWorkspaceAndRead,
		sleep,
		openChat
	} = services
	return async (req, res, url) => {
		const { pathname } = url

		const delegateFrom = routeParam(routes.delegateTask, req.method, pathname)

		if (delegateFrom) {
			if (!orchestration.writable) {
				throw new WorkflowCoordinatorError('workflow_incompatible_relay', orchestrationUnavailableReason(), {
					status: 409
				})
			}
			let body: unknown
			try {
				body = JSON.parse((await readBody(req)) || '{}')
			} catch {
				return json(req, res, 400, {
					ok: false,
					error: { code: 'invalid_request', message: 'delegation must be valid JSON', retryable: false }
				})
			}
			const result = acceptDelegation(delegateFrom, body, {
				ownsSession: sessionId => workflowOwningSession(sessionId) !== null,
				sessionWorkspaceId: sessionId => reads.sessionWorkspaceId(sessionId),
				getSession: sessionId => reads.getSession(sessionId),
				getWorkspace: workspaceId => reads.getWorkspace(workspaceId),
				getMessages: sessionId => reads.getMessages(sessionId).entries,
				readRoles: () => roleStore.read(),
				models: () => modelCache.list(),
				enqueue: (workspace, job) => {
					const store = delegationStore(workspace)
					if (!store) throw new Error('worktree path unresolved')
					delegationQueue.enqueue(store, job)
				}
			})
			return json(req, res, result.ok ? 202 : delegationHttpStatus(result.error), result)
		}

		// POST /api/sessions/:id/prompt { text, agent? } — ordinary staged settings
		// are applied before the prompt so the two cannot come apart.
		const promptTo = routeParam(routes.sendPrompt, req.method, pathname)

		if (promptTo) {
			const sessionId = promptTo
			const input = parseJsonBody(await readBody(req))
			if (input && typeof input === 'object' && 'workflow' in input) {
				return json(req, res, 400, { error: 'Workflow starts through POST /api/workflows.' })
			}
			const body = parseInput(sendPromptSchema, input)
			const rawText = body.text
			const requestedAgent = body.agent && hasAgentSettings(body.agent) ? body.agent : undefined
			const frozen = workflowFrozenError(sessionId)
			if (
				frozen &&
				requestedAgent &&
				(requestedAgent.model !== undefined || requestedAgent.effort !== undefined || requestedAgent.fast !== undefined)
			) {
				return json(req, res, 409, frozen)
			}
			const ws = body.workspaceId
				? reads.getWorkspace(body.workspaceId)
				: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			// One deadline for the whole request: settings eat into the send's budget
			// rather than extending it past what the phone said it would wait.
			const deadline = Date.now() + sendBudget(req)
			const queue = body.queue
			// One prompt per intent (src/delivery/sendonce.ts). Everything that can *say something
			// to Conductor* sits inside, so an answer the phone never heard is replayed
			// rather than re-performed — including the parked branches, since parking the
			// same intent twice queues the same prompt twice for the unlock.
			if (body.clientId && sendOnce.recall(body.clientId)) {
				console.info(`[relay] send to ${ws.branch ?? ws.id} already delivered for this tap — answering, not resending`)
			}
			const answer = await sendOnce.run(body.clientId, async () => {
				const text = rawText
				const agent = requestedAgent
				// A failed first-prompt entry offers the same Retry button as an ordinary
				// prompt. If staging had been the failure, put its files in place before
				// that retry reaches the attachment tokens.
				const first = firstPrompts.get(ws.id)
				if (first?.attachmentIds?.length && first.text === text) {
					if (!ws.worktree)
						return {
							status: 409,
							body: { ok: false, strategy: actuator.name, error: 'worktree path unresolved' }
						}
					try {
						materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, ws.worktree, first.attachmentIds)
					} catch (err) {
						return {
							status: 409,
							body: {
								ok: false,
								strategy: actuator.name,
								error: err instanceof Error ? err.message : 'the attached files could not be copied'
							}
						}
					}
				}
				if (agent) {
					const applied = await applyAgentPatch(ws, sessionId, agent)
					if (!applied.ok) {
						if (lockBlocked(applied.error)) {
							const queued = parkedPrompts.park(ws.id, sessionId, text, agent, queue)
							return {
								status: 202,
								body: { ok: false, parked: true, queued, strategy: actuator.name, error: PARKED_ERROR }
							}
						}
						return { status: 502, body: { ok: false, strategy: actuator.name, error: applied.error } }
					}
				}
				// Retries live inside deliverPrompt, confirmed against the transcript each time,
				// and inside the deadline this phone told us it would wait.
				const result = await deliverPrompt(ws, sessionId, text, deadline - Date.now(), queue)
				if (result.ok) {
					// Whatever a queue was still holding has now been said by hand — the first
					// prompt (including a failed entry retried from the chat), and any parked
					// copy of this exact text, which delivering again would double.
					firstPrompts.forget(ws.id)
					parkedPrompts.forgetDelivered(sessionId, text)
					return { status: 200, body: result }
				}
				if (lockBlocked(result.error)) {
					// Settings (if any) already stuck, so the entry parks without them.
					const queued = parkedPrompts.park(ws.id, sessionId, text, undefined, queue)
					return {
						status: 202,
						body: { ok: false, parked: true, queued, strategy: result.strategy, error: PARKED_ERROR }
					}
				}
				return { status: 502, body: result }
			})
			return json(req, res, answer.status, answer.body)
		}

		// POST /api/sessions/:id/split
		//      { prompt?, includeThinking?, includeTools?, throughRowid?, onlyRowid?, destination? }
		//
		// Conductor's own tab fork resumes the agent's real session. This copies the
		// conversation instead, as a Conductor attachment, which is the cut that survives
		// being read by a *different* agent: prose and reasoning, no tool churn. Its
		// destination can be another tab over the same files, or a new workspace whose
		// Git layers are restored from the source's current worktree snapshot.
		// Two reasons it exists at all. A tangent asked inside a running chat leaves three
		// conversations interleaved in one tab, which reads badly for everyone afterwards;
		// and Conductor's fork lives on a hover menu over one message, which an agent
		// cannot reach and which the relay would have to find by walking a transcript that
		// gets more expensive the longer the chat is.
		//
		// It stops before sending. The composed prompt goes out through the ordinary send
		// route so it inherits the retry loop, the transcript confirm and the parked queue.
		// For a tab, that also keeps ⌘T plus a send from becoming two UI turns inside one
		// request (28s + 55s against the MCP client's 75s); for a workspace it leaves the
		// staged context waiting for the user's first message, just as a tab fork does.
		const splitFrom = routeParam(routes.splitChat, req.method, pathname)

		if (splitFrom) {
			const sessionId = splitFrom
			const body = JSON.parse((await readBody(req)) || '{}') as {
				prompt?: string
				workspaceId?: string
				includeThinking?: boolean
				includeTools?: boolean
				throughRowid?: number
				onlyRowid?: number
				destination?: 'chat' | 'workspace'
			}
			// `active_session_id` is how every other route resolves this, and it would only
			// ever find the tab on screen. Splitting a chat you are not looking at is the
			// normal case here, so the session's own column decides.
			const workspaceId = body.workspaceId ?? reads.sessionWorkspaceId(sessionId)
			const ws = workspaceId ? reads.getWorkspace(workspaceId) : null
			if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
			if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
			const source = reads.listSessions(ws.id).find(s => s.id === sessionId)
			if (!source) return json(req, res, 404, { error: 'chat not found in that workspace' })
			const destination = body.destination ?? 'chat'
			if (destination !== 'chat' && destination !== 'workspace') {
				return json(req, res, 400, { error: 'destination must be chat or workspace' })
			}

			const format = { thinking: body.includeThinking !== false, tools: body.includeTools === true }
			const { entries } = reads.getMessages(sessionId)
			const through = body.throughRowid
			const only = body.onlyRowid
			if (through !== undefined && (!Number.isSafeInteger(through) || through < 1)) {
				return json(req, res, 400, { error: 'throughRowid must be a positive integer' })
			}
			if (only !== undefined && (!Number.isSafeInteger(only) || only < 1)) {
				return json(req, res, 400, { error: 'onlyRowid must be a positive integer' })
			}
			if (through !== undefined && only !== undefined) {
				return json(req, res, 400, { error: 'throughRowid and onlyRowid cannot be combined' })
			}
			const cut =
				only !== undefined
					? transcriptMessage(entries, only)
					: through === undefined
						? { entries, earlier: 0, later: 0 }
						: transcriptThrough(entries, through)
			if (!cut) return json(req, res, 409, { error: 'that message is not in this chat' })
			const rendered = renderTranscript(cut.entries, format)
			const elided = { ...rendered.elided, earlier: 'earlier' in cut ? cut.earlier : 0, later: cut.later }
			if (!rendered.kept) return json(req, res, 409, { error: 'that chat has nothing to copy yet' })

			// Conductor's own name for a copied transcript, so the chip reads the same as one
			// saved by hand. The header states the cut, because a transcript that silently
			// drops half a chat is worse than one that admits to it.
			const title = source.title?.trim() || 'chat'
			const carried = [`thinking ${format.thinking ? 'included' : 'omitted'}`]
			carried.push(`tool calls ${format.tools ? 'included' : 'omitted'}`)
			const stops =
				only !== undefined
					? ['The copy contains only the selected source message; all earlier and later messages are omitted.']
					: cut.later
						? [
								`The copy stops partway through: ${cut.later} later ${cut.later === 1 ? 'entry is' : 'entries are'} not in it.`
							]
						: []
			const header = [
				`# Transcript of ${title}`,
				'',
				`${[ws.repo_name, ws.branch].filter(Boolean).join(' · ')}`,
				`Copied from the Conductor chat \`${sessionId}\` by conductor-remote. ${carried.join(', ')}.`,
				...stops,
				'',
				''
			].join('\n')
			const transcript = header + rendered.text

			if (destination === 'workspace') {
				if (!(ws.repo_name && ws.repo_root)) {
					return json(req, res, 409, { error: 'the source workspace has no repository checkout to fork' })
				}

				let snapshot: Awaited<ReturnType<typeof captureForkWorkspace>>
				try {
					snapshot = await captureForkWorkspace(ws.worktree)
				} catch (err) {
					const reason = err instanceof Error ? err.message : 'Git could not capture the worktree'
					return json(req, res, 502, { error: `Could not snapshot the source workspace: ${reason}` })
				}

				let staged: ReturnType<typeof stageAttachment> | undefined
				let materialized = false
				let created: Workspace | undefined
				try {
					staged = stageAttachment(STAGED_ATTACHMENTS_DIR, `Transcript of ${title}.md`, Buffer.from(transcript))
					const creation = await createWorkspaceAndRead('', ws.repo_root, ws.repo_name)
					if (!creation.result.ok) return json(req, res, 502, creation.result)
					created = creation.created
					if (!created) {
						return json(req, res, 502, {
							error: 'Conductor didn’t create the fork workspace — check it’s running and not showing a dialog.'
						})
					}

					// The DB row can precede `.git` by a tick. Install the snapshot at the
					// first verified worktree path, before Conductor starts the new agent.
					let target = reads.getWorkspace(created.id) ?? created
					for (let attempt = 0; attempt < 20 && !target.worktree; attempt++) {
						await sleep(250)
						target = reads.getWorkspace(created.id) ?? target
					}
					if (!target.worktree) throw new Error('the new workspace worktree path never became available')
					await materializeForkWorkspace(snapshot, target.worktree)
					materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, target.worktree, [staged.stageId])
					materialized = true
					discardStagedAttachment(STAGED_ATTACHMENTS_DIR, staged.stageId)

					let destinationSession = reads.listSessions(created.id)[0]
					for (let attempt = 0; attempt < 12 && !destinationSession; attempt++) {
						await sleep(250)
						destinationSession = reads.listSessions(created.id)[0]
					}
					return json(req, res, 200, {
						ok: true,
						destination,
						sessionId: destinationSession?.id ?? null,
						workspaceId: created.id,
						text: attachmentPrompt(staged.token, body.prompt),
						attachment: {
							name: staged.name,
							path: staged.path,
							bytes: staged.bytes,
							kept: rendered.kept,
							elided
						}
					})
				} catch (err) {
					const reason = err instanceof Error ? err.message : 'the current files could not be copied'
					return json(req, res, 502, {
						error: created
							? `Workspace ${created.id} was created, but its code fork failed: ${reason}`
							: `Could not create the code fork: ${reason}`
					})
				} finally {
					if (staged && !materialized) discardStagedAttachment(STAGED_ATTACHMENTS_DIR, staged.stageId)
					await releaseForkWorkspace(snapshot).catch(err => {
						console.warn(
							`[relay] could not release fork snapshot ${snapshot.ref}: ${err instanceof Error ? err.message : err}`
						)
					})
				}
			}

			const attachment = writeAttachment(ws.worktree, `Transcript of ${title}.md`, transcript)

			const opened = await openChat(ws)
			if ('error' in opened) {
				return json(req, res, 502, {
					...opened.result,
					destination,
					attachment: { ...attachment, ...rendered, elided }
				})
			}
			// The token is what Conductor turns into the attachment chip and supplies to the
			// receiving agent. Do not repeat `attachment.relPath` in prose: that renders a
			// second link to the same transcript in the new chat.
			const text = attachmentPrompt(attachment.token, body.prompt)
			return json(req, res, 200, {
				ok: true,
				destination,
				sessionId: opened.sessionId,
				workspaceId: ws.id,
				text,
				attachment: {
					name: attachment.name,
					path: attachment.relPath,
					bytes: attachment.bytes,
					kept: rendered.kept,
					elided
				}
			})
		}

		// DELETE /api/workspaces/:id/prompt — dismiss an undelivered first prompt
		const forgetFirst = routeParam(routes.dismissFirstPrompt, req.method, pathname)

		if (forgetFirst) {
			const workspaceId = forgetFirst
			if (!firstPrompts.forget(workspaceId)) return json(req, res, 404, { error: 'no pending prompt' })
			return json(req, res, 200, { ok: true })
		}

		// DELETE /api/sessions/:id/prompt — dismiss whatever is parked for this chat
		const forgetParked = routeParam(routes.dismissParkedPrompt, req.method, pathname)

		if (forgetParked) {
			const sessionId = forgetParked
			if (!parkedPrompts.forgetSession(sessionId)) return json(req, res, 404, { error: 'no parked prompt' })
			return json(req, res, 200, { ok: true })
		}
		return NOT_HANDLED
	}
}
