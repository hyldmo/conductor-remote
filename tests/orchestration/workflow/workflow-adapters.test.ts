import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorkflowServices } from '../../../src/http/services/workflow.ts'
import {
	WorkflowCompatibilityReadError,
	WorkflowRoleVerificationError
} from '../../../src/orchestration/workflow/errors.ts'
import type { WorkflowCoordinatorDeps } from '../../../src/orchestration/workflow/types.ts'

const captured = vi.hoisted(() => ({ deps: undefined as WorkflowCoordinatorDeps | undefined }))
vi.mock('../../../src/orchestration/workflow/coordinator.ts', () => ({
	WorkflowCoordinator: class {
		constructor(_db: unknown, _relay: unknown, deps: WorkflowCoordinatorDeps) {
			captured.deps = deps
		}
	}
}))

function adapters() {
	const getSession = vi.fn(() => ({ status: 'idle', background_tasks: [], agent_type: 'codex' }))
	const getMessagesForTurn = vi.fn(() => ({
		entries: [
			{ role: 'assistant', text: 'Earlier investigation.', rowid: 21 },
			{ role: 'assistant', text: 'Full final answer.\n\n## Baton\nDecision.', rowid: 22 }
		]
	}))
	const applyAgentPatch = vi.fn(async () => ({ ok: true }))
	const sessionMatchesWorkflowRole = vi.fn(() => false)
	const workflowCompatibilityError = vi.fn(
		async (): Promise<{ kind: 'unverified' | 'incompatible'; message: string } | null> => null
	)
	createWorkflowServices({
		orchestration: { writable: true },
		relayIdentity: {},
		reads: {
			getSession,
			getMessagesForTurn,
			getWorkspace: () => ({ id: 'workspace' }),
			sessionWorkspaceId: () => 'workspace'
		},
		sessionPoller: { subscribe: () => {} },
		applyAgentPatch,
		sessionMatchesWorkflowRole,
		workflowCompatibilityError,
		withWorkflowEffectGate: (_call: unknown, operation: () => Promise<unknown>) => operation(),
		batonText: (text: string) => text.slice(text.indexOf('## Baton'))
	} as unknown as Parameters<typeof createWorkflowServices>[0])
	return {
		deps: captured.deps!,
		getSession,
		getMessagesForTurn,
		applyAgentPatch,
		sessionMatchesWorkflowRole,
		workflowCompatibilityError
	}
}

beforeEach(() => {
	captured.deps = undefined
})

describe('Workflow coordinator adapters', () => {
	test('captures the complete last reply and its cursor from the dispatched child turn', async () => {
		const f = adapters()
		const input = {
			run: {},
			job: { childSessionId: 'child', taskReceipt: { kind: 'message', id: 'task', rowid: 20, turnId: 'turn' } }
		} as Parameters<typeof f.deps.readChildOutcome>[0]
		expect(await f.deps.readChildOutcome(input)).toEqual({
			kind: 'success',
			baton: '## Baton\nDecision.',
			text: 'Full final answer.\n\n## Baton\nDecision.',
			assistantRowid: 22,
			evidence: { assistantRowid: 22 }
		})
		expect(f.getMessagesForTurn).toHaveBeenCalledWith('child', 'turn', 20)
		f.getSession.mockReturnValue({ status: 'working', background_tasks: [], agent_type: 'codex' })
		expect(await f.deps.readChildOutcome(input)).toBeNull()
	})
	test('tags only a mismatch after successful apply and a present session as known state', async () => {
		const f = adapters()
		const input = { run: { workspaceId: 'workspace' }, sessionId: 'root', role: { model: '5.6 Astra' } } as Parameters<
			typeof f.deps.configureSession
		>[0]
		await expect(f.deps.configureSession(input)).rejects.toBeInstanceOf(WorkflowRoleVerificationError)
		f.applyAgentPatch.mockResolvedValue({ ok: false })
		await expect(f.deps.configureSession(input)).rejects.toMatchObject({ code: 'workflow_effect_failed' })
		f.applyAgentPatch.mockResolvedValue({ ok: true })
		f.getSession.mockReturnValue(null as unknown as ReturnType<typeof f.getSession>)
		await expect(f.deps.configureSession(input)).rejects.toMatchObject({ code: 'workflow_effect_failed' })
	})
	test('separates an unreadable process inventory from an observed incompatible relay', async () => {
		const f = adapters()
		f.workflowCompatibilityError.mockResolvedValue({ kind: 'unverified', message: 'ps timed out' })
		await expect(f.deps.assertCompatibleRelays!()).rejects.toBeInstanceOf(WorkflowCompatibilityReadError)
		f.workflowCompatibilityError.mockResolvedValue({ kind: 'incompatible', message: 'Stop incompatible PID 123' })
		await expect(f.deps.assertCompatibleRelays!()).rejects.toMatchObject({
			name: 'WorkflowCoordinatorError',
			code: 'workflow_incompatible_relay'
		})
	})
})
