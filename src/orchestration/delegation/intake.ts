/** Ordinary-chat delegation intake. All validation precedes persistence or UI work. */
import { randomUUID } from 'node:crypto'
import { type RoleStoreRead, resolveRole } from '../../agents/roles.ts'
import { transcriptThrough } from '../../transcript/parser.ts'
import type {
	CachedModelGroup,
	DelegateTaskRequest,
	DelegateTaskResult,
	DelegationError,
	Session,
	TranscriptEntry,
	Workspace
} from '../../wire.ts'
import type { PersistedDelegation } from './types.ts'

export interface DelegationIntakeDeps {
	ownsSession: (sessionId: string) => boolean
	sessionWorkspaceId: (sessionId: string) => string | null
	getSession: (sessionId: string) => Pick<Session, 'agent_type'> | null
	getWorkspace: (workspaceId: string) => Pick<Workspace, 'id' | 'worktree'> | null
	getMessages: (sessionId: string) => TranscriptEntry[]
	readRoles: () => RoleStoreRead
	models: () => CachedModelGroup[]
	enqueue: (workspace: Pick<Workspace, 'id' | 'worktree'>, job: PersistedDelegation) => void
}

function refused(code: DelegationError['code'], message: string): DelegateTaskResult {
	return { ok: false, error: { code, message, retryable: false } }
}

export function delegationHttpStatus(error: DelegationError): number {
	if (['workspace_not_found', 'session_not_found', 'role_not_found', 'delegation_not_found'].includes(error.code)) {
		return 404
	}
	if (error.code === 'invalid_request') return 400
	if (error.code === 'state_invalid') return 500
	return 409
}

export function acceptDelegation(
	parentSessionId: string,
	raw: unknown,
	deps: DelegationIntakeDeps
): DelegateTaskResult {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return refused('invalid_request', 'delegation must be an object')
	}
	const allowed = new Set(['role', 'prompt', 'returnMode', 'throughRowid', 'includeThinking'])
	const unknown = Object.keys(raw).find(field => !allowed.has(field))
	if (unknown) return refused('invalid_request', `unknown field: ${unknown}`)
	const body = raw as DelegateTaskRequest
	const roleName = typeof body.role === 'string' ? body.role.trim() : ''
	const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(roleName) || !prompt || prompt.length > 1_000_000) {
		return refused('invalid_request', 'a valid role and focused prompt are required')
	}
	if (body.returnMode !== undefined && body.returnMode !== 'queue' && body.returnMode !== 'steer') {
		return refused('invalid_request', 'returnMode must be queue or steer')
	}
	if (body.throughRowid !== undefined && (!Number.isSafeInteger(body.throughRowid) || body.throughRowid < 1)) {
		return refused('invalid_request', 'throughRowid must be a positive integer')
	}
	if (body.includeThinking !== undefined && typeof body.includeThinking !== 'boolean') {
		return refused('invalid_request', 'includeThinking must be a boolean')
	}
	if (deps.ownsSession(parentSessionId)) {
		return refused(
			'workflow_required',
			'This chat belongs to an active Workflow. Delegate from its root with the workflow_id and current phase_capability.'
		)
	}
	const workspaceId = deps.sessionWorkspaceId(parentSessionId)
	if (!workspaceId) return refused('session_not_found', 'parent chat not found')
	const workspace = deps.getWorkspace(workspaceId)
	if (!workspace) return refused('workspace_not_found', 'workspace for parent chat not found')
	if (!workspace.worktree) return refused('worktree_unavailable', 'worktree path unresolved')
	const parent = deps.getSession(parentSessionId)
	if (!parent) return refused('session_not_found', 'parent chat not found in that workspace')
	if (!parent.agent_type) return refused('provider_unknown', 'the parent chat provider is unknown')
	const storedRoles = deps.readRoles()
	if (storedRoles.warning) return refused('state_invalid', storedRoles.warning)
	const resolved = resolveRole(storedRoles.config, roleName, deps.models())
	if (!resolved.ok) return { ok: false, error: resolved.error }
	if (resolved.role.agentType === parent.agent_type) {
		return refused('same_provider', `Role ${roleName} uses the parent's ${parent.agent_type} provider.`)
	}
	if (body.throughRowid !== undefined && !transcriptThrough(deps.getMessages(parentSessionId), body.throughRowid)) {
		return refused('invalid_request', 'throughRowid is not in the parent chat')
	}
	const now = Date.now()
	const job: PersistedDelegation = {
		version: 1,
		id: randomUUID(),
		workspaceId: workspace.id,
		parentSessionId,
		role: roleName,
		resolvedRole: resolved.role,
		prompt,
		returnMode: body.returnMode ?? 'queue',
		includeThinking: body.includeThinking ?? false,
		...(body.throughRowid === undefined ? {} : { throughRowid: body.throughRowid }),
		status: 'queued',
		attempts: 0,
		createdAt: now,
		updatedAt: now
	}
	try {
		deps.enqueue(workspace, job)
	} catch (error) {
		return refused('state_invalid', error instanceof Error ? error.message : String(error))
	}
	return { ok: true, delegationId: job.id, role: roleName, model: resolved.role.model }
}
