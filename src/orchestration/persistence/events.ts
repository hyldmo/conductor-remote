import { and, asc, eq } from 'drizzle-orm'
import { decodeEvent } from './codecs.ts'
import type { PersistenceConnection } from './connection.ts'
import { idempotentMutation } from './idempotency.ts'
import { requireRun } from './records.ts'
import { workflowEvents } from './schema.ts'
import type { WorkflowEventRecord } from './types.ts'
import { nonEmpty, optionalJson } from './values.ts'

export function listWorkflowEvents(context: PersistenceConnection, runId: string): WorkflowEventRecord[] {
	return context.orm
		.select()
		.from(workflowEvents)
		.where(eq(workflowEvents.runId, runId))
		.orderBy(asc(workflowEvents.id))
		.all()
		.map(row => decodeEvent(row))
}

export function findEvent(
	context: PersistenceConnection,
	runId: string,
	eventKey: string
): WorkflowEventRecord | undefined {
	const row = context.orm
		.select()
		.from(workflowEvents)
		.where(and(eq(workflowEvents.runId, runId), eq(workflowEvents.eventKey, eventKey)))
		.get()
	return row ? decodeEvent(row) : undefined
}

export function appendEvent(
	context: PersistenceConnection,
	runId: string,
	eventKey: string,
	type: string,
	data?: unknown
): void {
	context.db
		.prepare('INSERT INTO workflow_events(run_id, event_key, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)')
		.run(runId, nonEmpty(eventKey, 'event key'), nonEmpty(type, 'event type'), optionalJson(data), context.now())
}

export function touchRun(context: PersistenceConnection, runId: string, at: number): void {
	context.db.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(at, runId)
}

/** Audit read-only probes and notification attempts without changing run/phase state. */
export function recordWorkflowObservation(
	context: PersistenceConnection,
	input: { runId: string; eventKey: string; type: string; data?: unknown }
): void {
	idempotentMutation(context, 'workflow_observation', `${input.runId}:${input.eventKey}`, input, () => {
		requireRun(context, input.runId)
		appendEvent(context, input.runId, input.eventKey, input.type, input.data)
		return { runId: input.runId }
	})
}
