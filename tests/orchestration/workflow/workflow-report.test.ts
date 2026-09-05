import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createWorkflowProbesServices } from '../../../src/http/services/workflow-probes.ts'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import { workflowReportBody } from '../../../src/orchestration/workflow/report.ts'
import { attachmentTokens, scrubWorkflowSecrets, workflowPrivateEnvelope } from '../../../src/shared.ts'
import { chatCursor } from '../../../src/transcript/cursor.ts'
import { coordinator, databaseFile, relay, startExisting } from './fixtures.ts'

describe('Workflow report returns', () => {
	test('freezes complete, scrubbed reports and keeps return bytes stable after retry and restart', async () => {
		const file = databaseFile()
		const { db, fake } = coordinator(file)
		const { stableWorkflowAttachment } = createWorkflowProbesServices(
			{} as Parameters<typeof createWorkflowProbesServices>[0]
		)
		const defaults = fake.deps()
		const materializeReport = vi.fn(async ({ run, job, outcome }: Parameters<typeof defaults.materializeReport>[0]) =>
			stableWorkflowAttachment(
				dirname(file),
				`${job.id}:report:${job.attemptCount}`,
				'Workflow report.md',
				workflowReportBody(run, job, outcome)
			)
		)
		const attempts: string[] = []
		let fail = true
		const deps = {
			...defaults,
			materializeReport,
			returnBaton: async (call: Parameters<typeof defaults.returnBaton>[0]) => {
				attempts.push(scrubWorkflowSecrets(call.text))
				if (fail) throw new Error('UI unavailable before dispatch')
				return defaults.returnBaton(call)
			}
		}
		const value = new WorkflowCoordinator(db, relay, deps)
		const { workflow } = await startExisting(value)
		await value.wake(workflow.id)
		fake.promote(fake.sent[0].receipt.id)
		await value.wake(workflow.id)
		const job = db.listWorkflowJobs(workflow.id)[0]
		const baton = '## Baton\n### Decision\nKeep the receipt guard.'
		const secret = workflowPrivateEnvelope({
			workflowId: 'private-run',
			phaseCapability: 'crwf_v1_secret',
			cycle: 1,
			revision: 1,
			allowedRoles: ['exploration']
		})
		const text = `The full evidence comes before the Baton.\n\n${secret}\n\n${baton}\n`
		fake.outcomes.set(job.childSessionId!, { kind: 'success', text, baton, assistantRowid: 123 })
		await value.wake(workflow.id)
		expect(value.projection(workflow.id).phase).toBe('blocked')
		const frozen = db.getWorkflowJob(job.id)!.outcome
		expect(JSON.stringify(frozen)).not.toContain('crwf_v1_secret')
		expect(materializeReport).toHaveBeenCalledTimes(1)
		const attachment = attachmentTokens(attempts[0])[0]
		const report = readFileSync(join(dirname(file), attachment.path), 'utf8')
		expect(report).toContain('The full evidence comes before the Baton.')
		expect(report).toContain(baton)
		expect(report).not.toContain('crwf_v1_secret')
		expect(attempts[0]).toContain(baton)
		expect(attempts[0]).toContain(`Report: ${attempts[0].slice(attachment.start, attachment.end)}`)
		expect(attempts[0]).toContain(
			`read_chat(${JSON.stringify({ session_id: job.childSessionId, near: chatCursor(123), before: 6, after: 0 })})`
		)
		fake.outcomes.set(job.childSessionId!, { kind: 'success', baton: 'A later answer.', text: 'A later answer.' })
		db.close()
		const reopened = new OrchestrationDb(file)
		const resumed = new WorkflowCoordinator(reopened, relay, deps)
		await resumed.retry({ clientId: 'retry-report', workflowId: workflow.id })
		fail = false
		await resumed.wake(workflow.id)
		expect(attempts[1]).toBe(attempts[0])
		expect(materializeReport).toHaveBeenCalledTimes(1)
		expect(readFileSync(join(dirname(file), attachment.path), 'utf8')).toBe(report)
		expect(resumed.projection(workflow.id).phase).toBe('exploring')
		const returned = fake.sent.find(item => item.kind === 'baton')!
		fake.promote(returned.receipt.id)
		await resumed.wake(workflow.id)
		expect(resumed.projection(workflow.id).phase).toBe('planning')
		reopened.close()
	})
})
