import { describe, expect, test, vi } from 'vitest'
import { acceptDelegation, type DelegationIntakeDeps, delegationHttpStatus } from '../src/delegation-intake.ts'
import type { PersistedDelegation } from '../src/delegations.ts'
import type { RolesConfig, TranscriptEntry } from '../src/wire.ts'

const spark = 'opencode-go/muse-spark-1.3-contributor'
const request = { role: 'exploration', prompt: 'Inspect how sends are queued. Return evidence only.' }

function fixture(overrides: Partial<DelegationIntakeDeps> = {}) {
	const jobs: PersistedDelegation[] = []
	const config: RolesConfig = { version: 1, roles: { exploration: { model: spark, preamble: 'Return a Baton.' } } }
	const enqueue = vi.fn((_workspace, job: PersistedDelegation) => {
		jobs.push(job)
	})
	const deps: DelegationIntakeDeps = {
		ownsSession: () => false,
		sessionWorkspaceId: () => 'workspace-1',
		getSession: () => ({ agent_type: 'codex' }),
		getWorkspace: () => ({ id: 'workspace-1', worktree: '/local/worktree' }),
		getMessages: () => [],
		readRoles: () => ({ config }),
		models: () => [{ agentType: 'claude', models: [spark, 'Fable 5.1'], updatedAt: 1 }],
		enqueue,
		...overrides
	}
	return { deps, jobs, config, enqueue }
}

describe('ordinary-chat delegation intake', () => {
	test('accepts independent Spark children without a Workflow or planning stage and freezes their role', () => {
		const { deps, jobs, config } = fixture()
		const first = acceptDelegation('parent-1', request, deps)
		const second = acceptDelegation('parent-1', { ...request, prompt: 'Inspect the tab hierarchy.' }, deps)
		expect(first).toMatchObject({ ok: true, role: 'exploration', model: spark })
		expect(second).toMatchObject({ ok: true })
		expect(jobs).toHaveLength(2)
		expect(jobs[0].id).not.toBe(jobs[1].id)
		config.roles.exploration.model = 'Fable 5.1'
		expect(jobs[0]).toMatchObject({
			parentSessionId: 'parent-1',
			workspaceId: 'workspace-1',
			status: 'queued',
			role: 'exploration',
			resolvedRole: { model: spark, agentType: 'acp' },
			returnMode: 'queue',
			includeThinking: false,
			prompt: request.prompt
		})
		expect(jobs[0]).not.toHaveProperty('workflowId')
		expect(jobs[0].resolvedRole).not.toHaveProperty('plan')
	})

	test.each(['root-1', 'workflow-child-1'])('refuses Workflow-owned session %s before any persistence', sessionId => {
		const readRoles = vi.fn()
		const { deps, enqueue } = fixture({ ownsSession: id => id === sessionId, readRoles })
		const result = acceptDelegation(sessionId, request, deps)
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'workflow_required', message: expect.stringContaining('phase_capability') }
		})
		expect(readRoles).not.toHaveBeenCalled()
		expect(enqueue).not.toHaveBeenCalled()
		if (!result.ok) expect(delegationHttpStatus(result.error)).toBe(409)
	})

	test.each([
		null,
		[],
		'prompt',
		{},
		{ ...request, role: '../role' },
		{ ...request, prompt: ' ' },
		{ ...request, prompt: 'a'.repeat(1_000_001) },
		{ ...request, returnMode: 'surprise' },
		{ ...request, throughRowid: 0 },
		{ ...request, throughRowid: 1.5 },
		{ ...request, includeThinking: 'true' },
		{ ...request, model: spark },
		{ ...request, plan: true },
		{ ...request, workflow_id: 'run-1' },
		{ ...request, phase_capability: 'cap' }
	])('rejects malformed or override input %# before enqueue', body => {
		const { deps, enqueue } = fixture()
		const result = acceptDelegation('parent-1', body, deps)
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
		expect(enqueue).not.toHaveBeenCalled()
	})

	test.each([
		['session_not_found', { sessionWorkspaceId: () => null }],
		['workspace_not_found', { getWorkspace: () => null }],
		['worktree_unavailable', { getWorkspace: () => ({ id: 'workspace-1', worktree: null }) }],
		['session_not_found', { getSession: () => null }],
		['provider_unknown', { getSession: () => ({ agent_type: null }) }],
		['same_provider', { getSession: () => ({ agent_type: 'acp' }) }],
		['model_missing', { models: () => [] }],
		['state_invalid', { readRoles: () => ({ config: { version: 1, roles: {} }, warning: 'bad roles file' }) }]
	] satisfies Array<[string, Partial<DelegationIntakeDeps>]>)('refuses %s without enqueue', (code, overrides) => {
		const { deps, enqueue } = fixture(overrides)
		expect(acceptDelegation('parent-1', request, deps)).toMatchObject({ ok: false, error: { code } })
		expect(enqueue).not.toHaveBeenCalled()
	})

	test('accepts custom configured roles and reports missing ones', () => {
		const { deps, config } = fixture()
		expect(acceptDelegation('parent-1', { ...request, role: 'codebase' }, deps)).toMatchObject({
			ok: false,
			error: { code: 'role_not_found' }
		})
		config.roles.codebase = config.roles.exploration
		expect(acceptDelegation('parent-1', { ...request, role: 'codebase' }, deps)).toMatchObject({
			ok: true,
			role: 'codebase'
		})
	})

	test('checks an explicit handoff boundary against the parent and preserves return choices', () => {
		const entry: TranscriptEntry = {
			id: 'message-17',
			rowid: 17,
			role: 'user',
			text: 'Inspect this.',
			ts: '2026-09-05',
			queued: false
		}
		const { deps, jobs } = fixture({ getMessages: () => [entry] })
		expect(acceptDelegation('parent-1', { ...request, throughRowid: 99 }, deps)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' }
		})
		expect(jobs).toHaveLength(0)
		expect(
			acceptDelegation('parent-1', { ...request, throughRowid: 17, returnMode: 'steer', includeThinking: true }, deps)
		).toMatchObject({ ok: true })
		expect(jobs[0]).toMatchObject({ throughRowid: 17, returnMode: 'steer', includeThinking: true })
	})

	test('reports persistence failure instead of claiming a child was accepted', () => {
		const { deps } = fixture({
			enqueue: () => {
				throw new Error('disk unavailable')
			}
		})
		expect(acceptDelegation('parent-1', request, deps)).toEqual({
			ok: false,
			error: { code: 'state_invalid', message: 'disk unavailable', retryable: false }
		})
	})
})
