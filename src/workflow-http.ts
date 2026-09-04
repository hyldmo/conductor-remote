import type {
	ConfirmUiStableRequest,
	StartWorkflowRequest,
	WorkflowAdoptRequest,
	WorkflowCompleteRequest,
	WorkflowDelegateRequest,
	WorkflowReplayRequest,
	WorkflowRetryRequest
} from './wire.ts'

export class WorkflowRequestError extends Error {
	readonly status: 400 | 403
	readonly code: 'invalid_request' | 'workflow_authorization_failed'

	constructor(message: string, status: 400 | 403 = 400) {
		super(message)
		this.name = 'WorkflowRequestError'
		this.status = status
		this.code = status === 403 ? 'workflow_authorization_failed' : 'invalid_request'
	}
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new WorkflowRequestError(`${name} must be an object.`)
	}
	return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const fields = new Set(allowed)
	const unknown = Object.keys(value).filter(field => !fields.has(field))
	if (unknown.length) throw new WorkflowRequestError(`${name} has unknown field ${unknown.join(', ')}.`)
}

function text(value: unknown, name: string, maximum = 256): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
		throw new WorkflowRequestError(`${name} is required.`)
	}
	return value.trim()
}

function clientId(value: unknown): string {
	return text(value, 'clientId', 256)
}

export function parseStartWorkflowRequest(raw: unknown): StartWorkflowRequest {
	const body = record(raw, 'Workflow request')
	exact(body, ['clientId', 'objective', 'target'], 'Workflow request')
	const target = record(body.target, 'target')
	const objective = text(body.objective, 'objective', 1_000_000)
	const id = clientId(body.clientId)
	if (target.kind === 'new_workspace') {
		exact(target, ['kind', 'repo', 'sendImmediately'], 'new-workspace target')
		if (typeof target.sendImmediately !== 'boolean') {
			throw new WorkflowRequestError('target.sendImmediately must be a boolean.')
		}
		return {
			clientId: id,
			objective,
			target: {
				kind: 'new_workspace',
				repo: text(target.repo, 'target.repo'),
				sendImmediately: target.sendImmediately
			}
		}
	}
	if (target.kind === 'existing_session') {
		exact(target, ['kind', 'workspaceId', 'sessionId'], 'existing-session target')
		return {
			clientId: id,
			objective,
			target: {
				kind: 'existing_session',
				workspaceId: text(target.workspaceId, 'target.workspaceId'),
				sessionId: text(target.sessionId, 'target.sessionId')
			}
		}
	}
	throw new WorkflowRequestError('target.kind must be new_workspace or existing_session.')
}

export function parseWorkflowDelegateRequest(raw: unknown, workflowId: string): WorkflowDelegateRequest {
	const body = record(raw, 'Workflow delegation')
	exact(body, ['workflow_id', 'phase_capability', 'session_id', 'role', 'prompt'], 'Workflow delegation')
	const bodyWorkflowId = text(body.workflow_id, 'workflow_id')
	if (bodyWorkflowId !== workflowId) {
		throw new WorkflowRequestError('The body workflow_id does not match the route.', 403)
	}
	if (body.role !== 'exploration' && body.role !== 'implementation') {
		throw new WorkflowRequestError('role must be exploration or implementation.')
	}
	return {
		workflow_id: bodyWorkflowId,
		phase_capability: text(body.phase_capability, 'phase_capability', 512),
		session_id: text(body.session_id, 'session_id'),
		role: body.role,
		prompt: text(body.prompt, 'prompt', 1_000_000)
	}
}

export function parseWorkflowRetryRequest(raw: unknown): WorkflowRetryRequest {
	const body = record(raw, 'Workflow retry')
	exact(body, ['clientId'], 'Workflow retry')
	return { clientId: clientId(body.clientId) }
}

export function parseWorkflowCompleteRequest(raw: unknown): WorkflowCompleteRequest {
	const body = record(raw, 'Workflow completion')
	exact(body, ['clientId'], 'Workflow completion')
	return { clientId: clientId(body.clientId) }
}

export function parseWorkflowAdoptRequest(raw: unknown): WorkflowAdoptRequest {
	const body = record(raw, 'Workflow adoption')
	exact(body, ['clientId', 'actionId', 'workspaceId', 'sessionId'], 'Workflow adoption')
	const workspaceId = body.workspaceId === undefined ? undefined : text(body.workspaceId, 'workspaceId')
	const sessionId = body.sessionId === undefined ? undefined : text(body.sessionId, 'sessionId')
	const request = {
		clientId: clientId(body.clientId),
		actionId: text(body.actionId, 'actionId')
	}
	if (workspaceId && !sessionId) return { ...request, workspaceId }
	if (sessionId && !workspaceId) return { ...request, sessionId }
	throw new WorkflowRequestError('Adoption requires exactly one workspaceId or sessionId.')
}

export function parseWorkflowReplayRequest(raw: unknown): WorkflowReplayRequest {
	const body = record(raw, 'Workflow replay')
	exact(body, ['clientId', 'actionId', 'confirmDuplicateRisk'], 'Workflow replay')
	if (body.confirmDuplicateRisk !== true) {
		throw new WorkflowRequestError('confirmDuplicateRisk must be true.')
	}
	return {
		clientId: clientId(body.clientId),
		actionId: text(body.actionId, 'actionId'),
		confirmDuplicateRisk: true
	}
}

export function parseConfirmUiStableRequest(raw: unknown): ConfirmUiStableRequest {
	const body = record(raw, 'UI stability confirmation')
	exact(body, ['clientId', 'confirmStable', 'createdAt', 'actionId', 'effectId'], 'UI stability confirmation')
	if (body.confirmStable !== true) {
		throw new WorkflowRequestError('confirmStable must be true.')
	}
	if (!Number.isSafeInteger(body.createdAt) || (body.createdAt as number) < 0) {
		throw new WorkflowRequestError('createdAt must identify the displayed UI safety hold.')
	}
	return {
		clientId: clientId(body.clientId),
		confirmStable: true,
		createdAt: body.createdAt as number,
		...(body.actionId === undefined ? {} : { actionId: text(body.actionId, 'actionId') }),
		...(body.effectId === undefined ? {} : { effectId: text(body.effectId, 'effectId') })
	}
}

export function workflowClientIsMcp(headers: Record<string, string | string[] | undefined>): boolean {
	return headers['x-relay-client'] === 'mcp'
}
