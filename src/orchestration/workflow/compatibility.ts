import { randomUUID } from 'node:crypto'
import type { WorkflowRunRecord } from '../persistence/db.ts'
import { errorMessage } from './helpers.ts'
import { blockRun } from './state.ts'
import type { WorkflowContext } from './types.ts'

const MAX_COMPATIBILITY_READ_FAILURES = 3

function failuresSinceRecovery(context: WorkflowContext, runId: string): number {
	let count = 0
	for (const event of context.db.listWorkflowEvents(runId)) {
		if (event.type === 'workflow_compatibility_read_failed') count++
		if (event.type === 'workflow_compatibility_read_recovered' || event.type === 'workflow_retry_accepted') count = 0
	}
	return count
}

/** One failed wake spends one persisted attempt. Nothing else runs on that tick. */
export function compatibilityReadFailed(context: WorkflowContext, run: WorkflowRunRecord, error: unknown): void {
	const message = errorMessage(error)
	context.db.recordWorkflowObservation({
		runId: run.id,
		eventKey: `compatibility-read:${randomUUID()}`,
		type: 'workflow_compatibility_read_failed',
		data: { message }
	})
	if (failuresSinceRecovery(context, run.id) >= MAX_COMPATIBILITY_READ_FAILURES) {
		blockRun(context, run, {
			actionId: `compatibility:${run.id}`,
			errorCode: 'workflow_incompatible_relay',
			message: `The relay process check failed ${MAX_COMPATIBILITY_READ_FAILURES} consecutive times. ${message}`,
			retryClass: 'deterministic'
		})
	}
}

/** Clear the streak only after an entire wake succeeds, including checks at the UI gate. */
export function compatibilityReadRecovered(context: WorkflowContext, runId: string): void {
	if (!failuresSinceRecovery(context, runId)) return
	context.db.recordWorkflowObservation({
		runId,
		eventKey: `compatibility-recovered:${randomUUID()}`,
		type: 'workflow_compatibility_read_recovered'
	})
}
