import type http from 'node:http'
import { materializeStagedAttachments } from '../../files/staged-attachments.ts'
import { WorkflowCoordinator } from '../../orchestration/workflow/coordinator.ts'
import {
	WorkflowCompatibilityReadError,
	WorkflowCoordinatorError,
	WorkflowRoleVerificationError
} from '../../orchestration/workflow/errors.ts'
import { WorkflowRequestError, workflowClientIsMcp } from '../../orchestration/workflow/http.ts'
import type { FrozenWorkflowRole } from '../../orchestration/workflow/prompts.ts'
import { workflowReportBody } from '../../orchestration/workflow/report.ts'
import type { DeliveryReceipt } from '../../reads/types.ts'
import { chatCursor } from '../../transcript/cursor.ts'
import { renderTranscript } from '../../transcript/parser.ts'

import { retryWontHelp, screenLocked } from '../../writes/guards.ts'
import type { BaseServices } from './base.ts'
import type { DelegationsServices } from './delegations.ts'
import type { DeliveryServices } from './delivery.ts'
import { createWorkflowNotificationServices } from './workflow-notifications.ts'
import type { WorkflowProbesServices, WorkflowSessionBaseline, WorkflowWorkspaceBaseline } from './workflow-probes.ts'

export function createWorkflowServices(
	services: Pick<
		BaseServices,
		| 'orchestration'
		| 'relayIdentity'
		| 'reads'
		| 'stagedAttachmentIdsInObjective'
		| 'STAGED_ATTACHMENTS_DIR'
		| 'createWorkspaceAndRead'
		| 'workflowCompatibilityError'
		| 'actuator'
		| 'sessionPoller'
	> &
		Pick<
			WorkflowProbesServices,
			| 'workflowRootInspection'
			| 'withWorkflowEffectGate'
			| 'sessionMatchesWorkflowRole'
			| 'workflowDeliveryCursor'
			| 'stableWorkflowAttachment'
			| 'stableWorkflowFile'
			| 'sendWorkflowPrompt'
			| 'workflowSessionId'
			| 'assertWorkflowRootStillPristine'
			| 'workspaceBaseline'
			| 'workflowWorkspaceCandidate'
			| 'sessionBaseline'
			| 'workflowSessionCandidate'
			| 'workflowEffectPrompt'
			| 'readsDeliveryCursor'
			| 'workflowEffectMarker'
		> &
		Pick<DeliveryServices, 'applyAgentPatch' | 'openChat' | 'locateChat' | 'confirmDelivery' | 'CONFIRM_WINDOW_MS'> &
		Pick<DelegationsServices, 'batonText'>
) {
	const {
		orchestration,
		relayIdentity,
		reads,
		stagedAttachmentIdsInObjective,
		STAGED_ATTACHMENTS_DIR,
		createWorkspaceAndRead,
		workflowCompatibilityError,
		actuator,
		sessionPoller,
		workflowRootInspection,
		withWorkflowEffectGate,
		sessionMatchesWorkflowRole,
		workflowDeliveryCursor,
		stableWorkflowAttachment,
		stableWorkflowFile,
		sendWorkflowPrompt,
		workflowSessionId,
		assertWorkflowRootStillPristine,
		workspaceBaseline,
		workflowWorkspaceCandidate,
		sessionBaseline,
		workflowSessionCandidate,
		workflowEffectPrompt,
		readsDeliveryCursor,
		workflowEffectMarker,
		applyAgentPatch,
		openChat,
		batonText
	} = services

	const workflowCoordinator = orchestration.writable
		? new WorkflowCoordinator(orchestration, relayIdentity, {
				...createWorkflowNotificationServices(services),
				captureWorkspaceBaseline: async repoName => {
					const repo = reads.listRepos().find(candidate => candidate.name === repoName)
					if (!repo) {
						throw new WorkflowCoordinatorError('workflow_not_found', `Unknown repo ${repoName}.`, { status: 404 })
					}
					if (!repo.root_path) {
						throw new WorkflowCoordinatorError('invalid_request', `${repo.name} has no checkout path.`)
					}
					return {
						kind: 'workspace_ids',
						repo: repo.name,
						workspaceIds: reads
							.listWorkspaces()
							.filter(workspace => workspace.repo_name === repo.name)
							.map(workspace => workspace.id)
							.sort()
					} satisfies WorkflowWorkspaceBaseline
				},
				inspectExistingRoot: async target => {
					const ws = reads.getWorkspace(target.workspaceId)
					if (!ws || reads.sessionWorkspaceId(target.sessionId) !== ws.id) return null
					const session = reads.getSession(target.sessionId)
					return session ? workflowRootInspection(ws, session) : null
				},
				bindCreatedRoot: async ({ run, workspaceId }) => {
					const ws = reads.getWorkspace(workspaceId)
					if (!ws) return null
					if (run.target.kind !== 'new_workspace') return null
					if (!run.target.sendImmediately && ws.state !== 'ready') return null
					const sessions = reads.listSessions(workspaceId)
					if (!sessions.length) return null
					const session = sessions.find(candidate => candidate.id === ws.active_session_id) ?? sessions[0]
					if (sessions.length !== 1) {
						const inspection = workflowRootInspection(ws, session)
						return { ...inspection, pristine: false, reason: 'The created workspace has more than one root candidate.' }
					}
					const stageIds = stagedAttachmentIdsInObjective(run.objective)
					if (stageIds.length) {
						if (!ws.worktree) return null
						try {
							materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, ws.worktree, stageIds)
						} catch (error) {
							const inspection = workflowRootInspection(ws, session)
							return {
								...inspection,
								pristine: false,
								reason: error instanceof Error ? error.message : 'The Workflow attachments could not be materialized.'
							}
						}
					}
					return workflowRootInspection(ws, session)
				},
				createWorkspace: call =>
					withWorkflowEffectGate(call, async () => {
						const { target } = call
						const repo = reads.listRepos().find(candidate => candidate.name === target.repo)
						if (!repo) {
							throw new WorkflowCoordinatorError('workflow_not_found', `Unknown repo ${target.repo}.`, { status: 404 })
						}
						if (!repo.root_path)
							throw new WorkflowCoordinatorError('invalid_request', `${repo.name} has no checkout path.`)
						const { result, created } = await createWorkspaceAndRead('', repo.root_path, repo.name, true)
						if (!result.ok) {
							throw new WorkflowCoordinatorError(
								'workflow_effect_failed',
								result.error ?? 'Workspace creation failed.',
								{
									retryable: !retryWontHelp(result.error)
								}
							)
						}
						if (!created) {
							throw new WorkflowCoordinatorError(
								'workflow_effect_failed',
								'Conductor accepted the workspace link but no exact workspace row appeared.',
								{ retryable: true }
							)
						}
						return { workspaceId: created.id }
					}),
				configureSession: call =>
					withWorkflowEffectGate(call, async () => {
						const { run, sessionId, role } = call
						const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
						if (!ws || reads.sessionWorkspaceId(sessionId) !== ws.id) {
							throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow chat is unavailable.', {
								status: 404
							})
						}
						const applied = await applyAgentPatch(ws, sessionId, {
							model: role.model,
							...(role.effort === undefined ? {} : { effort: role.effort }),
							...(role.fast === undefined ? {} : { fast: role.fast })
						})
						if (!applied.ok) {
							throw new WorkflowCoordinatorError(
								'workflow_effect_failed',
								applied.error ?? 'Conductor rejected the frozen role settings.'
							)
						}
						const session = reads.getSession(sessionId)
						if (!session) {
							throw new WorkflowCoordinatorError(
								'workflow_effect_failed',
								'The Workflow chat disappeared after applying its role settings.'
							)
						}
						if (!sessionMatchesWorkflowRole(session, role)) throw new WorkflowRoleVerificationError()
						return {
							sessionId,
							agentType: session.agent_type,
							model: role.model,
							effort: session.claude_effort_level,
							fast: Boolean(session.fast_mode)
						}
					}),
				openChild: async call => {
					const { run } = call
					const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
					if (!ws)
						throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow workspace is unavailable.', {
							status: 404
						})
					// A lock probe is read-only and happens before the durable dispatch boundary.
					// Otherwise a locked Mac would quarantine an effect whose child tab was never attempted.
					if ((await screenLocked()) === true) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							'The Mac is locked — unlock it and retry Workflow.'
						)
					}
					return withWorkflowEffectGate(call, async () => {
						const opened = await openChat(ws)
						if ('error' in opened) {
							throw new WorkflowCoordinatorError(
								'workflow_effect_failed',
								opened.result.error ?? 'Conductor did not open a tracked child chat.',
								{ retryable: opened.retryable !== false }
							)
						}
						return { sessionId: opened.sessionId }
					})
				},
				captureSessionBaseline: async workspaceId => {
					const ws = reads.getWorkspace(workspaceId)
					if (!ws) {
						throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow workspace is unavailable.', {
							status: 404
						})
					}
					return {
						kind: 'session_ids',
						workspaceId,
						sessionIds: reads
							.listSessions(workspaceId)
							.map(session => session.id)
							.sort()
					} satisfies WorkflowSessionBaseline
				},
				captureDeliveryCursor: async sessionId => workflowDeliveryCursor(sessionId),
				captureTranscriptCursor: async sessionId => ({ rowid: reads.getMessages(sessionId).cursor }),
				materializeHandoff: async ({ run, job }) => {
					const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
					if (!ws?.worktree || !run.rootSessionId) return undefined
					const cursor =
						job.transcriptCursor && typeof job.transcriptCursor === 'object'
							? (job.transcriptCursor as { rowid?: unknown }).rowid
							: undefined
					const entries = reads
						.getMessages(run.rootSessionId)
						.entries.filter(entry => typeof cursor !== 'number' || entry.rowid <= cursor)
					const rendered = renderTranscript(entries, { thinking: false, tools: false })
					if (!rendered.kept) return undefined
					const body = [
						`# Workflow handoff for ${job.logicalKey}`,
						'',
						`Workflow: ${run.id}`,
						`Workflow job: ${job.id}`,
						`Root chat: ${run.rootSessionId}`,
						'Reasoning and tool calls omitted. Use this history only when the focused assignment needs it.',
						'',
						rendered.text
					].join('\n')
					// A file reference avoids Conductor's mandatory attachment-read instruction.
					// Version the path so an unfinished older handoff can still resume unchanged.
					const file = stableWorkflowFile(ws.worktree, `${job.id}:context:v2`, `Workflow ${job.role} handoff.md`, body)
					const read = {
						session_id: run.rootSessionId,
						...(typeof cursor === 'number' ? { near: chatCursor(cursor), before: 6, after: 0 } : {})
					}
					return `\`${file.relPath}\`. For earlier evidence: read_chat(${JSON.stringify(read)}).`
				},
				sendPrompt: call => sendWorkflowPrompt(call, false),
				materializeReport: async ({ run, job, outcome }) => {
					const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
					if (!ws?.worktree) throw new Error('The Workflow report worktree is unavailable.')
					return stableWorkflowAttachment(
						ws.worktree,
						`${job.id}:report:${job.attemptCount}`,
						`Workflow ${job.role} report.md`,
						workflowReportBody(run, job, outcome)
					)
				},
				returnBaton: call => sendWorkflowPrompt(call, true),
				resolveDeliveryReceipt: async ({ sessionId, receipt }) => {
					const current = reads.deliveryReceiptForId(sessionId, receipt.id)
					if (current?.kind === 'message') return { status: 'delivered' as const, receipt: current }
					if (current?.kind === 'outbox') return { status: 'pending' as const }
					return { status: 'lost' as const, evidence: { receiptId: receipt.id, priorKind: receipt.kind } }
				},
				readChildOutcome: async ({ job }) => {
					if (!job.childSessionId || !job.taskReceipt || typeof job.taskReceipt !== 'object') return null
					const receipt = job.taskReceipt as Partial<DeliveryReceipt>
					if (receipt.kind !== 'message' || !Number.isSafeInteger(receipt.rowid)) return null
					const child = reads.getSession(job.childSessionId)
					if (!child) {
						return {
							kind: 'failure' as const,
							code: 'session_not_found',
							message: 'The tracked child chat disappeared.',
							retryClass: 'deterministic' as const
						}
					}
					const messages =
						typeof receipt.turnId === 'string'
							? reads.getMessagesForTurn(job.childSessionId, receipt.turnId, receipt.rowid as number)
							: reads.getMessages(job.childSessionId, receipt.rowid as number)
					const assistants = messages.entries.filter(entry => entry.role === 'assistant' && entry.text.trim())
					const last = assistants.at(-1)
					if (child.status === 'error') {
						return {
							kind: 'failure' as const,
							code: 'completion_failed',
							message: last?.text.trim() || 'The tracked child agent stopped with an error.',
							retryClass: 'deterministic' as const,
							evidence: { assistantRowid: last?.rowid }
						}
					}
					if (child.status !== 'idle' || child.background_tasks.length || !last) return null
					return {
						kind: 'success' as const,
						baton: batonText(last.text),
						text: last.text,
						assistantRowid: last.rowid,
						evidence: { assistantRowid: last.rowid }
					}
				},
				validateBeforeDispatch: async ({ run, effect }) => {
					if (effect.kind !== 'configure_root' && effect.kind !== 'send_root') return
					const sessionId = workflowSessionId(effect)
					if (!sessionId) {
						throw new WorkflowCoordinatorError(
							'workflow_root_not_pristine',
							'The Workflow root effect lost its exact session binding before dispatch.'
						)
					}
					assertWorkflowRootStillPristine(run, sessionId)
				},
				reconcileEffect: async ({ run, effect }) => {
					const sessionId = workflowSessionId(effect)
					if (effect.receipt && sessionId && typeof effect.receipt === 'object') {
						const receipt = effect.receipt as Partial<DeliveryReceipt>
						if (typeof receipt.id === 'string') {
							const current = reads.deliveryReceiptForId(sessionId, receipt.id)
							if (current) return { status: 'committed' as const, receipt: current }
							return { status: 'ambiguous' as const, evidence: { receiptId: receipt.id, state: 'missing' } }
						}
					}
					if (effect.kind === 'configure_root' || effect.kind === 'configure_child') {
						const role =
							effect.inputs && typeof effect.inputs === 'object'
								? (effect.inputs as { role?: FrozenWorkflowRole }).role
								: undefined
						const session = sessionId ? reads.getSession(sessionId) : null
						if (effect.kind === 'configure_root') {
							const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
							if (
								!ws ||
								!session ||
								run.rootSessionId !== sessionId ||
								reads.sessionWorkspaceId(session.id) !== ws.id ||
								!workflowRootInspection(ws, session).pristine
							) {
								return { status: 'pending' as const }
							}
						}
						if (role && session && sessionMatchesWorkflowRole(session, role)) {
							return { status: 'committed' as const, receipt: { sessionId, matched: true } }
						}
					}
					if (effect.kind === 'create_workspace') {
						const baseline = workspaceBaseline(effect.baseline)
						if (!baseline) return { status: 'ambiguous' as const, evidence: { baseline: 'invalid' } }
						const prior = new Set(baseline.workspaceIds)
						const candidates = reads
							.listWorkspaces()
							.filter(workspace => workspace.repo_name === baseline.repo && !prior.has(workspace.id))
							.map(workflowWorkspaceCandidate)
						return { status: 'ambiguous' as const, candidates, evidence: { candidateCount: candidates.length } }
					}
					if (effect.kind === 'open_child') {
						const baseline = sessionBaseline(effect.baseline)
						const ws = baseline ? reads.getWorkspace(baseline.workspaceId) : null
						if (!baseline || !ws) return { status: 'ambiguous' as const, evidence: { baseline: 'invalid' } }
						const prior = new Set(baseline.sessionIds)
						const candidates = reads
							.listSessions(ws.id)
							.filter(session => !prior.has(session.id) && workflowRootInspection(ws, session).pristine)
							.map(session => workflowSessionCandidate(ws, session))
						return { status: 'ambiguous' as const, candidates, evidence: { candidateCount: candidates.length } }
					}
					const prompt = workflowEffectPrompt(effect)
					const cursor = readsDeliveryCursor(effect.cursor)
					if (sessionId && cursor) {
						const marker = workflowEffectMarker(effect)
						const receipt = marker
							? reads.deliveryReceiptContainingSince(sessionId, marker, cursor)
							: prompt
								? reads.deliveryReceiptSince(sessionId, prompt, cursor)
								: null
						if (receipt) return { status: 'committed' as const, receipt }
					}
					return { status: 'pending' as const }
				},
				validateAdoption: async ({ effect, candidate }) => {
					if (candidate.kind === 'workspace' && effect.kind === 'create_workspace') {
						const baseline = workspaceBaseline(effect.baseline)
						const ws = reads.getWorkspace(candidate.id)
						if (!baseline || !ws || baseline.workspaceIds.includes(ws.id) || ws.repo_name !== baseline.repo) return null
						return { workspaceId: ws.id }
					}
					if (candidate.kind === 'session' && effect.kind === 'open_child') {
						const baseline = sessionBaseline(effect.baseline)
						const ws = baseline ? reads.getWorkspace(baseline.workspaceId) : null
						const session = reads.getSession(candidate.id)
						if (
							!baseline ||
							!ws ||
							!session ||
							baseline.sessionIds.includes(session.id) ||
							reads.sessionWorkspaceId(session.id) !== ws.id ||
							!workflowRootInspection(ws, session).pristine
						) {
							return null
						}
						return { sessionId: session.id }
					}
					return null
				},
				assertCompatibleRelays: async () => {
					const error = await workflowCompatibilityError()
					if (error) {
						if (error.kind === 'unverified') throw new WorkflowCompatibilityReadError(error.message)
						throw new WorkflowCoordinatorError('workflow_incompatible_relay', error.message, {
							status: 409,
							retryable: true
						})
					}
				},
				dispatchMode: effect =>
					actuator.name === 'sidecar' &&
					(effect.kind === 'send_root' ||
						effect.kind === 'send_task' ||
						effect.kind === 'return_baton' ||
						effect.kind === 'authorize_phase')
						? 'in_process'
						: 'gated_child'
			})
		: null

	const WORKFLOW_RECOVERY_PHONE_ONLY = 'Workflow recovery is available only from the phone UI.'

	function requirePhoneWorkflowCoordinator(req: http.IncomingMessage, forbiddenMessage: string): WorkflowCoordinator {
		if (workflowClientIsMcp(req.headers)) throw new WorkflowRequestError(forbiddenMessage, 403)
		if (!workflowCoordinator)
			throw new WorkflowCoordinatorError('workflow_incompatible_relay', 'Workflow is unavailable.')
		return workflowCoordinator
	}

	function wakeWorkflows(): void {
		if (!workflowCoordinator) return
		for (const workflowId of workflowCoordinator.runIdsNeedingWake()) {
			void workflowCoordinator.wake(workflowId).catch(error => {
				console.error(`[workflow ${workflowId}] wake failed:`, error)
			})
		}
	}

	sessionPoller.subscribe(wakeWorkflows)
	return { workflowCoordinator, requirePhoneWorkflowCoordinator, WORKFLOW_RECOVERY_PHONE_ONLY, wakeWorkflows }
}
export type WorkflowServices = ReturnType<typeof createWorkflowServices>
