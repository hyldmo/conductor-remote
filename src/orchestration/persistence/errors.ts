import { ORCHESTRATION_SCHEMA_VERSION } from './schema.ts'
import type { AcquireUiLeaseResult } from './types.ts'

export class OrchestrationError extends Error {}

export class UnsupportedOrchestrationSchemaError extends OrchestrationError {
	readonly foundVersion: number
	readonly supportedVersion = ORCHESTRATION_SCHEMA_VERSION

	constructor(foundVersion: number) {
		super(`orchestration schema ${foundVersion} is newer than supported schema ${ORCHESTRATION_SCHEMA_VERSION}`)
		this.name = 'UnsupportedOrchestrationSchemaError'
		this.foundVersion = foundVersion
	}
}

export class IdempotencyConflictError extends OrchestrationError {
	readonly operation: string
	readonly clientId: string

	constructor(operation: string, clientId: string) {
		super(`clientId ${clientId} was already used with a different ${operation} request`)
		this.name = 'IdempotencyConflictError'
		this.operation = operation
		this.clientId = clientId
	}
}

export class WorkflowTransitionError extends OrchestrationError {
	constructor(message: string) {
		super(message)
		this.name = 'WorkflowTransitionError'
	}
}

export class UiLeaseUnavailableError extends OrchestrationError {
	readonly result: Exclude<AcquireUiLeaseResult, { status: 'acquired' }>

	constructor(result: Exclude<AcquireUiLeaseResult, { status: 'acquired' }>) {
		const message =
			result.status === 'busy'
				? `Conductor's UI is busy — held by relay PID ${result.owner.pid} (${result.reason}). Try again shortly.`
				: `Conductor's UI is quarantined — ${result.quarantine.reason ?? 'confirm Conductor is stable on the phone'}.`
		super(message)
		this.name = 'UiLeaseUnavailableError'
		this.result = result
	}
}
