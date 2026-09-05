import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
	hashCapabilityToken,
	OrchestrationDb,
	WorkflowTransitionError
} from '../../../src/orchestration/persistence/db.ts'
import { workflowCapabilityToken, workflowPrivateEnvelope } from '../../../src/shared.ts'
import { databaseFile, roles, startExisting } from './fixtures.ts'

describe('OrchestrationDb capabilities and public projection', () => {
	test('stores only capability hashes and consumes a capability once at exact coordinates', () => {
		const file = databaseFile()
		const db = new OrchestrationDb(file)
		const run = startExisting(db).run
		const token = `wfcap_${'secret-value-'.repeat(5)}`
		const tokenHash = hashCapabilityToken(token)
		const capabilityId = db.issueWorkflowCapability({
			tokenHash,
			runId: run.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			issuedWith: { rowid: 44, turnId: 'turn-1' },
			eventKey: 'capability-initial'
		})

		expect(readFileSync(file).includes(Buffer.from(token))).toBe(false)
		expect(
			db.consumeWorkflowCapability({
				tokenHash,
				runId: run.id,
				rootSessionId: 'root-1',
				role: 'exploration',
				expectedPhase: 'pending_root',
				expectedCycle: 0,
				expectedRevision: 0,
				eventKey: 'consume-initial'
			})
		).toBe(capabilityId)
		expect(() =>
			db.consumeWorkflowCapability({
				tokenHash,
				runId: run.id,
				rootSessionId: 'root-1',
				role: 'exploration',
				expectedPhase: 'pending_root',
				expectedCycle: 0,
				expectedRevision: 0,
				eventKey: 'consume-again'
			})
		).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('composes capability consumption, transition, and job creation in one idempotent transaction', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const tokenHash = hashCapabilityToken(`wfcap_${'a'.repeat(32)}`)
		db.issueWorkflowCapability({
			tokenHash,
			runId: run.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			eventKey: 'issue-compose-capability'
		})
		const mutate = () =>
			db.idempotentMutation('delegate', 'delegate-client', { role: 'exploration', prompt: 'Investigate.' }, () => {
				db.consumeWorkflowCapability({
					tokenHash,
					runId: run.id,
					rootSessionId: 'root-1',
					role: 'exploration',
					expectedPhase: 'pending_root',
					expectedCycle: 0,
					expectedRevision: 0,
					eventKey: 'consume-compose-capability'
				})
				db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: 'pending_root',
					expectedCancellationGeneration: 0,
					phase: 'exploring',
					revision: 1,
					eventKey: 'compose-transition',
					eventType: 'exploration_requested'
				})
				const job = db.createWorkflowJob({
					runId: run.id,
					logicalKey: 'explore:1',
					role: 'exploration',
					resolvedRole: roles.exploration,
					prompt: 'Investigate.',
					expectedCancellationGeneration: 0,
					eventKey: 'compose-job'
				}).job
				return { runId: run.id, jobId: job.id }
			})

		const first = mutate()
		const repeated = mutate()
		expect(first.replayed).toBe(false)
		expect(repeated).toEqual({ replayed: true, result: first.result })
		expect(db.getWorkflowRun(run.id)).toMatchObject({ phase: 'exploring', revision: 1 })
		expect(db.listWorkflowJobs(run.id).filter(job => job.logicalKey === 'explore:1')).toHaveLength(1)
		expect(db.getWorkflowCapability(tokenHash)?.consumedAt).toBeTypeOf('number')
		db.close()
	})

	test('projects bounded, scrubbed public data without private roles or execution evidence', () => {
		const db = new OrchestrationDb(databaseFile())
		const capability = workflowCapabilityToken('x'.repeat(43))
		const envelope = workflowPrivateEnvelope({
			workflowId: 'private-workflow',
			phaseCapability: capability,
			cycle: 1,
			revision: 0,
			allowedRoles: ['exploration']
		})
		const run = startExisting(db, {
			objective: `Visible objective ${envelope} tail ${capability}`
		}).run
		const candidates = Array.from({ length: 25 }, (_, index) => ({
			id: `candidate-${index}`,
			title: index === 0 ? `Possible ${capability}` : `Possible ${index}`,
			repo: 'conductor-remote',
			createdAt: 1_000 + index,
			kind: 'workspace' as const
		}))
		db.transitionWorkflowRun({
			runId: run.id,
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'create-workspace',
				errorCode: 'ambiguous_effect',
				message: `Could have landed ${capability} [window server: 6; screen: locked] [processes: conductor=0]`,
				resumePhase: 'creating_workspace',
				retryClass: 'ambiguous',
				candidates
			},
			eventKey: 'blocked-create',
			eventType: 'workflow_blocked'
		})

		const projection = db.getWorkflowProjection(run.id)
		expect(projection).toMatchObject({
			phase: 'blocked',
			jobs: { exploration: { requested: 1 }, implementation: { requested: 0 } },
			actions: { canRetry: false, canAdopt: true, canReplayAmbiguous: true, canCancel: true },
			adoption: { actionId: 'create-workspace', kind: 'workspace' }
		})
		expect(projection?.adoption?.candidates).toHaveLength(20)
		const rendered = JSON.stringify(projection)
		expect(rendered).not.toContain(capability)
		expect(rendered).not.toContain('phase_capability')
		expect(rendered).not.toContain('PRIVATE PLANNING PREAMBLE')
		expect(rendered).not.toContain('deliveryBaseline')
		expect(rendered).not.toContain('cancellationGeneration')
		expect(rendered).not.toContain('window server')
		expect(projection?.error?.message).toBe('Could have landed [Workflow capability hidden]')
		db.close()
	})

	test('keeps an ambiguous action id public when reconciliation found no adoption candidate', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		db.transitionWorkflowRun({
			runId: run.id,
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'send-root',
				errorCode: 'ambiguous_effect',
				message: 'The root send may have landed.',
				resumePhase: 'pending_root',
				retryClass: 'ambiguous',
				candidates: []
			},
			eventKey: 'blocked-send',
			eventType: 'workflow_blocked'
		})

		expect(db.getWorkflowProjection(run.id)).toMatchObject({
			actions: { canAdopt: false, canReplayAmbiguous: true },
			adoption: { actionId: 'send-root', kind: 'session', candidates: [] }
		})
		db.close()
	})
})

describe('OrchestrationDb bounded retention', () => {
	test('compacts only old terminal detail and retains its stable idempotency mapping plus summary', () => {
		let clock = 1_000
		const file = databaseFile()
		const db = new OrchestrationDb(file, { now: () => clock++ })
		const terminal = startExisting(db).run
		const capabilityHash = hashCapabilityToken(`wfcap_${'c'.repeat(32)}`)
		db.issueWorkflowCapability({
			tokenHash: capabilityHash,
			runId: terminal.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			eventKey: 'cap-before-compaction'
		})
		db.transitionWorkflowRun({
			runId: terminal.id,
			expectedCancellationGeneration: 0,
			phase: 'completed',
			eventKey: 'complete-before-compaction',
			eventType: 'workflow_completed'
		})
		const active = startExisting(db, {
			clientId: 'active-client',
			target: { kind: 'existing_session', workspaceId: 'workspace-2', sessionId: 'root-2' }
		}).run

		expect(db.compactTerminalRuns({ olderThan: 10_000, limit: 1 })).toBe(1)
		expect(db.listWorkflowJobs(terminal.id)).toEqual([])
		expect(db.listWorkflowEffects(terminal.id)).toEqual([])
		expect(db.listWorkflowEvents(terminal.id)).toMatchObject([
			{
				eventKey: 'terminal_compacted',
				type: 'terminal_compacted',
				data: {
					jobs: { exploration: { cancelled: 0, failed: 0, returned: 0 } },
					effects: { prepared: 1 }
				}
			}
		])
		expect(db.getWorkflowRun(active.id)?.phase).toBe('pending_root')
		expect(db.listWorkflowJobs(active.id)).toHaveLength(1)
		expect(
			db.getIdempotentMutation<{ runId: string }>('start_workflow', 'start-client', {
				objective: 'Build a deterministic pipeline',
				target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' }
			})?.result.runId
		).toBe(terminal.id)
		expect(db.compactTerminalRuns({ olderThan: 10_000, limit: 1 })).toBe(0)

		const raw = new DatabaseSync(file, { readOnly: true })
		expect(
			(
				raw.prepare('SELECT COUNT(*) count FROM workflow_capabilities WHERE run_id = ?').get(terminal.id) as {
					count: number
				}
			).count
		).toBe(0)
		expect(
			(
				raw.prepare('SELECT COUNT(*) count FROM workflow_idempotency WHERE run_id = ?').get(terminal.id) as {
					count: number
				}
			).count
		).toBe(1)
		raw.close()
		db.close()
	})
})
