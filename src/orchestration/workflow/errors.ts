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
