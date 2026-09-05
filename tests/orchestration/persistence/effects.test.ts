import { describe, expect, test } from 'vitest'
import { OrchestrationDb, WorkflowTransitionError } from '../../../src/orchestration/persistence/db.ts'
import { databaseFile, relay, startExisting } from './fixtures.ts'

describe('OrchestrationDb transitions, jobs, and effects', () => {
	test('records durable effect attempts and permits replay only after a pre-dispatch failure', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 201)
		const claimed = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(claimed?.attempt).toMatchObject({ attemptNumber: 1, state: 'prepared', mayExecute: false })

		db.markWorkflowEffectFailed({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 1,
			errorCode: 'window_missing',
			errorMessage: 'No window before dispatch'
		})
		expect(db.getWorkflowEffect(run.id, 'send-root')?.state).toBe('failed')
		db.retryWorkflowEffect(run.id, 'send-root', 'retry-root')

		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(second?.attempt.attemptNumber).toBe(2)
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			launchNonce: 'launch-2'
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			launchNonce: 'launch-2',
			externalProcess: { pid: 301, processStartedAt: 'external-start', processGroup: 301 }
		})
		const committed = db.markWorkflowEffectCommitted({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			receipt: { kind: 'message', rowid: 44, turnId: 'turn-1' }
		})
		expect(committed).toMatchObject({
			state: 'committed',
			mayExecute: true,
			attemptCount: 2,
			receipt: { kind: 'message', rowid: 44, turnId: 'turn-1' }
		})
		expect(() => db.retryWorkflowEffect(run.id, 'send-root', 'unsafe-retry')).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('commits a positively matched configuration without claiming or dispatching it', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const configured = db.prepareWorkflowEffect({
			runId: run.id,
			actionId: 'configure-root',
			kind: 'configure_root',
			target: { sessionId: 'root-1' },
			inputs: { model: 'GPT-5.6 Sol', effort: 'high' },
			expectedCancellationGeneration: 0,
			eventKey: 'prepare-configure-root'
		}).effect
		const receipt = { kind: 'settings_match', provider: 'codex', model: 'GPT-5.6 Sol', effort: 'high' }

		expect(
			db.markWorkflowEffectSatisfiedWithoutDispatch({
				runId: run.id,
				actionId: configured.actionId,
				expectedCancellationGeneration: 0,
				receipt,
				eventKey: 'configure-root-already-matched'
			})
		).toMatchObject({ state: 'committed', mayExecute: false, attemptCount: 0, receipt })
		expect(db.listWorkflowEffectAttempts(configured.id)).toEqual([])
		expect(db.listWorkflowEvents(run.id).at(-1)).toMatchObject({
			eventKey: 'configure-root-already-matched',
			type: 'workflow_effect_satisfied_without_dispatch',
			data: { actionId: 'configure-root', receipt }
		})
		expect(() =>
			db.markWorkflowEffectSatisfiedWithoutDispatch({
				runId: run.id,
				actionId: 'send-root',
				expectedCancellationGeneration: 0,
				receipt: { kind: 'message', id: 'not-allowed' }
			})
		).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('audits sequential gated process identities once per distinct wrapper', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('sequential-gates', 320)
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch'
		})
		const first = { pid: 321, processStartedAt: 'first-wrapper', processGroup: 321 }
		const second = { pid: 322, processStartedAt: 'second-wrapper', processGroup: 322 }

		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch',
			externalProcess: first
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch',
			externalProcess: first
		})
		expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_effect_may_execute')).toHaveLength(1)

		expect(
			db.markWorkflowEffectMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claim.attempt.attemptNumber,
				launchNonce: 'sequential-launch',
				externalProcess: second
			})
		).toMatchObject({ externalProcess: second, mayExecute: true })
		expect(db.listWorkflowEffectAttempts(claim.effect.id).at(-1)).toMatchObject({ externalProcess: second })
		const executionEvents = db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_effect_may_execute')
		expect(executionEvents).toHaveLength(2)
		expect(executionEvents.map(event => event.eventKey)).toEqual([
			expect.stringContaining('effect_may_execute:send-root:1:321:'),
			expect.stringContaining('effect_may_execute:send-root:1:322:')
		])
		db.close()
	})

	test('does not dispatch a claimed effect after its run becomes blocked', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('blocked-before-dispatch', 325)
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		db.transitionWorkflowRun({
			runId: run.id,
			expectedPhase: 'pending_root',
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'send-root',
				errorCode: 'compatibility_changed',
				message: 'A conflicting relay appeared.',
				resumePhase: 'pending_root',
				retryClass: 'terminal'
			},
			eventKey: 'blocked-before-effect-dispatch',
			eventType: 'workflow_blocked'
		})

		expect(() =>
			db.markWorkflowEffectDispatched({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claim.attempt.attemptNumber,
				launchNonce: 'must-not-dispatch'
			})
		).toThrow(WorkflowTransitionError)
		expect(db.getWorkflowEffect(run.id, 'send-root')).toMatchObject({ state: 'prepared', mayExecute: false })
		db.close()
	})

	test('restarts effect recovery when a newer external identity appears during probing', () => {
		const file = databaseFile()
		const owner = relay('effect-recovery-owner', 330)
		const ownerDb = new OrchestrationDb(file)
		const run = startExisting(ownerDb).run
		const claim = ownerDb.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		ownerDb.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'identity-race'
		})
		ownerDb.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'identity-race',
			externalProcess: { pid: 331, processStartedAt: 'old-wrapper', processGroup: 331 }
		})

		let injected = false
		const recoveryDb = new OrchestrationDb(file, {
			processProbe: identity => {
				if (identity.pid === 331 && !injected) {
					injected = true
					ownerDb.markWorkflowEffectMayExecute({
						runId: run.id,
						actionId: 'send-root',
						owner,
						attemptNumber: claim.attempt.attemptNumber,
						launchNonce: 'identity-race',
						externalProcess: { pid: 332, processStartedAt: 'new-wrapper', processGroup: 332 }
					})
					return false
				}
				return identity.pid === 332
			}
		})
		expect(
			recoveryDb.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-identity-race'
			})
		).toMatchObject({ status: 'changed', effect: { externalProcess: { pid: 332 } } })
		expect(
			recoveryDb.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-new-identity'
			})
		).toMatchObject({ status: 'external_process_alive' })
		ownerDb.close()
		recoveryDb.close()
	})

	test('recovers dead effect owners only before execution and requires explicit replay after ambiguity', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const owner = relay('dead-owner', 350)
		const first = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(first?.attempt.attemptNumber).toBe(1)
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-before-dispatch'
			})
		).toMatchObject({ status: 'safely_prepared', effect: { state: 'prepared' } })
		expect(db.listWorkflowEffectAttempts(first?.effect.id ?? '')[0]).toMatchObject({
			state: 'cancelled',
			evidence: { reason: 'owner_died_before_may_execute' }
		})

		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!second) throw new Error('expected second attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'second-launch'
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'second-launch'
		})
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-after-dispatch'
			})
		).toMatchObject({ status: 'ambiguous', effect: { state: 'ambiguous' } })
		expect(() => db.retryWorkflowEffect(run.id, 'send-root', 'ordinary-retry')).toThrow(WorkflowTransitionError)
		expect(db.replayAmbiguousWorkflowEffect(run.id, 'send-root', 'phone-confirmed-replay').state).toBe('prepared')
		db.close()
	})
})
