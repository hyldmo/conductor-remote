import { describe, expect, test } from 'vitest'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import { WorkflowCompatibilityReadError } from '../../../src/orchestration/workflow/errors.ts'
import { coordinator, databaseFile, relay, startExisting } from './fixtures.ts'

const failure = () => {
	throw new WorkflowCompatibilityReadError('Workflow could not verify the live relay processes: ps timed out')
}

describe('Workflow compatibility read budget', () => {
	test('defers a single failed process read and recovers on the next tick', async () => {
		const { db, fake, value } = coordinator()
		const { workflow } = await startExisting(value)
		let fail = true
		const retrying = new WorkflowCoordinator(db, relay, {
			...fake.deps(),
			assertCompatibleRelays: async () => {
				if (fail) failure()
			}
		})
		expect((await retrying.wake(workflow.id)).phase).toBe('pending_root')
		expect(fake.sent).toHaveLength(0)
		expect(fake.configured).toHaveLength(0)
		expect(db.getUiQuarantine().active).toBe(false)
		fail = false
		await retrying.wake(workflow.id)
		expect(fake.sent).toHaveLength(1)
		fail = true
		await retrying.wake(workflow.id)
		await retrying.wake(workflow.id)
		expect(retrying.projection(workflow.id).phase).toBe('pending_root')
		db.close()
	})
	test('persists failed ticks across process restarts and blocks on the third', async () => {
		const file = databaseFile()
		const { db, fake, value } = coordinator(file)
		const { workflow } = await startExisting(value)
		const deps = { ...fake.deps(), assertCompatibleRelays: async () => failure() }
		await new WorkflowCoordinator(db, relay, deps).wake(workflow.id)
		db.close()
		const reopened = new OrchestrationDb(file)
		const resumed = new WorkflowCoordinator(reopened, relay, deps)
		await resumed.wake(workflow.id)
		expect(resumed.projection(workflow.id).phase).toBe('pending_root')
		await resumed.wake(workflow.id)
		expect(resumed.projection(workflow.id)).toMatchObject({
			phase: 'blocked',
			actions: { canRetry: true },
			error: { code: 'workflow_incompatible_relay', message: expect.stringContaining('ps timed out') }
		})
		expect(fake.sent).toHaveLength(0)
		expect(reopened.getUiQuarantine().active).toBe(false)
		reopened.close()
	})
	test('keeps a verified incompatibility an immediate block', async () => {
		const { db, fake, value } = coordinator()
		const { workflow } = await startExisting(value)
		fake.failCompatibility = true
		await value.wake(workflow.id)
		expect(value.projection(workflow.id)).toMatchObject({
			phase: 'blocked',
			error: { message: 'An incompatible relay is live.' }
		})
		expect(fake.configured).toHaveLength(0)
		db.close()
	})
	test.each(['before dispatch', 'before the private gate'])('also defers process read failures %s', async boundary => {
		const { db, fake, value } = coordinator()
		const { workflow } = await startExisting(value)
		let calls = 0
		const failAt = boundary === 'before dispatch' ? 2 : 3
		if (boundary === 'before the private gate') fake.gatedActions.add('configure-root')
		const deps = {
			...fake.deps(),
			assertCompatibleRelays: async () => {
				if (++calls === failAt) failure()
			}
		}
		const retrying = new WorkflowCoordinator(db, relay, deps)
		await retrying.wake(workflow.id)
		expect(retrying.projection(workflow.id).phase).toBe('pending_root')
		expect(db.getWorkflowEffect(workflow.id, 'configure-root')).toMatchObject({ state: 'prepared', mayExecute: false })
		expect(db.getUiQuarantine().active).toBe(false)
		expect(fake.configured).toHaveLength(0)
		await retrying.wake(workflow.id)
		expect(fake.configured).toEqual(['root-1'])
		expect(fake.sent).toHaveLength(1)
		db.close()
	})
})
