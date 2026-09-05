import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
	ORCHESTRATION_PROTOCOL_VERSION,
	OrchestrationDb,
	type RelayIdentity
} from '../../../src/orchestration/persistence/db.ts'
import {
	type WorkflowChildOutcome,
	WorkflowCoordinator,
	type WorkflowCoordinatorDeps,
	WorkflowCoordinatorError
} from '../../../src/orchestration/workflow/coordinator.ts'
import type { DeliveryReceipt } from '../../../src/reads/types.ts'
import type { CachedModelGroup, RolesConfig } from '../../../src/wire.ts'
import { uiTurn } from '../../../src/writes/ui-lock.ts'

export const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

export function databaseFile(): string {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-workflow-coordinator-'))
	directories.push(directory)
	return join(directory, 'orchestration.db')
}

export const relay: RelayIdentity = {
	instanceId: 'relay-test',
	pid: process.pid,
	processStartedAt: 'test-process-start',
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
}

export const otherRelay: RelayIdentity = {
	instanceId: 'relay-other',
	pid: process.pid + 10_000,
	processStartedAt: 'other-process-start',
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
}

export const roles: RolesConfig = {
	version: 1,
	roles: {
		planning: { model: '5.6 Sol', effort: 'high', preamble: 'Plan without editing.' },
		exploration: { model: 'Claude Sonnet 4.6', effort: 'medium', preamble: 'Investigate only.' },
		implementation: { model: 'Claude Opus 4.6', effort: 'high', preamble: 'Implement carefully.' }
	}
}

export const modelGroups: CachedModelGroup[] = [
	{
		agentType: 'codex',
		models: ['5.6 Sol', 'Claude Sonnet 4.6', 'Claude Opus 4.6'],
		updatedAt: 100
	}
]

export const capability = (text: string): string => {
	const match = text.match(/\bcrwf_v\d+_[A-Za-z0-9_-]+\b/)
	if (!match) throw new Error(`message did not contain a Workflow capability: ${text}`)
	return match[0]
}

export class FakeEffects {
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
			materializeReport: async ({ job }) => `report-for-${job.id}-${job.attemptCount}`,
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

export function coordinator(file = databaseFile()) {
	const db = new OrchestrationDb(file, { processProbe: identity => identity.pid === process.pid })
	const fake = new FakeEffects()
	const value = new WorkflowCoordinator(db, relay, fake.deps())
	return { db, fake, value }
}

export async function startExisting(value: WorkflowCoordinator, clientId: string = randomUUID()) {
	return value.start({
		clientId,
		objective: 'Build a deterministic Workflow coordinator',
		target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
		roles,
		modelGroups
	})
}
