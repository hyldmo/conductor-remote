import { chatRoute, notifyAll } from '../../notifications/notify.ts'
import { workflowBlockMessage } from '../../orchestration/workflow/blocked.ts'
import type { WorkflowBlockNotice } from '../../orchestration/workflow/types.ts'
import { scrubWorkflowSecrets, workspaceTitle } from '../../shared.ts'
import { uiTurn } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'
import type { DeliveryServices } from './delivery.ts'

export function createWorkflowNotificationServices(
	services: Pick<BaseServices, 'reads' | 'orchestration' | 'actuator' | 'workflowCompatibilityError'> &
		Pick<DeliveryServices, 'locateChat' | 'confirmDelivery' | 'CONFIRM_WINDOW_MS'>
) {
	const { reads, orchestration, actuator, workflowCompatibilityError, locateChat, confirmDelivery, CONFIRM_WINDOW_MS } =
		services
	function title(notice: WorkflowBlockNotice): string {
		const ws = notice.run.workspaceId ? reads.getWorkspace(notice.run.workspaceId) : null
		return scrubWorkflowSecrets(
			ws ? workspaceTitle(ws) : notice.run.target.kind === 'new_workspace' ? notice.run.target.repo : 'Conductor'
		).slice(0, 160)
	}
	return {
		notifyBlocked: async (notice: WorkflowBlockNotice) => {
			const { run } = notice
			await notifyAll({
				title: title(notice),
				body: workflowBlockMessage(notice, title(notice)),
				tag: `workflow-block-${run.id}-${notice.eventId}`,
				url: run.workspaceId && run.rootSessionId ? chatRoute(run.workspaceId, run.rootSessionId) : '/',
				kind: 'error',
				ts: Date.now()
			})
		},
		sendBlockedNotice: (notice: WorkflowBlockNotice) =>
			uiTurn(async () => {
				if (await workflowCompatibilityError()) return
				// Recheck under both UI locks. Recovery or a different failure may have won
				// while this background send waited behind a phone operation or its probe.
				const run = orchestration.getWorkflowRun(notice.run.id)
				const latest = orchestration
					.listWorkflowEvents(notice.run.id)
					.findLast(event => event.type === 'workflow_blocked')
				if (run?.phase !== 'blocked' || latest?.id !== notice.eventId || orchestration.getUiQuarantine().active) return
				const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
				const sessionId = run.rootSessionId
				if (!ws || !sessionId || !reads.getSession(sessionId) || reads.sessionWorkspaceId(sessionId) !== ws.id) return
				const located = locateChat(ws, sessionId)
				if ('error' in located) return
				const text = `${workflowBlockMessage(notice, workspaceTitle(ws))}\n\nFurther Baton sends are paused until this Workflow recovers.`
				const before = reads.deliveryCursor(sessionId)
				const deadline = Date.now() + 25_000
				const result = await actuator.send({ workspace: ws, sessionId, tab: located.tab }, text, {
					queue: true,
					deadline: deadline - CONFIRM_WINDOW_MS
				})
				const receipt = await confirmDelivery(sessionId, text, before, deadline)
				if (!receipt) throw new Error(result.error ?? 'Conductor did not record the Workflow block notice.')
			})
	}
}
