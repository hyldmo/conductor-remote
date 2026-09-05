import { scrubWorkflowSecrets, withoutWindowEvidence } from '../../shared.ts'
import { withUiPriority } from '../../writes/ui-lock.ts'
import type { WorkflowRunRecord } from '../persistence/db.ts'
import { errorMessage } from './helpers.ts'
import type { WorkflowBlockNotice, WorkflowContext } from './types.ts'

export function workflowBlockMessage(notice: WorkflowBlockNotice, workspace: string): string {
	return withoutWindowEvidence(
		scrubWorkflowSecrets(
			[
				`Workflow paused in ${workspace} during ${notice.run.blocked?.resumePhase.replaceAll('_', ' ')}: ${notice.action}.`,
				notice.run.blocked?.message,
				`On your phone: ${notice.recovery}.`
			]
				.filter(Boolean)
				.join('\n\n')
		)
	)
}

function blockedAction(context: WorkflowContext, run: WorkflowRunRecord): string {
	const actionId = run.blocked?.actionId ?? ''
	const kind = context.db.getWorkflowEffect(run.id, actionId)?.kind
	if (kind)
		return (
			{
				create_workspace: 'create the workspace',
				configure_root: 'apply the planning settings',
				send_root: 'send the objective to the planner',
				open_child: 'open a helper chat',
				configure_child: 'apply the helper settings',
				send_task: 'send the helper assignment',
				return_baton: 'return the helper result',
				authorize_phase: 'deliver the next phase authorization'
			}[kind] ?? 'advance the Workflow'
		)
	if (actionId.startsWith('compatibility:')) return 'check relay compatibility'
	if (actionId.startsWith('job:')) return 'read the helper result'
	if (actionId === 'bind-root') return 'identify the planning chat'
	return 'advance the Workflow'
}

/** Notifications are best effort, with a durable claim before each external send. */
export async function notifyBlockedRun(context: WorkflowContext, run: WorkflowRunRecord): Promise<void> {
	if (run.phase !== 'blocked' || !run.blocked) return
	const event = context.db.listWorkflowEvents(run.id).findLast(event => event.type === 'workflow_blocked')
	if (!event) return
	const eventId = event.id
	const notice: WorkflowBlockNotice = {
		run,
		eventId,
		action: blockedAction(context, run),
		recovery:
			run.blocked.retryClass === 'deterministic'
				? 'Retry saved action or Cancel'
				: run.blocked.retryClass === 'ambiguous'
					? 'Review risky replay or Cancel'
					: 'Cancel this run'
	}
	async function attempt(channel: 'push' | 'root', send: () => Promise<void>) {
		const eventKey = `block-${channel}:${eventId}`
		const claimed = context.db.idempotentMutation(
			'workflow_block_notice',
			`${run.id}:${eventKey}`,
			{ eventId, channel },
			() => {
				context.db.recordWorkflowObservation({
					runId: run.id,
					eventKey,
					type: 'workflow_block_notice_claimed',
					data: { channel, eventId }
				})
				return { runId: run.id }
			}
		)
		if (claimed.replayed) return
		try {
			await send()
		} catch (error) {
			context.db.recordWorkflowObservation({
				runId: run.id,
				eventKey: `${eventKey}:failed`,
				type: 'workflow_block_notice_failed',
				data: { channel, message: errorMessage(error) }
			})
			console.warn(`[workflow ${run.id}] ${channel} block notice failed: ${errorMessage(error)}`)
		}
	}
	if (context.deps.notifyBlocked) await attempt('push', () => context.deps.notifyBlocked!(notice))
	// A notice would make an unprompted root non-pristine and prevent its retry.
	const canSendRoot =
		run.rootSessionId &&
		!['creating_workspace', 'binding_root', 'pending_root'].includes(run.blocked.resumePhase) &&
		run.blocked.errorCode !== 'workflow_root_not_pristine' &&
		run.blocked.errorCode !== 'workflow_not_found'
	if (!canSendRoot || !context.deps.sendBlockedNotice) return
	await attempt('root', async () => {
		if (context.db.getUiQuarantine().active) return
		await withUiPriority('background', () => context.deps.sendBlockedNotice!(notice))
	})
}
