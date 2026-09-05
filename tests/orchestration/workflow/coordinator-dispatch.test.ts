import { describe, expect, test } from 'vitest'
import { workflowEffectCorrelationMarker } from '../../../src/orchestration/workflow/coordinator.ts'
import { coordinator, startExisting } from './fixtures.ts'

describe('WorkflowCoordinator durable barriers', () => {
	test('revalidates the exact root under the UI locks before its first prompt dispatch', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		fake.rejectRootActionBeforeDispatch = 'send-root'

		await value.wake(accepted.workflow.id)

		expect(fake.configured).toEqual(['root-1'])
		expect(fake.sent).toEqual([])
		expect(value.projection(accepted.workflow.id)).toMatchObject({
			phase: 'blocked',
			error: { code: 'workflow_root_not_pristine', retryable: false },
			actions: { canRetry: false, canReplayAmbiguous: false }
		})
		expect(db.getWorkflowEffect(accepted.workflow.id, 'send-root')).toMatchObject({ state: 'failed' })
		expect(db.getUiQuarantine().active).toBe(false)
		db.close()
	})

	test('blocks when an incompatible relay appears between Start and the locked dispatch boundary', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		// The wake-loop scan passes; the second scan under the UI lock observes
		// the process that appeared in between.
		fake.compatibilityFailureCall = fake.compatibilityCalls + 2

		await value.wake(accepted.workflow.id)

		expect(fake.configured).toEqual([])
		expect(fake.sent).toEqual([])
		expect(value.projection(accepted.workflow.id)).toMatchObject({
			phase: 'blocked',
			error: { code: 'workflow_incompatible_relay', retryable: true },
			actions: { canRetry: true, canReplayAmbiguous: false }
		})
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({
			state: 'failed',
			mayExecute: false
		})
		db.close()
	})

	test('persists gated process identity before mayExecute and keeps an unopened gate retryable', async () => {
		const completedGate = coordinator()
		completedGate.fake.gatedActions.add('configure-root')
		completedGate.fake.gateReleases = 2
		const accepted = await startExisting(completedGate.value)
		await completedGate.value.wake(accepted.workflow.id)
		expect(completedGate.db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({
			state: 'committed',
			mayExecute: true,
			externalProcess: { pid: 42_425, processGroup: 42_425 }
		})
		completedGate.db.close()

		const unopenedGate = coordinator()
		unopenedGate.fake.gatedActions.add('configure-root')
		unopenedGate.fake.skipGateRelease = true
		const blocked = await startExisting(unopenedGate.value)
		await unopenedGate.value.wake(blocked.workflow.id)
		expect(unopenedGate.value.projection(blocked.workflow.id)).toMatchObject({
			phase: 'blocked',
			actions: { canRetry: true, canReplayAmbiguous: false }
		})
		expect(unopenedGate.db.getWorkflowEffect(blocked.workflow.id, 'configure-root')).toMatchObject({
			state: 'failed',
			mayExecute: false
		})
		unopenedGate.db.close()
	})

	test('commits a positively matched frozen configuration without inventing a UI dispatch', async () => {
		const { db, fake, value } = coordinator()
		fake.preconfiguredActions.add('configure-root')
		const accepted = await startExisting(value)

		await value.wake(accepted.workflow.id)

		expect(fake.configured).toEqual([])
		expect(db.getWorkflowEffect(accepted.workflow.id, 'configure-root')).toMatchObject({
			state: 'committed',
			mayExecute: false,
			attemptCount: 0,
			receipt: { matched: true, source: 'frozen-state-read' }
		})
		expect(
			db
				.listWorkflowEvents(accepted.workflow.id)
				.some(event => event.type === 'workflow_effect_satisfied_without_dispatch')
		).toBe(true)
		expect(fake.sent).toHaveLength(1)
		db.close()
	})

	test('reuses a previously prepared task effect without rematerializing a mutable handoff', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		fake.failMaterialize = true
		fake.promote(fake.sent[0].receipt.id)
		await expect(value.wake(accepted.workflow.id)).rejects.toThrow('handoff render interrupted')
		const run = db.getWorkflowRun(accepted.workflow.id)
		const job = db.listWorkflowJobs(accepted.workflow.id)[0]
		if (!run || !job.childSessionId || job.state !== 'configuring') {
			throw new Error('test did not stop at the configured child boundary')
		}
		const actionId = `${job.id}:task:${job.attemptCount}`
		const stablePrompt = `frozen handoff\n\n${workflowEffectCorrelationMarker(run.id, actionId)}`
		db.prepareWorkflowEffect({
			id: `${run.id}:${actionId}`,
			runId: run.id,
			actionId,
			kind: 'send_task',
			jobId: job.id,
			target: { sessionId: job.childSessionId },
			inputs: { prompt: stablePrompt, correlationMarker: workflowEffectCorrelationMarker(run.id, actionId) },
			cursor: { rowid: 91, outboxIds: ['prior'] },
			expectedCancellationGeneration: run.cancellationGeneration,
			eventKey: `test-prepare:${actionId}`
		})
		const priorMaterializations = fake.materializeCalls
		fake.failMaterialize = false

		await value.wake(run.id)

		expect(fake.materializeCalls).toBe(priorMaterializations)
		expect(fake.sent.some(item => item.sessionId === job.childSessionId && item.text === stablePrompt)).toBe(true)
		db.close()
	})
})
