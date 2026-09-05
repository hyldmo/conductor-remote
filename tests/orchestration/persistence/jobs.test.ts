import { describe, expect, test } from 'vitest'
import { OrchestrationDb, WorkflowTransitionError } from '../../../src/orchestration/persistence/db.ts'
import { databaseFile, relay, startExisting } from './fixtures.ts'

describe('OrchestrationDb transitions, jobs, and effects', () => {
	test('rolls a materialized transition back when its audit event cannot commit', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		expect(() =>
			db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'pending_root',
				expectedCancellationGeneration: 0,
				phase: 'exploring',
				eventKey: 'workflow_started',
				eventType: 'root_delivered'
			})
		).toThrow()
		expect(db.getWorkflowRun(run.id)?.phase).toBe('pending_root')
		expect(db.listWorkflowEvents(run.id).map(event => event.type)).toEqual(['workflow_started'])
		db.close()
	})

	test('claims a queued logical job once across database connections', () => {
		const file = databaseFile()
		const db1 = new OrchestrationDb(file)
		const run = startExisting(db1).run
		const bootstrap = db1.listWorkflowJobs(run.id)[0]
		db1.activateWorkflowJob(bootstrap.id, 0, 'activate-bootstrap')
		const db2 = new OrchestrationDb(file)
		const owner1 = relay('relay-a', 101)
		const owner2 = relay('relay-b', 102)

		expect(db1.claimNextWorkflowJob(owner1)?.owner).toEqual(owner1)
		expect(db2.claimNextWorkflowJob(owner2)).toBeUndefined()
		expect(() => db1.createWorkflowJobAttempt({ jobId: bootstrap.id, owner: owner2 })).toThrow(WorkflowTransitionError)
		const attempt = db1.createWorkflowJobAttempt({ jobId: bootstrap.id, owner: owner1 })
		expect(attempt).toMatchObject({ attemptNumber: 1, owner: owner1 })
		expect(db2.getWorkflowJob(bootstrap.id)?.attemptCount).toBe(1)
		db1.close()
		db2.close()
	})

	test('can reclaim repeated pre-attempt job claims without reusing audit keys', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-for-reclaim')

		for (const [index, owner] of [relay('dead-a', 111), relay('dead-b', 112)].entries()) {
			expect(db.claimNextWorkflowJob(owner, run.id)?.owner).toEqual(owner)
			expect(
				db.reconcileAbandonedWorkflowJobClaim({
					jobId: bootstrap.id,
					eventKey: `recover-before-attempt:${bootstrap.id}`
				})
			).toMatchObject({ status: 'requeued', job: { state: 'queued', attemptCount: 0 } })
			expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_job_claim_recovered')).toHaveLength(
				index + 1
			)
		}
		const live = relay('live-c', 113)
		expect(db.claimNextWorkflowJob(live, run.id)?.owner).toEqual(live)
		expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_job_claimed')).toHaveLength(3)
		db.close()
	})

	test('persists the delivered root transcript cursor while activating the bootstrap job', () => {
		const file = databaseFile()
		const db = new OrchestrationDb(file)
		const run = startExisting(db).run
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		const transcriptCursor = { rowid: 44, turnId: 'root-turn', outboxIds: ['accepted-root'] }

		expect(db.activateWorkflowJob(bootstrap.id, 0, 'activate-with-root-cursor', transcriptCursor)).toMatchObject({
			state: 'queued',
			transcriptCursor
		})
		db.close()

		const reopened = new OrchestrationDb(file)
		expect(reopened.getWorkflowJob(bootstrap.id)).toMatchObject({ state: 'queued', transcriptCursor })
		reopened.close()
	})
})
