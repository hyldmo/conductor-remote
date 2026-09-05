import { describe, expect, test } from 'vitest'
import { hashCapabilityToken } from '../../../src/orchestration/persistence/db.ts'
import { workflowEffectCorrelationMarker } from '../../../src/orchestration/workflow/coordinator.ts'
import { scrubWorkflowSecrets } from '../../../src/shared.ts'
import { capability, coordinator, databaseFile, modelGroups, roles, startExisting } from './fixtures.ts'

describe('WorkflowCoordinator durable barriers', () => {
	test('starts independent roots in two untouched tabs of the same workspace', async () => {
		const { db, fake, value } = coordinator()
		const first = await startExisting(value)
		const second = await value.start({
			clientId: 'second-tab',
			objective: 'A separate task in the same worktree.',
			target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-2' },
			roles,
			modelGroups
		})

		expect(second.workflow.id).not.toBe(first.workflow.id)
		expect(value.projections().map(run => [run.workspaceId, run.rootSessionId])).toEqual(
			expect.arrayContaining([
				['workspace-1', 'root-1'],
				['workspace-1', 'root-2']
			])
		)
		for (const workflow of [first.workflow, second.workflow]) {
			expect(db.listWorkflowJobs(workflow.id)).toHaveLength(1)
			expect(db.getWorkflowEffect(workflow.id, 'send-root')?.target).toEqual({
				workspaceId: 'workspace-1',
				sessionId: workflow.rootSessionId
			})
		}
		expect(fake.sent).toEqual([])
		expect(fake.configured).toEqual([])
		db.close()
	})

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

	test('completes work handled by the root after delivered exploration, including after restart', async () => {
		const file = databaseFile()
		const { db, fake, value } = coordinator(file)
		const accepted = await startExisting(value)
		const finish = { clientId: 'complete-root-work', workflowId: accepted.workflow.id }
		expect(value.projection(accepted.workflow.id).actions.canComplete).toBe(false)
		await expect(value.complete(finish)).rejects.toMatchObject({ code: 'workflow_recovery_invalid' })
		await value.wake(accepted.workflow.id)
		fake.promote(fake.sent[0].receipt.id)
		await value.wake(accepted.workflow.id)
		const explorer = db.listWorkflowJobs(accepted.workflow.id)[0]
		await expect(value.complete(finish)).rejects.toMatchObject({ code: 'workflow_recovery_invalid' })
		fake.outcomes.set(explorer.childSessionId ?? '', { kind: 'success', baton: 'The root can finish this small fix.' })
		await value.wake(accepted.workflow.id)
		const baton = fake.sent.find(item => item.kind === 'baton')!
		expect(value.projection(accepted.workflow.id).actions.canComplete).toBe(false)
		await expect(value.complete(finish)).rejects.toMatchObject({ code: 'workflow_recovery_invalid' })
		fake.promote(baton.receipt.id)
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id)).toMatchObject({
			phase: 'planning',
			actions: { canComplete: true },
			jobs: { implementation: { requested: 0 } }
		})
		expect(fake.opened).toHaveLength(1)
		db.close()

		const restarted = coordinator(file)
		expect(restarted.value.projection(accepted.workflow.id).actions.canComplete).toBe(true)
		const completed = await restarted.value.complete(finish)
		expect(completed.workflow).toMatchObject({ phase: 'completed', actions: { canComplete: false } })
		expect((await restarted.value.complete(finish)).replayed).toBe(true)
		expect(restarted.db.getWorkflowCapability(hashCapabilityToken(capability(baton.text)))?.revokedAt).toBeDefined()
		restarted.db.close()
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
		expect(delegated.workflow.actions.canComplete).toBe(false)
		await expect(value.complete({ clientId: 'too-early', workflowId: accepted.workflow.id })).rejects.toMatchObject({
			code: 'workflow_recovery_invalid'
		})
		await value.wake(accepted.workflow.id)
		const implementer = db.getWorkflowJob(delegated.job.id)
		if (!implementer?.childSessionId) throw new Error('implementation child did not open')
		fake.outcomes.set(implementer.childSessionId, { kind: 'success', baton: 'Implementation verified.' })
		await value.wake(accepted.workflow.id)
		const implementationBaton = fake.sent.filter(item => item.kind === 'baton').at(-1)
		expect(value.projection(accepted.workflow.id).actions.canComplete).toBe(false)
		fake.promote(implementationBaton?.receipt.id ?? '')
		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('reviewing')
		expect(value.projection(accepted.workflow.id).actions.canComplete).toBe(true)
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
})
