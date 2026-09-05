import { scrubWorkflowSecrets } from '../../shared.ts'
import { chatCursor } from '../../transcript/cursor.ts'
import type { WorkflowJobRecord, WorkflowRunRecord } from '../persistence/db.ts'
import type { WorkflowChildOutcome } from './types.ts'

type Success = Extract<WorkflowChildOutcome, { kind: 'success' }>

/** Completion freezes the source. Returning a report never reads the child's later turns. */
export function workflowReportBody(run: WorkflowRunRecord, job: WorkflowJobRecord, outcome: Success): string {
	if (!job.childSessionId || outcome.text === undefined) throw new Error('Workflow report source is incomplete')
	return scrubWorkflowSecrets(
		[
			`# Workflow ${job.role} report`,
			'',
			`Workflow: ${run.id}`,
			`Workflow job: ${job.id} (${job.logicalKey}, attempt ${job.attemptCount})`,
			`Child chat: ${job.childSessionId}`,
			...(outcome.assistantRowid === undefined ? [] : [`Completion cursor: ${chatCursor(outcome.assistantRowid)}`]),
			'',
			outcome.text
		].join('\n')
	)
}

export function workflowReportReturnText(job: WorkflowJobRecord, outcome: Success, token: string): string {
	if (!job.childSessionId) throw new Error('Workflow report has no child chat')
	const read = {
		session_id: job.childSessionId,
		...(outcome.assistantRowid === undefined ? {} : { near: chatCursor(outcome.assistantRowid), before: 6, after: 0 })
	}
	return scrubWorkflowSecrets(
		[
			outcome.baton,
			`Workflow ${job.role} task ${job.logicalKey} completed.`,
			`Report: ${token}`,
			`For earlier investigation, use read_chat(${JSON.stringify(read)}).`
		].join('\n\n')
	)
}
