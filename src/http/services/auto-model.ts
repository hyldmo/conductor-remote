import path from 'node:path'
import { AutoModelConfigStore } from '../../agents/auto-model/config.ts'
import { chooseAutoModel, routingInput } from '../../agents/auto-model/decision.ts'
import { runRouter } from '../../agents/auto-model/provider.ts'
import { AutoModelQueue, type AutoTarget } from '../../agents/auto-model/queue.ts'
import type { AutoModelJob } from '../../agents/auto-model/types.ts'
import { roleModelIssues } from '../../agents/roles.ts'
import { stateDir } from '../../config.ts'
import { materializeStagedAttachments } from '../../files/staged-attachments.ts'
import { modelAgentType } from '../../shared.ts'
import { lockBlocked, screenLocked } from '../../writes/guards.ts'
import { uiTurn, withUiPriority } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'
import type { DeliveryServices } from './delivery.ts'
import type { WorkflowStateServices } from './workflow-state.ts'

export function createAutoModelServices(services: BaseServices & DeliveryServices & WorkflowStateServices) {
	const {
		reads,
		modelCache,
		delegationStore,
		workflowOwningSession,
		firstPrompts,
		parkedPrompts,
		applyAgentPatch,
		deliverPrompt,
		STAGED_ATTACHMENTS_DIR
	} = services
	const autoModelConfig = new AutoModelConfigStore(path.join(stateDir(), 'auto-model.json'))
	const received = (job: AutoModelJob) =>
		!!(
			job.sessionId &&
			job.cursor &&
			reads.deliveryReceiptSince(job.sessionId, job.text, {
				rowid: job.cursor.rowid,
				outboxIds: new Set(job.cursor.outboxIds)
			})
		)
	function inspect(job: Pick<AutoModelJob, 'workspaceId' | 'sessionId'>): AutoTarget {
		const ws = reads.getWorkspace(job.workspaceId)
		if (!ws) return { ready: false, error: 'The Auto workspace is no longer available.' }
		const sessions = reads.listSessions(ws.id)
		const session = job.sessionId
			? sessions.find(s => s.id === job.sessionId)
			: sessions.length === 1
				? sessions[0]
				: undefined
		const target = { ready: ws.state === 'ready', worktree: ws.worktree, sessionId: session?.id }
		if (!session)
			return {
				...target,
				error: sessions.length > 1 || job.sessionId ? 'The Auto chat is missing or ambiguous.' : undefined
			}
		const roles = delegationStore(ws)?.sessionRoles()
		if (workflowOwningSession(session.id) || roles?.sessions[session.id] || roles?.warning) {
			return { ...target, error: 'Auto is unavailable in a chat owned by a Workflow or delegation.' }
		}
		if (firstPrompts.get(ws.id) || parkedPrompts.list().some(p => p.sessionId === session.id)) {
			return { ...target, error: 'Resolve this chat’s pending prompt before using Auto.' }
		}
		if (
			session.last_user_message_at ||
			(session.status && session.status !== 'idle') ||
			session.background_tasks.length ||
			reads.deliveryCursor(session.id).outboxIds.size ||
			reads.getMessages(session.id).entries.some(entry => entry.role === 'user')
		) {
			return { ...target, obsolete: true, error: 'Auto is available only before the first message in an idle chat.' }
		}
		return target
	}
	const autoModels = new AutoModelQueue(path.join(stateDir(), 'auto-model-prompts'), {
		inspect,
		received,
		locked: async () => (await screenLocked()) === true,
		cursor: sessionId => {
			const cursor = reads.deliveryCursor(sessionId)
			return { rowid: cursor.rowid, outboxIds: [...cursor.outboxIds] }
		},
		materialize: (job, worktree) => materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, worktree, job.attachmentIds),
		choose: (job, worktree) =>
			chooseAutoModel(job.config, routingInput(job.text, job.repo, worktree), (prompt, images, signal) =>
				runRouter(job.config.router, prompt, images, signal)
			),
		deliver: (job, current, dispatch) =>
			withUiPriority('background', () =>
				uiTurn(async () => {
					if (!current()) return { ok: false, error: 'Auto cancelled.' }
					if (received(job)) return { ok: true }
					const target = inspect(job)
					if (target.error) return { ok: false, error: target.error, cancelled: target.obsolete }
					const ws = reads.getWorkspace(job.workspaceId)
					if (!ws || !job.sessionId || !job.decision || !job.cursor)
						return { ok: false, error: 'Auto’s saved target is incomplete.' }
					const { model, effort, fast } = job.decision
					// A vanished selected profile must remain a visible failure, never a silent reroute.
					const issues = roleModelIssues(
						{ version: 1, roles: { selected: { model, effort, fast } } },
						modelCache.list()
					)
					if (issues.length)
						return {
							ok: false,
							error: 'The saved Auto model is no longer available. Dismiss this submission and choose another model.'
						}
					dispatch()
					const applied = await applyAgentPatch(ws, job.sessionId, {
						model,
						effort,
						fast,
						...(modelAgentType(model) === 'claude' ? { plan: false } : {})
					})
					if (!applied.ok) return { ok: false, error: applied.error, blocked: lockBlocked(applied.error) }
					if (received(job)) return { ok: true }
					const fresh = inspect(job)
					if (fresh.error || !current())
						return { ok: false, error: fresh.error ?? 'Auto cancelled.', cancelled: fresh.obsolete }
					const result = await deliverPrompt(ws, job.sessionId, job.text, undefined, false, {
						rowid: job.cursor.rowid,
						outboxIds: new Set(job.cursor.outboxIds)
					})
					return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
				})
			)
	})
	services.setAdditionalStagedReferences(() =>
		autoModels
			.list()
			.filter(job => !['delivered', 'cancelled'].includes(job.status))
			.flatMap(job => job.attachmentIds)
	)
	return { autoModels, autoModelConfig, inspectAutoTarget: inspect }
}
