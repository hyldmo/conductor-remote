import { describe, expect, expectTypeOf, test } from 'vitest'
import { routes } from '../../../src/routes.ts'
import { responseErrorMessage } from '../../../src/shared.ts'
import type {
	ConfirmUiStableRequest,
	DelegatedRole,
	DelegateTaskRequest,
	DelegationOutcome,
	DelegationReturnMode,
	DelegationStatus,
	StartWorkflowRequest,
	StateResponse,
	UiQuarantineWire,
	WorkflowDelegateRequest,
	WorkflowDelegateResult,
	WorkflowIdentityWire,
	WorkflowRunWire,
	Workspace
} from '../../../src/wire.ts'

describe('delegation wire contract', () => {
	test('keeps structured HTTP errors readable to web and MCP clients', () => {
		expect(responseErrorMessage({ code: 'model_missing', message: 'Pick an exact model.' }, 'HTTP 409')).toBe(
			'Pick an exact model.'
		)
		expect(responseErrorMessage('plain failure', 'HTTP 500')).toBe('plain failure')
		expect(responseErrorMessage({}, 'HTTP 500')).toBe('HTTP 500')
	})
	test('keeps Plan mode out of delegated role configuration', () => {
		expectTypeOf<keyof DelegatedRole>().toEqualTypeOf<'model' | 'effort' | 'fast' | 'preamble'>()
		expectTypeOf<keyof DelegateTaskRequest>().toEqualTypeOf<
			'role' | 'prompt' | 'returnMode' | 'throughRowid' | 'includeThinking'
		>()
	})

	test('has only measured completion outcomes', () => {
		expectTypeOf<DelegationOutcome['kind']>().toEqualTypeOf<'success' | 'error'>()
		expectTypeOf<DelegationReturnMode>().toEqualTypeOf<'queue' | 'steer'>()
		expectTypeOf<DelegationStatus>().toEqualTypeOf<
			'queued' | 'opening' | 'configuring' | 'sending' | 'running' | 'returning' | 'returned' | 'failed'
		>()
	})

	test('carries only capability-scoped delegation input and safe projected state', () => {
		expectTypeOf<WorkflowDelegateRequest>().toEqualTypeOf<{
			workflow_id: string
			phase_capability: string
			session_id: string
			role: 'exploration' | 'implementation'
			prompt: string
		}>()
		expectTypeOf<WorkflowDelegateResult>().toHaveProperty('ok')
		expectTypeOf<StartWorkflowRequest['target']['kind']>().toEqualTypeOf<'new_workspace' | 'existing_session'>()
		expectTypeOf<keyof WorkflowRunWire>().toEqualTypeOf<
			| 'id'
			| 'workspaceId'
			| 'rootSessionId'
			| 'phase'
			| 'objectiveExcerpt'
			| 'roles'
			| 'jobs'
			| 'error'
			| 'adoption'
			| 'actions'
			| 'createdAt'
			| 'updatedAt'
		>()
		expectTypeOf<Workspace>().toHaveProperty('delegations')
		expectTypeOf<Workspace>().toHaveProperty('session_roles')
		expectTypeOf<Workspace>().toHaveProperty('workflow')
		expectTypeOf<Workspace>().toHaveProperty('workflow_identity')
		expectTypeOf<keyof WorkflowIdentityWire>().toEqualTypeOf<'id' | 'phase' | 'roles'>()
	})

	test('projects a bounded global UI quarantine and requires explicit stability confirmation', () => {
		expectTypeOf<keyof UiQuarantineWire>().toEqualTypeOf<'active' | 'reason' | 'createdAt' | 'actionId' | 'effectId'>()
		expectTypeOf<ConfirmUiStableRequest>().toEqualTypeOf<{
			clientId: string
			confirmStable: true
			createdAt: number
			actionId?: string
			effectId?: string
		}>()
		expectTypeOf<StateResponse>().toHaveProperty('uiQuarantine')
		expectTypeOf<StateResponse>().toHaveProperty('workflowWarning')
	})

	test('declares the HTTP paths once', () => {
		expect(routes.roles).toMatchObject({ method: 'GET', pattern: '/api/roles' })
		expect(routes.updateRoles).toMatchObject({ method: 'PATCH', pattern: '/api/roles' })
		expect(routes.delegations).toMatchObject({ method: 'GET', pattern: '/api/delegations' })
		expect(routes.workflows).toMatchObject({ method: 'POST', pattern: '/api/workflows' })
		expect(routes.workflowDelegation.path('run/id')).toBe('/api/workflows/run%2Fid/delegations')
		expect(routes.workflowRetry.path('run/id')).toBe('/api/workflows/run%2Fid/retry')
		expect(routes.workflowAdopt.path('run/id')).toBe('/api/workflows/run%2Fid/adopt')
		expect(routes.workflowReplay.path('run/id')).toBe('/api/workflows/run%2Fid/replay')
		expect(routes.workflowComplete.path('run/id')).toBe('/api/workflows/run%2Fid/complete')
		expect(routes.workflow.path('run/id')).toBe('/api/workflows/run%2Fid')
		expect(routes.confirmUiStable).toMatchObject({ method: 'POST', pattern: '/api/ui-quarantine/confirm' })
		// Ordinary chats use their own intake without a Workflow capability.
		expect(routes.delegateTask.path('parent/chat')).toBe('/api/sessions/parent%2Fchat/delegate')
		expect(routes.dismissDelegation.path('job/id')).toBe('/api/delegations/job%2Fid')
	})
})
