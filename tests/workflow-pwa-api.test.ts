import { beforeEach, describe, expect, test, vi } from 'vitest'
import { routes } from '../src/routes.ts'

Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: { hash: '', pathname: '/', search: '' }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => 'token', setItem: () => {}, removeItem: () => {} }
})

const { ApiError, client } = await import('../web/src/lib/api.ts')

const workflow = {
	id: 'workflow-1',
	phase: 'pending_root' as const,
	objectiveExcerpt: 'Build it.',
	roles: {
		planning: { model: 'Fable 5.1', agentType: 'claude' },
		exploration: { model: '5.6 Terra', agentType: 'codex' },
		implementation: { model: 'Composer 2.5', agentType: 'cursor' }
	},
	jobs: {
		exploration: { requested: 1, running: 0, returned: 0, failed: 0 },
		implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
	},
	actions: {
		canRetry: false,
		canAdopt: false,
		canReplayAmbiguous: false,
		canCancel: true,
		canComplete: false
	},
	createdAt: 1,
	updatedAt: 1
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
	fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
})

describe('PWA Workflow HTTP boundary', () => {
	test('ordinary sends carry no Workflow authorization field', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

		await client.sendPrompt('session-1', 'Ordinary prompt', 'workspace-1', undefined, 'send-1', false)

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(path).toBe(routes.sendPrompt.path('session-1'))
		expect(JSON.parse(String(init.body))).toEqual({
			text: 'Ordinary prompt',
			workspaceId: 'workspace-1',
			clientId: 'send-1',
			queue: false
		})
	})

	test('starts through the dedicated route and requires the accepted 202 receipt', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ workflow }), { status: 202, headers: { 'content-type': 'application/json' } })
		)
		const request = {
			clientId: 'start-1',
			objective: 'Build it.',
			target: { kind: 'existing_session' as const, workspaceId: 'workspace-1', sessionId: 'session-1' }
		}

		await expect(client.startWorkflow(request)).resolves.toEqual({ workflow })
		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(path).toBe(routes.workflows.path())
		expect(JSON.parse(String(init.body))).toEqual(request)

		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ workflow }), { status: 200 }))
		await expect(client.startWorkflow(request)).rejects.toBeInstanceOf(ApiError)
	})

	test('uses the dedicated idempotent recovery routes', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ workflow }), { status: 200, headers: { 'content-type': 'application/json' } })
			)
		)

		await client.retryWorkflow(workflow.id, { clientId: 'retry-1' })
		await client.adoptWorkflow(workflow.id, {
			clientId: 'adopt-1',
			actionId: 'open:explore:0',
			sessionId: 'session-2'
		})
		await client.replayWorkflow(workflow.id, {
			clientId: 'replay-1',
			actionId: 'open:explore:0',
			confirmDuplicateRisk: true
		})
		await client.completeWorkflow(workflow.id, { clientId: 'complete-1' })
		await client.cancelWorkflow(workflow.id, { clientId: 'cancel-1' })

		const calls = fetchMock.mock.calls.map(([path, init]) => ({
			path,
			method: (init as RequestInit).method,
			body: (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined
		}))
		expect(calls).toEqual([
			{
				path: routes.workflowRetry.path(workflow.id),
				method: routes.workflowRetry.method,
				body: { clientId: 'retry-1' }
			},
			{
				path: routes.workflowAdopt.path(workflow.id),
				method: routes.workflowAdopt.method,
				body: { clientId: 'adopt-1', actionId: 'open:explore:0', sessionId: 'session-2' }
			},
			{
				path: routes.workflowReplay.path(workflow.id),
				method: routes.workflowReplay.method,
				body: { clientId: 'replay-1', actionId: 'open:explore:0', confirmDuplicateRisk: true }
			},
			{
				path: routes.workflowComplete.path(workflow.id),
				method: routes.workflowComplete.method,
				body: { clientId: 'complete-1' }
			},
			{
				path: `${routes.workflow.path(workflow.id)}?clientId=cancel-1`,
				method: routes.workflow.method,
				body: undefined
			}
		])
	})

	test('confirms the global UI quarantine through an explicit phone acknowledgement', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
		)

		await expect(
			client.confirmUiStable({ clientId: 'stable-1', confirmStable: true, createdAt: 42, actionId: 'action-1' })
		).resolves.toEqual({ ok: true })

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(path).toBe(routes.confirmUiStable.path())
		expect(init.method).toBe(routes.confirmUiStable.method)
		expect(JSON.parse(String(init.body))).toEqual({
			clientId: 'stable-1',
			confirmStable: true,
			createdAt: 42,
			actionId: 'action-1'
		})
	})
})
