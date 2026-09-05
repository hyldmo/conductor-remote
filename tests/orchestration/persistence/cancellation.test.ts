import { describe, expect, test } from 'vitest'
import { OrchestrationDb, WorkflowTransitionError } from '../../../src/orchestration/persistence/db.ts'
import { databaseFile, relay, startExisting } from './fixtures.ts'

describe('OrchestrationDb transitions, jobs, and effects', () => {
	test('cancellation tombstones pending work and lets a late positive receipt settle dispatched evidence', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 401)
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-before-cancel')
		db.claimNextWorkflowJob(owner, run.id)
		db.createWorkflowJobAttempt({ jobId: bootstrap.id, owner, state: 'opening' })
		db.prepareWorkflowEffect({
			runId: run.id,
			actionId: 'safe-prepared',
			kind: 'configure_child',
			expectedCancellationGeneration: 0,
			eventKey: 'prepare-safe-before-cancel'
		})
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim?.attempt.attemptNumber ?? 0,
			launchNonce: 'may-land'
		})

		const cancelled = db.cancelWorkflowRun(run.id, 'cancel-1')
		expect(cancelled).toMatchObject({ phase: 'cancelled', cancellationGeneration: 1 })
		expect(db.getWorkflowJob(bootstrap.id)).toMatchObject({ state: 'cancelled', cancellationGeneration: 1 })
		expect(db.listWorkflowJobAttempts(bootstrap.id)[0].state).toBe('cancelled')
		expect(db.getWorkflowEffect(run.id, 'safe-prepared')?.state).toBe('cancelled')
		expect(db.getWorkflowEffect(run.id, 'send-root')?.state).toBe('dispatched')
		expect(db.listWorkflowEvents(run.id).at(-1)?.type).toBe('workflow_cancelled')
		db.activateUiQuarantine({
			actionId: 'send-root',
			effectId: 'another-run:send-root',
			reason: 'A newer run owns this hold.'
		})
		expect(() =>
			db.updateWorkflowJobAttempt({
				jobId: bootstrap.id,
				attemptNumber: 1,
				expectedState: 'cancelled',
				state: 'returned',
				eventKey: 'must-not-reopen',
				eventType: 'wrong'
			})
		).toThrow(WorkflowTransitionError)

		db.recordLateWorkflowChildResult({
			runId: run.id,
			jobId: bootstrap.id,
			outcome: { kind: 'success', text: 'finished after cancellation' },
			eventKey: 'late-child-1'
		})
		db.recordLateWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			receipt: { kind: 'message', id: 'late-message', rowid: 99, turnId: 'late-turn' },
			eventKey: 'late-effect-1'
		})
		db.recordLateWorkflowChildResult({
			runId: run.id,
			jobId: bootstrap.id,
			outcome: { kind: 'success', text: 'finished after cancellation' },
			eventKey: 'late-child-1'
		})
		db.recordLateWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			receipt: { kind: 'message', id: 'late-message', rowid: 99, turnId: 'late-turn' },
			eventKey: 'late-effect-1'
		})
		expect(db.getWorkflowJob(bootstrap.id)).toMatchObject({
			state: 'cancelled',
			outcome: { kind: 'success', text: 'finished after cancellation' }
		})
		expect(db.getWorkflowEffect(run.id, 'send-root')).toMatchObject({
			state: 'committed',
			receipt: { kind: 'message', id: 'late-message' }
		})
		expect(db.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'send-root',
			effectId: 'another-run:send-root'
		})
		expect(
			db
				.listWorkflowEvents(run.id)
				.slice(-2)
				.map(event => event.type)
		).toEqual(['late_child_result', 'late_effect'])
		db.close()
	})

	test('keeps terminal cancellation closed across run, job, and gated-effect races', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const owner = relay('cancel-race-owner', 420)
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-cancel-race')
		db.claimNextWorkflowJob(owner, run.id)
		const claimed = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claimed) throw new Error('expected claimed effect')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claimed.attempt.attemptNumber,
			launchNonce: 'cancelled-gate'
		})
		db.cancelWorkflowRun(run.id, 'cancel-race')

		expect(() =>
			db.markWorkflowEffectMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claimed.attempt.attemptNumber,
				launchNonce: 'cancelled-gate',
				externalProcess: { pid: 421, processStartedAt: 'must-stay-gated', processGroup: 421 }
			})
		).toThrow(WorkflowTransitionError)
		expect(() =>
			db.updateWorkflowJob({
				jobId: bootstrap.id,
				expectedStates: ['cancelled'],
				expectedCancellationGeneration: 1,
				state: 'queued',
				eventKey: 'reopen-cancelled-job',
				eventType: 'invalid_reopen'
			})
		).toThrow(WorkflowTransitionError)
		expect(() =>
			db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'cancelled',
				expectedCancellationGeneration: 1,
				phase: 'exploring',
				eventKey: 'reopen-cancelled-run',
				eventType: 'invalid_reopen'
			})
		).toThrow(WorkflowTransitionError)
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'cancel-safe-gated-effect'
			})
		).toMatchObject({ status: 'terminal', effect: { state: 'cancelled', mayExecute: false } })
		db.close()
	})

	test('distinguishes wrapper failure before mayExecute from a lost accepted receipt', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 450)
		const first = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!first) throw new Error('expected first effect attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: first.attempt.attemptNumber,
			launchNonce: 'gated-wrapper',
			mayExecute: false
		})
		expect(
			db.markWorkflowEffectFailedBeforeMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: first.attempt.attemptNumber,
				errorCode: 'wrapper_spawn_failed',
				errorMessage: 'Wrapper never received permission.'
			})
		).toMatchObject({ state: 'failed', mayExecute: false })

		db.retryWorkflowEffect(run.id, 'send-root', 'retry-after-wrapper')
		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!second) throw new Error('expected second effect attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'accepted-send',
			mayExecute: true
		})
		const accepted = { kind: 'outbox', id: 'outbox-1' }
		db.markWorkflowEffectCommitted({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			receipt: accepted
		})
		expect(() =>
			db.markWorkflowEffectReceiptLost({
				runId: run.id,
				actionId: 'send-root',
				expectedReceipt: { kind: 'outbox', id: 'different' },
				errorCode: 'accepted_receipt_lost',
				errorMessage: 'Accepted row disappeared.'
			})
		).toThrow(WorkflowTransitionError)
		expect(
			db.markWorkflowEffectReceiptLost({
				runId: run.id,
				actionId: 'send-root',
				expectedReceipt: accepted,
				errorCode: 'accepted_receipt_lost',
				errorMessage: 'Accepted row disappeared.',
				evidence: { checkedAt: 123 }
			})
		).toMatchObject({ state: 'ambiguous', receipt: accepted })
		expect(db.listWorkflowEffectAttempts(second.effect.id).at(-1)).toMatchObject({
			state: 'ambiguous',
			evidence: { checkedAt: 123 }
		})
		db.close()
	})
})
