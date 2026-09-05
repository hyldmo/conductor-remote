import { describe, expect, test, vi } from 'vitest'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import { coordinator, databaseFile, relay, startExisting } from './fixtures.ts'

async function runningChild(file = databaseFile()) {
	const { db, fake } = coordinator(file)
	const notifyBlocked = vi.fn(async () => {})
	const sendBlockedNotice = vi.fn(async () => {})
	const deps = { ...fake.deps(), notifyBlocked, sendBlockedNotice }
	const value = new WorkflowCoordinator(db, relay, deps)
	const { workflow } = await startExisting(value)
	await value.wake(workflow.id)
	fake.promote(fake.sent[0].receipt.id)
	await value.wake(workflow.id)
	const job = db.listWorkflowJobs(workflow.id)[0]
	return { file, db, fake, value, deps, workflow, job, notifyBlocked, sendBlockedNotice }
}

describe('Workflow block notifications', () => {
	test('notifies both channels once per block across restart, and again for a new failure', async () => {
		const f = await runningChild()
		f.fake.outcomes.set(f.job.childSessionId!, {
			kind: 'failure',
			code: 'completion_failed',
			message: 'The helper failed.'
		})
		await f.value.wake(f.workflow.id)
		await f.value.wake(f.workflow.id)
		expect(f.notifyBlocked).toHaveBeenCalledTimes(1)
		expect(f.sendBlockedNotice).toHaveBeenCalledTimes(1)
		expect(f.notifyBlocked).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'read the helper result', recovery: 'Retry saved action or Cancel' })
		)
		f.db.close()
		const db = new OrchestrationDb(f.file)
		const restarted = new WorkflowCoordinator(db, relay, f.deps)
		await restarted.wake(f.workflow.id)
		expect(f.notifyBlocked).toHaveBeenCalledTimes(1)
		expect(f.sendBlockedNotice).toHaveBeenCalledTimes(1)
		await restarted.retry({ clientId: 'retry-child', workflowId: f.workflow.id })
		await restarted.wake(f.workflow.id)
		const next = db.getWorkflowJob(f.job.id)!
		f.fake.outcomes.set(next.childSessionId!, {
			kind: 'failure',
			code: 'completion_failed',
			message: 'Another failure.'
		})
		await restarted.wake(f.workflow.id)
		expect(f.notifyBlocked).toHaveBeenCalledTimes(2)
		expect(f.sendBlockedNotice).toHaveBeenCalledTimes(2)
		db.close()
	})
	test("pushes during quarantine and permanently skips that block's UI notice", async () => {
		const f = await runningChild()
		f.db.activateUiQuarantine({ actionId: 'unrelated', reason: 'Inspect the UI.' })
		f.fake.outcomes.set(f.job.childSessionId!, {
			kind: 'failure',
			code: 'completion_failed',
			message: 'The helper failed.'
		})
		await f.value.wake(f.workflow.id)
		f.db.clearUiQuarantine('test')
		await f.value.wake(f.workflow.id)
		expect(f.notifyBlocked).toHaveBeenCalledTimes(1)
		expect(f.sendBlockedNotice).not.toHaveBeenCalled()
		f.db.close()
	})
	test('a failed push or root notice cannot change or recursively block the run', async () => {
		const f = await runningChild()
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
		f.notifyBlocked.mockRejectedValue(new Error('Push unavailable'))
		f.sendBlockedNotice.mockRejectedValue(new Error('Mac locked'))
		f.fake.outcomes.set(f.job.childSessionId!, {
			kind: 'failure',
			code: 'completion_failed',
			message: 'Original failure.'
		})
		await f.value.wake(f.workflow.id)
		await f.value.wake(f.workflow.id)
		expect(f.value.projection(f.workflow.id).error?.message).toBe('Original failure.')
		expect(f.db.listWorkflowEvents(f.workflow.id).filter(event => event.type === 'workflow_blocked')).toHaveLength(1)
		expect(f.db.getUiQuarantine().active).toBe(false)
		expect(f.notifyBlocked).toHaveBeenCalledTimes(1)
		expect(f.sendBlockedNotice).toHaveBeenCalledTimes(1)
		warning.mockRestore()
		f.db.close()
	})
	test('leaves an unprompted root pristine while still sending the push', async () => {
		const { db, fake } = coordinator()
		const notifyBlocked = vi.fn(async () => {})
		const sendBlockedNotice = vi.fn(async () => {})
		const value = new WorkflowCoordinator(db, relay, { ...fake.deps(), notifyBlocked, sendBlockedNotice })
		const { workflow } = await startExisting(value)
		fake.failConfigureBeforeDispatch = true
		await value.wake(workflow.id)
		expect(notifyBlocked).toHaveBeenCalledTimes(1)
		expect(sendBlockedNotice).not.toHaveBeenCalled()
		expect(fake.sent).toHaveLength(0)
		db.close()
	})
})
