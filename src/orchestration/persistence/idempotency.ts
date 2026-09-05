import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { PersistenceConnection } from './connection.ts'
import { IdempotencyConflictError, OrchestrationError } from './errors.ts'
import { workflowIdempotency } from './schema.ts'
import { asObject, isPromiseLike, json, nonEmpty } from './values.ts'

const canonicalize = (value: unknown, inArray = false): unknown => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new OrchestrationError('canonical request contains a non-finite number')
		return Object.is(value, -0) ? 0 : value
	}
	if (typeof value === 'undefined') return inArray ? null : undefined
	if (Array.isArray(value)) return value.map(entry => canonicalize(entry, true))
	if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new OrchestrationError('canonical requests must contain only JSON objects and values')
	}
	const result: Record<string, unknown> = {}
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const normalized = canonicalize((value as Record<string, unknown>)[key])
		if (normalized !== undefined) result[key] = normalized
	}
	return result
}

export const canonicalRequestJson = (request: unknown): string => json(canonicalize(request))

export const canonicalOptional = (value: unknown): string =>
	value === undefined ? '__orchestration_undefined__' : canonicalRequestJson(value)

export const canonicalRequestHash = (request: unknown): string =>
	createHash('sha256').update(canonicalRequestJson(request)).digest('hex')

export const hashCapabilityToken = (token: string): string =>
	createHash('sha256').update(nonEmpty(token, 'capability token')).digest('hex')

export function idempotentMutation<T>(
	context: PersistenceConnection,
	operation: string,
	clientId: string,
	request: unknown,
	mutate: () => T,
	link: { runId?: string; actionId?: string } = {}
): { replayed: boolean; result: T } {
	nonEmpty(operation, 'operation')
	nonEmpty(clientId, 'clientId')
	const requestHash = canonicalRequestHash(request)
	return context.immediate(() => {
		const existing = context.orm
			.select({ requestHash: workflowIdempotency.requestHash, result: workflowIdempotency.result })
			.from(workflowIdempotency)
			.where(and(eq(workflowIdempotency.operation, operation), eq(workflowIdempotency.clientId, clientId)))
			.get()
		if (existing) {
			if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(operation, clientId)
			return { replayed: true, result: existing.result as T }
		}

		const result = mutate()
		if (isPromiseLike(result)) throw new OrchestrationError('idempotent mutations must be synchronous')
		const resultRecord = asObject(result)
		const resultRunId = typeof resultRecord.runId === 'string' ? resultRecord.runId : undefined
		const resultActionId = typeof resultRecord.actionId === 'string' ? resultRecord.actionId : undefined
		context.db
			.prepare(
				`INSERT INTO workflow_idempotency
					(operation, client_id, request_hash, result_json, run_id, action_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				operation,
				clientId,
				requestHash,
				json(result),
				link.runId ?? resultRunId ?? null,
				link.actionId ?? resultActionId ?? null,
				context.now()
			)
		return { replayed: false, result }
	})
}

/**
 * Read the stable result before re-running live preconditions. This matters for
 * Workflow Start: after the first accepted request, its root is intentionally no
 * longer pristine and roles.json may have changed, but an identical client retry
 * must still receive the original accepted run.
 */
export function getIdempotentMutation<T>(
	context: PersistenceConnection,
	operation: string,
	clientId: string,
	request: unknown
): { result: T } | undefined {
	nonEmpty(operation, 'operation')
	nonEmpty(clientId, 'clientId')
	const existing = context.orm
		.select({ requestHash: workflowIdempotency.requestHash, result: workflowIdempotency.result })
		.from(workflowIdempotency)
		.where(and(eq(workflowIdempotency.operation, operation), eq(workflowIdempotency.clientId, clientId)))
		.get()
	if (!existing) return undefined
	if (existing.requestHash !== canonicalRequestHash(request)) {
		throw new IdempotencyConflictError(operation, clientId)
	}
	return { result: existing.result as T }
}
