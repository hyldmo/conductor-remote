import { describe, expect, expectTypeOf, test } from 'vitest'
import { routes } from '../src/routes.ts'
import { responseErrorMessage } from '../src/shared.ts'
import type {
	DelegatedRole,
	DelegateTaskRequest,
	DelegateTaskResult,
	DelegationOutcome,
	DelegationReturnMode,
	DelegationStatus,
	Workspace
} from '../src/wire.ts'

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
	})

	test('has only measured completion outcomes', () => {
		expectTypeOf<DelegationOutcome['kind']>().toEqualTypeOf<'success' | 'error'>()
		expectTypeOf<DelegationReturnMode>().toEqualTypeOf<'queue' | 'steer'>()
		expectTypeOf<DelegationStatus>().toEqualTypeOf<
			'queued' | 'opening' | 'configuring' | 'sending' | 'running' | 'returning' | 'returned' | 'failed'
		>()
	})

	test('carries role input and projected workspace state end to end', () => {
		expectTypeOf<DelegateTaskRequest>().toMatchTypeOf<{
			role: string
			prompt: string
			returnMode?: 'queue' | 'steer'
		}>()
		expectTypeOf<DelegateTaskResult>().toHaveProperty('ok')
		expectTypeOf<Workspace>().toHaveProperty('delegations')
		expectTypeOf<Workspace>().toHaveProperty('session_roles')
	})

	test('declares the HTTP paths once', () => {
		expect(routes.roles).toMatchObject({ method: 'GET', pattern: '/api/roles' })
		expect(routes.updateRoles).toMatchObject({ method: 'PATCH', pattern: '/api/roles' })
		expect(routes.delegations).toMatchObject({ method: 'GET', pattern: '/api/delegations' })
		expect(routes.delegateTask.path('parent/chat')).toBe('/api/sessions/parent%2Fchat/delegate')
		expect(routes.dismissDelegation.path('job/id')).toBe('/api/delegations/job%2Fid')
	})
})
