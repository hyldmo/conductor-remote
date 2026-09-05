import { describe, expect, test } from 'vitest'
import { coordinator, startExisting } from './fixtures.ts'

describe('WorkflowCoordinator durable barriers', () => {
	test('blocks pre-dispatch failures as retryable and post-dispatch failures as explicit replay risk', async () => {
		const deterministic = coordinator()
		const first = await startExisting(deterministic.value)
		deterministic.fake.failConfigureBeforeDispatch = true
		await deterministic.value.wake(first.workflow.id)
		expect(deterministic.value.projection(first.workflow.id)).toMatchObject({
			phase: 'blocked',
			actions: { canRetry: true, canReplayAmbiguous: false }
		})
		deterministic.fake.failConfigureBeforeDispatch = false
		await deterministic.value.retry({
			clientId: 'retry-configure',
			workflowId: first.workflow.id
		})
		await deterministic.value.wake(first.workflow.id)
		expect(deterministic.fake.sent).toHaveLength(1)
		const retryReplay = await deterministic.value.retry({
			clientId: 'retry-configure',
			workflowId: first.workflow.id
		})
		expect(retryReplay).toMatchObject({ replayed: true, workflow: { id: first.workflow.id } })
		deterministic.db.close()

		const ambiguous = coordinator()
		const second = await startExisting(ambiguous.value)
		ambiguous.fake.failConfigureAfterDispatch = true
		await ambiguous.value.wake(second.workflow.id)
		expect(ambiguous.value.projection(second.workflow.id)).toMatchObject({
			phase: 'blocked',
			actions: { canRetry: false, canReplayAmbiguous: true }
		})
		expect(ambiguous.db.getUiQuarantine().active).toBe(true)
		ambiguous.fake.failConfigureAfterDispatch = false
		await ambiguous.value.replay({
			clientId: 'replay-configure',
			workflowId: second.workflow.id,
			actionId: 'configure-root',
			confirmDuplicateRisk: true
		})
		await ambiguous.value.wake(second.workflow.id)
		expect(ambiguous.db.getWorkflowEffect(second.workflow.id, 'configure-root')?.attemptCount).toBe(2)
		expect(ambiguous.db.getUiQuarantine().active).toBe(false)
		ambiguous.db.close()
	})

	test('does not clear an unrelated global UI hold while replaying an ambiguous effect', async () => {
		const { db, fake, value } = coordinator()
		fake.failConfigureAfterDispatch = true
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		expect(db.getUiQuarantine()).toMatchObject({ active: true, actionId: 'configure-root' })

		db.clearUiQuarantine('test-replaced-hold')
		db.activateUiQuarantine({
			// Stable action IDs repeat across runs; the effect ID is the exact identity.
			actionId: 'configure-root',
			effectId: 'unrelated-effect',
			reason: 'A separate relay action still needs inspection.'
		})
		fake.failConfigureAfterDispatch = false
		await value.replay({
			clientId: 'replay-with-unrelated-hold',
			workflowId: accepted.workflow.id,
			actionId: 'configure-root',
			confirmDuplicateRisk: true
		})

		expect(value.projection(accepted.workflow.id).phase).toBe('pending_root')
		expect(db.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'configure-root',
			effectId: 'unrelated-effect'
		})
		db.close()
	})

	test('blocks a lost accepted outbox receipt without automatically replaying it', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		const root = fake.sent[0]
		if (root.receipt.kind !== 'outbox') throw new Error('root was not accepted into the outbox')
		fake.lose(root.receipt.id)

		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id)).toMatchObject({
			phase: 'blocked',
			error: { code: 'outbox_receipt_lost', retryable: false },
			actions: { canRetry: false, canReplayAmbiguous: true }
		})
		expect(db.getWorkflowEffect(accepted.workflow.id, 'send-root')).toMatchObject({
			state: 'ambiguous',
			errorCode: 'outbox_receipt_lost'
		})
		expect(db.getUiQuarantine().active).toBe(true)
		expect(fake.opened).toEqual([])
		db.close()
	})

	test('resumes a blocked ambiguous effect when a later positive receipt appears', async () => {
		const { db, fake, value } = coordinator()
		fake.failConfigureAfterDispatch = true
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id).phase).toBe('blocked')
		expect(db.getUiQuarantine().active).toBe(true)

		fake.failConfigureAfterDispatch = false
		fake.preconfiguredActions.add('configure-root')
		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('pending_root')
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({ state: 'committed' })
		expect(db.getUiQuarantine().active).toBe(false)
		expect(fake.sent).toHaveLength(1)
		db.close()
	})
})
