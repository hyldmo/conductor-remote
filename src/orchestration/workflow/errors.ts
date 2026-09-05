import { scrubWorkflowSecrets } from '../../shared.ts'
import type { WorkflowCoordinatorErrorCode } from './types.ts'

export class WorkflowCoordinatorError extends Error {
	readonly code: WorkflowCoordinatorErrorCode
	readonly status: 400 | 404 | 409 | 503
	readonly retryable: boolean

	constructor(
		code: WorkflowCoordinatorErrorCode,
		message: string,
		options: { status?: 400 | 404 | 409 | 503; retryable?: boolean } = {}
	) {
		super(scrubWorkflowSecrets(message))
		this.name = 'WorkflowCoordinatorError'
		this.code = code
		this.status = options.status ?? 409
		this.retryable = options.retryable ?? false
	}
}

/** Only raised after the role write has finished successfully and a present chat was read back. */
export class WorkflowRoleVerificationError extends WorkflowCoordinatorError {
	constructor() {
		super(
			'workflow_role_verification_failed',
			'Conductor no longer matches every frozen role setting; no fallback was selected.',
			{ retryable: true }
		)
		this.name = 'WorkflowRoleVerificationError'
	}
}

/** The process inventory could not be read. No incompatible relay was observed. */
export class WorkflowCompatibilityReadError extends WorkflowCoordinatorError {
	constructor(message: string) {
		super('workflow_incompatible_relay', message, { retryable: true })
		this.name = 'WorkflowCompatibilityReadError'
	}
}
