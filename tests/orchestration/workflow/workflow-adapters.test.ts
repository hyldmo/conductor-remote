import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorkflowServices } from '../../../src/http/services/workflow.ts'
import {
	WorkflowCompatibilityReadError,
	WorkflowRoleVerificationError
} from '../../../src/orchestration/workflow/errors.ts'
import type { WorkflowCoordinatorDeps } from '../../../src/orchestration/workflow/types.ts'
import { attachmentTokens } from '../../../src/shared.ts'
import { chatCursor } from '../../../src/transcript/cursor.ts'

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
	const getMessages = vi.fn(() => ({
		entries: [
			{ role: 'user', text: 'Original context.', rowid: 1 },
			{ role: 'thinking', text: 'Long private reasoning.', rowid: 2 },
			{ role: 'assistant', text: 'Relevant finding.', rowid: 3 },
			{ role: 'assistant', text: 'Later unrelated turn.', rowid: 4 }
		]
	}))
	const stableWorkflowFile = vi.fn((_worktree: string, _id: string, name: string, _body: string) => ({
		name,
		relPath: `.context/attachments/ABC123/${name}`
	}))
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
			getMessages,
			getWorkspace: () => ({ id: 'workspace', worktree: '/worktree' }),
			sessionWorkspaceId: () => 'workspace'
		},
		sessionPoller: { subscribe: () => {} },
		applyAgentPatch,
		stableWorkflowFile,
		sessionMatchesWorkflowRole,
		workflowCompatibilityError,
		withWorkflowEffectGate: (_call: unknown, operation: () => Promise<unknown>) => operation(),
		batonText: (text: string) => text.slice(text.indexOf('## Baton'))
	} as unknown as Parameters<typeof createWorkflowServices>[0])
	return {
		deps: captured.deps!,
		getSession,
		getMessagesForTurn,
		getMessages,
		stableWorkflowFile,
		applyAgentPatch,
		sessionMatchesWorkflowRole,
		workflowCompatibilityError
	}
}

beforeEach(() => {
	captured.deps = undefined
})

describe('Workflow coordinator adapters', () => {
	test('offers a frozen context file without forcing an attachment read or including reasoning', async () => {
		const f = adapters()
		const input = {
			run: { id: 'run', workspaceId: 'workspace', rootSessionId: 'root' },
			job: { id: 'job', logicalKey: 'explore:0', role: 'exploration', transcriptCursor: { rowid: 3 } }
		} as Parameters<NonNullable<typeof f.deps.materializeHandoff>>[0]
		const reference = await f.deps.materializeHandoff!(input)
		expect(reference).toContain('`.context/attachments/ABC123/Workflow exploration handoff.md`')
		expect(attachmentTokens(reference ?? '')).toEqual([])
		expect(reference).toContain(
			`read_chat(${JSON.stringify({ session_id: 'root', near: chatCursor(3), before: 6, after: 0 })})`
		)
		const [worktree, id, , body] = f.stableWorkflowFile.mock.calls[0]
		expect(worktree).toBe('/worktree')
		expect(id).toBe('job:context:v2')
		expect(body).toContain('Original context.')
		expect(body).toContain('Relevant finding.')
		expect(body).not.toContain('Long private reasoning.')
		expect(body).not.toContain('Later unrelated turn.')
	})

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
