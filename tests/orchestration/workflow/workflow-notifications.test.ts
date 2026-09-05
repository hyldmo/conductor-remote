import { afterEach, describe, expect, test, vi } from 'vitest'
import { createWorkflowNotificationServices } from '../../../src/http/services/workflow-notifications.ts'
import { notifyAll } from '../../../src/notifications/notify.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import { configureSharedUiLeaseProvider } from '../../../src/writes/ui-lock.ts'
import { coordinator, relay, startExisting } from './fixtures.ts'

vi.mock('../../../src/notifications/notify.ts', async importOriginal => ({
	...(await importOriginal<typeof import('../../../src/notifications/notify.ts')>()),
	notifyAll: vi.fn(async () => 1)
}))

afterEach(() => {
	configureSharedUiLeaseProvider(null)
	vi.clearAllMocks()
})

async function blocked() {
	const f = coordinator()
	const { workflow } = await startExisting(f.value)
	await f.value.wake(workflow.id)
	f.fake.promote(f.fake.sent[0].receipt.id)
	await f.value.wake(workflow.id)
	const job = f.db.listWorkflowJobs(workflow.id)[0]
	f.fake.outcomes.set(job.childSessionId!, { kind: 'failure', code: 'completion_failed', message: 'The child failed.' })
	await f.value.wake(workflow.id)
	const send = vi.fn(async () => ({ ok: true, strategy: 'applescript' }))
	const getWorkspace = vi.fn(() => ({ id: 'workspace-1', workspace_name: 'Orchestration review' }))
	const workflowCompatibilityError = vi.fn(async (): Promise<null> => null)
	const adapters = createWorkflowNotificationServices({
		orchestration: f.db,
		reads: {
			getWorkspace,
			getSession: () => ({ id: 'root-1' }),
			sessionWorkspaceId: () => 'workspace-1',
			deliveryCursor: () => ({ rowid: 0, outboxIds: new Set() })
		},
		actuator: { send },
		workflowCompatibilityError,
		locateChat: () => ({ tab: undefined, session: undefined }),
		confirmDelivery: async () => ({ kind: 'outbox', id: 'notice' }),
		CONFIRM_WINDOW_MS: 6000
	} as unknown as Parameters<typeof createWorkflowNotificationServices>[0])
	return { ...f, workflow, send, getWorkspace, workflowCompatibilityError, adapters }
}

describe('Workflow block delivery adapters', () => {
	test('routes a push to the root and sends one queued notice at background priority', async () => {
		const f = await blocked()
		const acquire = vi.fn(async () => ({ markMayExecute() {}, release() {} }))
		configureSharedUiLeaseProvider({ acquire })
		const value = new WorkflowCoordinator(f.db, relay, { ...f.fake.deps(), ...f.adapters })
		await value.wake(f.workflow.id)
		expect(notifyAll).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Orchestration review',
				url: '/w/workspace-1?session=root-1',
				kind: 'error',
				body: expect.stringContaining('Retry saved action')
			})
		)
		expect(acquire).toHaveBeenCalledWith({ priority: 'background' })
		expect(f.send).toHaveBeenCalledTimes(1)
		expect(f.send).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'root-1' }),
			expect.stringContaining('Further Baton sends are paused'),
			expect.objectContaining({ queue: true })
		)
		await value.wake(f.workflow.id)
		expect(f.send).toHaveBeenCalledTimes(1)
		f.db.close()
	})
	test('checks the block again after an asynchronous compatibility probe', async () => {
		const f = await blocked()
		f.workflowCompatibilityError.mockImplementation(async () => {
			await f.value.retry({ clientId: 'phone-retry', workflowId: f.workflow.id })
			return null
		})
		const value = new WorkflowCoordinator(f.db, relay, { ...f.fake.deps(), ...f.adapters })
		await value.wake(f.workflow.id)
		expect(f.send).not.toHaveBeenCalled()
		f.db.close()
	})
	test('sends only a push when the destination workspace is gone', async () => {
		const f = await blocked()
		f.getWorkspace.mockReturnValue(null as unknown as ReturnType<typeof f.getWorkspace>)
		const value = new WorkflowCoordinator(f.db, relay, { ...f.fake.deps(), ...f.adapters })
		await value.wake(f.workflow.id)
		expect(notifyAll).toHaveBeenCalledTimes(1)
		expect(f.send).not.toHaveBeenCalled()
		f.db.close()
	})
})
