import { describe, expect, test } from 'vitest'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import { coordinator, databaseFile, FakeEffects, otherRelay, relay, startExisting } from './fixtures.ts'

describe('WorkflowCoordinator durable barriers', () => {
	test('cancellation tombstones dormant work and a later root receipt cannot open a child', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		const root = fake.sent[0]
		const cancelled = await value.cancel({ clientId: 'cancel', workflowId: accepted.workflow.id })
		expect(cancelled.workflow.phase).toBe('cancelled')
		fake.promote(root.receipt.id)
		await value.wake(accepted.workflow.id)
		expect(fake.opened).toEqual([])
		expect(db.listWorkflowJobs(accepted.workflow.id)[0].state).toBe('cancelled')
		db.close()
	})

	test('does not treat Workflow cancellation as confirmation that global UI quarantine is stable', async () => {
		const { db, fake, value } = coordinator()
		fake.failConfigureAfterDispatch = true
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		expect(db.getUiQuarantine().active).toBe(true)

		await value.cancel({ clientId: 'cancel-ambiguous', workflowId: accepted.workflow.id })

		expect(value.projection(accepted.workflow.id).phase).toBe('cancelled')
		expect(db.getUiQuarantine()).toMatchObject({ active: true, actionId: 'configure-root' })
		db.close()
	})

	test('quarantines a may-execute failure that races Workflow cancellation', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		fake.failConfigureAfterDispatch = true
		fake.afterConfigureDispatch = async () => {
			await value.cancel({ clientId: 'cancel-inside-effect', workflowId: accepted.workflow.id })
		}

		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('cancelled')
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({
			state: 'ambiguous',
			mayExecute: true
		})
		expect(db.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'configure-root',
			effectId: `${accepted.workflow.id}:configure-root`
		})
		db.close()
	})

	test('records delivered effects and child outcomes observed after cancellation without scheduling work', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		const root = fake.sent[0]
		await value.cancel({ clientId: 'cancel-before-root-delivery', workflowId: accepted.workflow.id })
		expect(value.runIdsNeedingWake()).toContain(accepted.workflow.id)
		fake.promote(root.receipt.id)
		await value.wake(accepted.workflow.id)

		expect(db.listWorkflowEvents(accepted.workflow.id).some(event => event.type === 'late_effect')).toBe(true)
		expect(db.getWorkflowEffect(accepted.workflow.id, 'send-root')?.receipt).toMatchObject({
			kind: 'message',
			id: root.receipt.id
		})
		expect(db.getWorkflowEffect(accepted.workflow.id, 'send-root')?.state).toBe('committed')
		expect(fake.opened).toEqual([])
		expect(value.runIdsNeedingWake()).not.toContain(accepted.workflow.id)

		const second = coordinator()
		const running = await startExisting(second.value)
		await second.value.wake(running.workflow.id)
		second.fake.promote(second.fake.sent[0].receipt.id)
		await second.value.wake(running.workflow.id)
		const child = second.db.listWorkflowJobs(running.workflow.id)[0]
		if (!child.childSessionId) throw new Error('bootstrap child did not become runnable')
		await second.value.cancel({ clientId: 'cancel-running-child', workflowId: running.workflow.id })
		expect(second.value.runIdsNeedingWake()).toContain(running.workflow.id)
		second.fake.outcomes.set(child.childSessionId, {
			kind: 'success',
			baton: 'late Baton must remain audit-only'
		})
		await second.value.wake(running.workflow.id)

		expect(second.db.getWorkflowJob(child.id)).toMatchObject({
			state: 'cancelled',
			outcome: { kind: 'success', baton: 'late Baton must remain audit-only' }
		})
		expect(second.db.listWorkflowEvents(running.workflow.id).some(event => event.type === 'late_child_result')).toBe(
			true
		)
		expect(second.fake.sent.filter(item => item.kind === 'baton')).toEqual([])
		expect(second.value.runIdsNeedingWake()).not.toContain(running.workflow.id)
		db.close()
		second.db.close()
	})

	test('keeps a cancelled outbox task wakeable through promotion, restart, and a later child result', async () => {
		const file = databaseFile()
		const { db, fake, value } = coordinator(file)
		fake.taskReceiptsAreOutbox = true
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		fake.promote(fake.sent[0].receipt.id)
		await value.wake(accepted.workflow.id)

		const child = db.listWorkflowJobs(accepted.workflow.id)[0]
		if (!child.childSessionId) throw new Error('bootstrap child was not opened')
		const task = fake.sent.find(item => item.sessionId === child.childSessionId)
		if (task?.receipt.kind !== 'outbox') throw new Error('child task was not accepted into the outbox')
		expect(child).toMatchObject({ state: 'sending', taskReceipt: { kind: 'outbox', id: task.receipt.id } })

		await value.cancel({ clientId: 'cancel-outbox-task', workflowId: accepted.workflow.id })
		expect(value.runIdsNeedingWake()).toContain(accepted.workflow.id)
		fake.promote(task.receipt.id)
		await value.wake(accepted.workflow.id)
		expect(db.getWorkflowJob(child.id)?.taskReceipt).toMatchObject({
			kind: 'message',
			id: task.receipt.id
		})
		expect(value.runIdsNeedingWake()).toContain(accepted.workflow.id)
		db.close()

		const reopened = new OrchestrationDb(file, { processProbe: identity => identity.pid === process.pid })
		const restarted = new WorkflowCoordinator(reopened, relay, fake.deps())
		expect(restarted.runIdsNeedingWake()).toContain(accepted.workflow.id)
		fake.outcomes.set(child.childSessionId, { kind: 'success', baton: 'late after restart' })
		await restarted.wake(accepted.workflow.id)

		expect(reopened.getWorkflowJob(child.id)).toMatchObject({
			state: 'cancelled',
			outcome: { kind: 'success', baton: 'late after restart' }
		})
		expect(restarted.runIdsNeedingWake()).not.toContain(accepted.workflow.id)
		expect(reopened.listWorkflowEvents(accepted.workflow.id).some(event => event.type === 'late_child_result')).toBe(
			true
		)
		reopened.close()
	})

	test('settles a late positive effect and clears only its matching quarantine after cancellation', async () => {
		const { db, fake, value } = coordinator()
		fake.failConfigureAfterDispatch = true
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')?.state).toBe('ambiguous')
		expect(db.getUiQuarantine()).toMatchObject({ active: true, actionId: 'configure-root' })

		await value.cancel({ clientId: 'cancel-before-late-positive', workflowId: accepted.workflow.id })
		fake.failConfigureAfterDispatch = false
		fake.preconfiguredActions.add('configure-root')
		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('cancelled')
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({
			state: 'committed',
			receipt: { matched: true, source: 'frozen-state-read' }
		})
		expect(db.getUiQuarantine().active).toBe(false)
		expect(fake.sent).toEqual([])
		db.close()
	})

	test('never quarantines a live effect owner, including after cancellation', async () => {
		let ownerAlive = true
		const db = new OrchestrationDb(databaseFile(), {
			processProbe: identity => (identity.pid === otherRelay.pid ? ownerAlive : true)
		})
		const fake = new FakeEffects()
		const value = new WorkflowCoordinator(db, relay, fake.deps())
		const accepted = await startExisting(value)
		const run = db.getWorkflowRun(accepted.workflow.id)
		if (!run) throw new Error('Workflow was not persisted')
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'configure-root',
			owner: otherRelay,
			expectedCancellationGeneration: run.cancellationGeneration
		})
		if (!claim) throw new Error('test effect was not claimed')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'configure-root',
			owner: otherRelay,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'a'.repeat(64),
			mayExecute: true
		})
		fake.ambiguousActions.add('configure-root')

		await value.wake(run.id)
		expect(db.getWorkflowEffect(run.id, 'configure-root')?.state).toBe('dispatched')
		expect(db.getUiQuarantine().active).toBe(false)
		await value.cancel({ clientId: 'cancel-live-owner', workflowId: run.id })
		await value.wake(run.id)
		expect(db.getWorkflowEffect(run.id, 'configure-root')?.state).toBe('dispatched')
		expect(db.getUiQuarantine().active).toBe(false)

		ownerAlive = false
		await value.wake(run.id)
		expect(db.getWorkflowEffect(run.id, 'configure-root')?.state).toBe('ambiguous')
		expect(db.getUiQuarantine()).toMatchObject({ active: true, actionId: 'configure-root' })
		db.close()
	})
})
