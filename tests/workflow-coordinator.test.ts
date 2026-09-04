import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ORCHESTRATION_PROTOCOL_VERSION, OrchestrationDb, type RelayIdentity } from '../src/orchestration-db.ts'
import type { DeliveryReceipt } from '../src/reads.ts'
import { scrubWorkflowSecrets } from '../src/shared.ts'
import type { CachedModelGroup, RolesConfig } from '../src/wire.ts'
import {
	type WorkflowChildOutcome,
	WorkflowCoordinator,
	type WorkflowCoordinatorDeps,
	WorkflowCoordinatorError,
	workflowEffectCorrelationMarker
} from '../src/workflow-coordinator.ts'
import { uiTurn } from '../src/writes.ts'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function databaseFile(): string {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-workflow-coordinator-'))
	directories.push(directory)
	return join(directory, 'orchestration.db')
}

const relay: RelayIdentity = {
	instanceId: 'relay-test',
	pid: process.pid,
	processStartedAt: 'test-process-start',
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
}

const otherRelay: RelayIdentity = {
	instanceId: 'relay-other',
	pid: process.pid + 10_000,
	processStartedAt: 'other-process-start',
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
}

const roles: RolesConfig = {
	version: 1,
	roles: {
		planning: { model: '5.6 Sol', effort: 'high', preamble: 'Plan without editing.' },
		exploration: { model: 'Claude Sonnet 4.6', effort: 'medium', preamble: 'Investigate only.' },
		implementation: { model: 'Claude Opus 4.6', effort: 'high', preamble: 'Implement carefully.' }
	}
}

const modelGroups: CachedModelGroup[] = [
	{
		agentType: 'codex',
		models: ['5.6 Sol', 'Claude Sonnet 4.6', 'Claude Opus 4.6'],
		updatedAt: 100
	}
]

const capability = (text: string): string => {
	const match = text.match(/\bcrwf_v\d+_[A-Za-z0-9_-]+\b/)
	if (!match) throw new Error(`message did not contain a Workflow capability: ${text}`)
	return match[0]
}

class FakeEffects {
	readonly sent: Array<{ kind: 'task' | 'baton'; sessionId: string; text: string; receipt: DeliveryReceipt }> = []
	readonly configured: string[] = []
	readonly opened: string[] = []
	readonly receipts = new Map<string, DeliveryReceipt>()
	readonly lostReceipts = new Set<string>()
	readonly outcomes = new Map<string, WorkflowChildOutcome>()
	readonly sessionBaselines: unknown[] = []
	readonly gatedActions = new Set<string>()
	readonly preconfiguredActions = new Set<string>()
	readonly ambiguousActions = new Set<string>()
	inspectionCalls = 0
	compatibilityCalls = 0
	compatibilityFailureCall: number | null = null
	materializeCalls = 0
	failCompatibility = false
	failConfigureBeforeDispatch = false
	failConfigureAfterDispatch = false
	afterConfigureDispatch: (() => Promise<void>) | null = null
	failMaterialize = false
	taskReceiptsAreOutbox = false
	rejectRootActionBeforeDispatch: string | null = null
	skipGateRelease = false
	gateReleases = 1
	private nextRowid = 20

	message(id: string = randomUUID()): Extract<DeliveryReceipt, { kind: 'message' }> {
		const receipt: Extract<DeliveryReceipt, { kind: 'message' }> = {
			kind: 'message',
			id,
			rowid: this.nextRowid++,
			turnId: `turn-${id}`
		}
		this.receipts.set(id, receipt)
		return receipt
	}

	outbox(id: string = randomUUID()): Extract<DeliveryReceipt, { kind: 'outbox' }> {
		const receipt: Extract<DeliveryReceipt, { kind: 'outbox' }> = { kind: 'outbox', id }
		this.receipts.set(id, receipt)
		return receipt
	}

	promote(id: string): Extract<DeliveryReceipt, { kind: 'message' }> {
		return this.message(id)
	}

	lose(id: string): void {
		this.receipts.delete(id)
		this.lostReceipts.add(id)
	}

	deps(): WorkflowCoordinatorDeps {
		return {
			captureWorkspaceBaseline: async repo => ({ repo, workspaceIds: [] }),
			inspectExistingRoot: async target => {
				this.inspectionCalls++
				return {
					workspaceId: target.workspaceId,
					rootSessionId: target.sessionId,
					pristine: true,
					pristineEvidence: { durableRows: 0, outboxIds: [] },
					deliveryCursor: { rowid: 0, outboxIds: [] }
				}
			},
			bindCreatedRoot: async ({ workspaceId }) => ({
				workspaceId,
				rootSessionId: `root-${workspaceId}`,
				pristine: true,
				pristineEvidence: { durableRows: 0, outboxIds: [] },
				deliveryCursor: { rowid: 0, outboxIds: [] }
			}),
			createWorkspace: async ({ run }) => uiTurn(async () => ({ workspaceId: `workspace-${run.id}` })),
			configureSession: async ({ effect, sessionId, dispatch }) => {
				if (this.failConfigureBeforeDispatch) throw new Error('configure failed before UI dispatch')
				return uiTurn(async () => {
					if (dispatch.mode === 'gated_child' && !this.skipGateRelease) {
						for (let index = 0; index < this.gateReleases; index++) {
							await dispatch.gatedProcessReady({
								pid: 42_424 + index,
								processStartedAt: `gated-${effect.actionId}-${index}`,
								processGroup: 42_424 + index
							})
						}
					}
					await this.afterConfigureDispatch?.()
					if (this.failConfigureAfterDispatch) throw new Error('configure failed after UI dispatch')
					this.configured.push(sessionId)
					return { matched: true }
				})
			},
			openChild: async ({ job }) =>
				uiTurn(async () => {
					const sessionId = `child-${job.id}-${job.attemptCount}`
					this.opened.push(sessionId)
					return { sessionId }
				}),
			captureSessionBaseline: async workspaceId => {
				const baseline = { workspaceId, sessionIds: [`prior-${this.sessionBaselines.length}`] }
				this.sessionBaselines.push(baseline)
				return baseline
			},
			captureDeliveryCursor: async () => ({ rowid: 0, outboxIds: [] }),
			captureTranscriptCursor: async () => ({ rowid: 0 }),
			materializeHandoff: async () => {
				this.materializeCalls++
				if (this.failMaterialize) throw new Error('handoff render interrupted')
				return undefined
			},
			sendPrompt: async ({ effect, sessionId, text }) =>
				uiTurn(async () => {
					const receipt =
						effect.kind === 'send_root' || (effect.kind === 'send_task' && this.taskReceiptsAreOutbox)
							? this.outbox()
							: this.message()
					this.sent.push({ kind: 'task', sessionId, text, receipt })
					return receipt
				}),
			returnBaton: async ({ sessionId, text }) =>
				uiTurn(async () => {
					const receipt = this.outbox()
					this.sent.push({ kind: 'baton', sessionId, text, receipt })
					return receipt
				}),
			resolveDeliveryReceipt: async ({ receipt }) => {
				if (this.lostReceipts.has(receipt.id)) return { status: 'lost' as const, evidence: { id: receipt.id } }
				const current = this.receipts.get(receipt.id)
				return current?.kind === 'message'
					? { status: 'delivered' as const, receipt: current }
					: { status: 'pending' as const }
			},
			readChildOutcome: async ({ job }) =>
				job.childSessionId ? (this.outcomes.get(job.childSessionId) ?? null) : null,
			validateBeforeDispatch: async ({ effect }) => {
				if (effect.actionId === this.rejectRootActionBeforeDispatch) {
					throw new WorkflowCoordinatorError(
						'workflow_root_not_pristine',
						'The root received another prompt before Workflow dispatch.'
					)
				}
			},
			reconcileEffect: async ({ effect }) => {
				if (this.preconfiguredActions.has(effect.actionId)) {
					return { status: 'committed' as const, receipt: { matched: true, source: 'frozen-state-read' } }
				}
				if (this.ambiguousActions.has(effect.actionId)) {
					return { status: 'ambiguous' as const, evidence: { candidateCount: 0 } }
				}
				return { status: 'pending' as const }
			},
			assertCompatibleRelays: async () => {
				this.compatibilityCalls++
				if (this.failCompatibility || this.compatibilityCalls === this.compatibilityFailureCall) {
					throw new WorkflowCoordinatorError('workflow_incompatible_relay', 'An incompatible relay is live.', {
						retryable: true
					})
				}
			},
			dispatchMode: effect => (this.gatedActions.has(effect.actionId) ? 'gated_child' : 'in_process')
		}
	}
}

function coordinator(file = databaseFile()) {
	const db = new OrchestrationDb(file, { processProbe: identity => identity.pid === process.pid })
	const fake = new FakeEffects()
	const value = new WorkflowCoordinator(db, relay, fake.deps())
	return { db, fake, value }
}

async function startExisting(value: WorkflowCoordinator, clientId: string = randomUUID()) {
	return value.start({
		clientId,
		objective: 'Build a deterministic Workflow coordinator',
		target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
		roles,
		modelGroups
	})
}

describe('WorkflowCoordinator durable barriers', () => {
	test('preserves immutable role-preflight error codes', async () => {
		const { db, value } = coordinator()
		await expect(
			value.start({
				clientId: 'bad-roles',
				objective: 'This must never create a run.',
				target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
				roles: { version: 1, roles: {} },
				modelGroups
			})
		).rejects.toMatchObject({ code: 'role_not_found', status: 409 })
		expect(db.listWorkflowProjections({ includeTerminal: true })).toEqual([])
		db.close()
	})

	test('returns an accepted Start replay before changed roles or live prerequisites are read again', async () => {
		const { db, fake, value } = coordinator()
		const first = await startExisting(value, 'stable-start')
		const inspections = fake.inspectionCalls
		const compatibilityChecks = fake.compatibilityCalls
		fake.failCompatibility = true

		const replay = await value.start({
			clientId: 'stable-start',
			objective: 'Build a deterministic Workflow coordinator',
			target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
			roles: { version: 1, roles: {} },
			modelGroups: []
		})

		expect(replay).toMatchObject({ replayed: true, workflow: { id: first.workflow.id } })
		expect(fake.inspectionCalls).toBe(inspections)
		expect(fake.compatibilityCalls).toBe(compatibilityChecks)
		db.close()
	})

	test('persists accepted intent without UI and activates explore:0 only after root delivery', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)

		expect(accepted.replayed).toBe(false)
		expect(accepted.workflow.phase).toBe('pending_root')
		expect(fake.configured).toEqual([])
		expect(fake.sent).toEqual([])
		const dormant = db.listWorkflowJobs(accepted.workflow.id)[0]
		expect(dormant).toMatchObject({ logicalKey: 'explore:0', state: 'dormant' })
		expect(dormant.prompt).toContain(workflowEffectCorrelationMarker(accepted.workflow.id, `job:${dormant.id}`))
		expect(scrubWorkflowSecrets(dormant.prompt)).not.toContain('[conductor-remote workflow:')

		await value.wake(accepted.workflow.id)
		const rootSend = fake.sent.find(item => item.sessionId === 'root-1' && item.kind === 'task')
		expect(rootSend?.receipt.kind).toBe('outbox')
		expect(rootSend?.text).toContain(workflowEffectCorrelationMarker(accepted.workflow.id, 'send-root'))
		expect(scrubWorkflowSecrets(rootSend?.text ?? '')).not.toContain('[conductor-remote workflow:')
		expect(fake.opened).toEqual([])
		expect(value.projection(accepted.workflow.id).phase).toBe('pending_root')
		expect(db.listWorkflowJobs(accepted.workflow.id)[0].state).toBe('dormant')

		const deliveredRoot = fake.promote(rootSend?.receipt.id ?? '')
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id).phase).toBe('exploring')
		expect(fake.opened).toHaveLength(1)
		const bootstrap = db.listWorkflowJobs(accepted.workflow.id)[0]
		expect(bootstrap).toMatchObject({ state: 'running', transcriptCursor: { rowid: deliveredRoot.rowid } })
		const open = db.getWorkflowEffect(accepted.workflow.id, `${bootstrap.id}:open:1`)
		expect(open?.baseline).toEqual(fake.sessionBaselines[0])
		const task = fake.sent.find(item => item.sessionId === bootstrap.childSessionId && item.kind === 'task')
		expect(task?.text).toContain(
			workflowEffectCorrelationMarker(accepted.workflow.id, `${bootstrap.id}:task:${bootstrap.attemptCount}`)
		)
		db.close()
	})

	test('keeps an explorer returning while its Baton is only accepted, then issues planning authority on delivery', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		const root = fake.sent[0]
		fake.promote(root.receipt.id)
		await value.wake(accepted.workflow.id)

		const explorer = db.listWorkflowJobs(accepted.workflow.id)[0]
		if (!explorer.childSessionId) throw new Error('bootstrap explorer did not open')
		fake.outcomes.set(explorer.childSessionId, {
			kind: 'success',
			baton: '## Baton\n### Decision\nThe coordinator boundary is sound.'
		})
		await value.wake(accepted.workflow.id)

		const acceptedBaton = fake.sent.find(item => item.kind === 'baton')
		expect(acceptedBaton?.receipt.kind).toBe('outbox')
		expect(acceptedBaton?.text).toContain(
			workflowEffectCorrelationMarker(accepted.workflow.id, `${explorer.id}:baton:${explorer.attemptCount}`)
		)
		expect(scrubWorkflowSecrets(acceptedBaton?.text ?? '')).not.toContain('[conductor-remote workflow:')
		expect(value.projection(accepted.workflow.id).phase).toBe('exploring')
		expect(db.listWorkflowJobs(accepted.workflow.id)[0].state).toBe('returning')

		fake.promote(acceptedBaton?.receipt.id ?? '')
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id).phase).toBe('planning')
		expect(db.listWorkflowJobs(accepted.workflow.id)[0]).toMatchObject({
			state: 'returned',
			batonReceipt: { kind: 'message' }
		})
		expect(capability(acceptedBaton?.text ?? '')).toMatch(/^crwf_v1_/)
		db.close()
	})

	test('runs a capability-scoped implementation and leaves reviewing stable until phone completion', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		fake.promote(fake.sent[0].receipt.id)
		await value.wake(accepted.workflow.id)
		const explorer = db.listWorkflowJobs(accepted.workflow.id)[0]
		fake.outcomes.set(explorer.childSessionId ?? '', { kind: 'success', baton: 'Explorer evidence.' })
		await value.wake(accepted.workflow.id)
		const explorerBaton = fake.sent.find(item => item.kind === 'baton')
		fake.promote(explorerBaton?.receipt.id ?? '')
		await value.wake(accepted.workflow.id)

		const delegated = await value.delegate({
			clientId: 'delegate-implementation',
			workflowId: accepted.workflow.id,
			sessionId: 'root-1',
			phaseCapability: capability(explorerBaton?.text ?? ''),
			role: 'implementation',
			task: 'Implement the reviewed coordinator boundary.'
		})
		expect(delegated.workflow.phase).toBe('implementing')
		await value.wake(accepted.workflow.id)
		const implementer = db.getWorkflowJob(delegated.job.id)
		if (!implementer?.childSessionId) throw new Error('implementation child did not open')
		fake.outcomes.set(implementer.childSessionId, { kind: 'success', baton: 'Implementation verified.' })
		await value.wake(accepted.workflow.id)
		const implementationBaton = fake.sent.filter(item => item.kind === 'baton').at(-1)
		fake.promote(implementationBaton?.receipt.id ?? '')
		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('reviewing')
		expect((await value.wake(accepted.workflow.id)).phase).toBe('reviewing')
		const completed = await value.complete({ clientId: 'complete', workflowId: accepted.workflow.id })
		expect(completed.workflow.phase).toBe('completed')
		db.close()
	})

	test('serializes extra explorers but holds the phase-granting Baton for delivered siblings', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startExisting(value)
		await value.wake(accepted.workflow.id)
		const rootPrompt = fake.sent[0]
		fake.promote(rootPrompt.receipt.id)
		await value.wake(accepted.workflow.id)

		const delegated = await value.delegate({
			clientId: 'extra-explorer',
			workflowId: accepted.workflow.id,
			sessionId: 'root-1',
			phaseCapability: capability(rootPrompt.text),
			role: 'exploration',
			task: 'Independently inspect crash recovery.'
		})
		expect(delegated.job.prompt).toContain(
			workflowEffectCorrelationMarker(accepted.workflow.id, `job:${delegated.job.id}`)
		)
		await value.wake(accepted.workflow.id)
		expect(fake.opened).toHaveLength(2)

		for (const job of db.listWorkflowJobs(accepted.workflow.id)) {
			if (job.childSessionId)
				fake.outcomes.set(job.childSessionId, { kind: 'success', baton: `Baton ${job.logicalKey}` })
		}
		await value.wake(accepted.workflow.id)
		let batons = fake.sent.filter(item => item.kind === 'baton')
		expect(batons).toHaveLength(1)
		expect(() => capability(batons[0].text)).toThrow()

		fake.promote(batons[0].receipt.id)
		await value.wake(accepted.workflow.id)
		batons = fake.sent.filter(item => item.kind === 'baton')
		expect(batons).toHaveLength(2)
		expect(capability(batons[1].text)).toMatch(/^crwf_v1_/)
		expect(value.projection(accepted.workflow.id).phase).toBe('exploring')

		fake.promote(batons[1].receipt.id)
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id).phase).toBe('planning')
		db.close()
	})

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
