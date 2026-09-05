import { describe, expect, test } from 'vitest'
import { applyAgentConfig } from '../../../src/agents/agent-config.ts'
import { sessionMatchesWorkflowRole } from '../../../src/http/services/workflow-probes.ts'
import { WorkflowCoordinator } from '../../../src/orchestration/workflow/coordinator.ts'
import type { FrozenWorkflowRole } from '../../../src/orchestration/workflow/prompts.ts'
import type { SessionRow } from '../../../src/reads/types.ts'
import { coordinator, modelGroups, relay, roles } from './fixtures.ts'

const explorer: SessionRow = {
	id: 'explorer',
	status: 'idle',
	title: 'Untitled',
	model: 'opencode:opencode-go/muse-spark-1.3-contributor',
	agent_type: 'acp',
	claude_effort_level: 'high',
	fast_mode: 0,
	permission_mode: 'default',
	context_used_percent: null,
	unread_count: 0,
	created_at: '2026-09-05 14:24:00',
	updated_at: '2026-09-05 14:24:28',
	last_user_message_at: null,
	prompt_cache_ttl_ms: null,
	turn_started_at: null,
	background_tasks: []
}

const role: FrozenWorkflowRole = {
	agentType: 'acp',
	model: 'opencode-go/muse-spark-1.3-contributor'
}

const startWorkflow = (value: WorkflowCoordinator) =>
	value.start({
		clientId: 'opencode-workflow',
		objective: 'Review workflow orchestration.',
		target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
		roles: { ...roles, roles: { ...roles.roles, exploration: role } },
		modelGroups: [...modelGroups, { agentType: 'acp', models: [role.model], updatedAt: 100 }]
	})

function withRecordedExplorer(db: ReturnType<typeof coordinator>['db'], fake: ReturnType<typeof coordinator>['fake']) {
	const deps = fake.deps()
	return new WorkflowCoordinator(db, relay, {
		...deps,
		reconcileEffect: async call => {
			if (call.effect.kind === 'configure_child') {
				const job = call.job ?? db.listWorkflowJobs(call.run.id).find(job => job.id === call.effect.jobId)
				if (job && sessionMatchesWorkflowRole(explorer, job.resolvedRole)) {
					return { status: 'committed', receipt: { sessionId: job.childSessionId, matched: true } }
				}
			}
			return deps.reconcileEffect!(call)
		}
	})
}

describe('Workflow frozen role receipts', () => {
	test('accepts the same provider-qualified model that agent configuration already confirmed', async () => {
		const configured = await applyAgentConfig(role, {
			read: () => ({
				agentType: explorer.agent_type,
				model: explorer.model,
				effort: explorer.claude_effort_level,
				plan: false,
				fast: false
			}),
			write: async () => {
				throw new Error('Already configured; no UI write should be needed')
			},
			wait: async () => undefined
		})
		expect(configured).toEqual({ ok: true })
		expect(sessionMatchesWorkflowRole(explorer, role)).toBe(true)
	})

	test.each([
		['another provider', { agent_type: 'codex' }],
		['another OpenCode namespace', { model: 'opencode:opencode/muse-spark-1.3-contributor' }],
		['another model', { model: 'opencode:opencode-go/grok-4.6' }]
	])('rejects %s instead of silently changing a frozen role', (_name, fields) => {
		expect(sessionMatchesWorkflowRole({ ...explorer, ...fields }, role)).toBe(false)
	})

	test('checks the complete frozen model instead of accepting a picker prefix', () => {
		expect(
			sessionMatchesWorkflowRole(
				{ ...explorer, agent_type: 'codex', model: 'gpt-5.6-terra' },
				{ agentType: 'codex', model: '5.6 T' }
			)
		).toBe(false)
	})

	test('still checks provider-owned effort and Fast settings', () => {
		const session = { ...explorer, agent_type: 'codex', model: 'gpt-5.6-astra', claude_effort_level: 'max' }
		const frozen: FrozenWorkflowRole = { agentType: 'codex', model: '5.6 Astra', effort: 'max', fast: false }
		expect(sessionMatchesWorkflowRole(session, frozen)).toBe(true)
		expect(sessionMatchesWorkflowRole({ ...session, claude_effort_level: 'high' }, frozen)).toBe(false)
		expect(sessionMatchesWorkflowRole({ ...session, fast_mode: 1 }, frozen)).toBe(false)
	})

	test('starts an already configured OpenCode explorer without a UI settings write or a global pause', async () => {
		const { db, fake } = coordinator()
		const value = withRecordedExplorer(db, fake)
		const accepted = await startWorkflow(value)
		await value.wake(accepted.workflow.id)
		fake.promote(fake.sent[0].receipt.id)

		await value.wake(accepted.workflow.id)

		expect(value.projection(accepted.workflow.id).phase).toBe('exploring')
		expect(
			db.listWorkflowEffects(accepted.workflow.id).find(effect => effect.kind === 'configure_child')
		).toMatchObject({
			state: 'committed',
			mayExecute: false,
			attemptCount: 0
		})
		expect(fake.configured).toEqual(['root-1'])
		expect(fake.opened).toHaveLength(1)
		expect(fake.sent).toHaveLength(2)
		expect(db.getUiQuarantine().active).toBe(false)
		db.close()
	})

	test('clears an existing false settings alarm from a positive read without replaying the child', async () => {
		const { db, fake, value } = coordinator()
		const accepted = await startWorkflow(value)
		await value.wake(accepted.workflow.id)
		fake.promote(fake.sent[0].receipt.id)
		fake.failConfigureAfterDispatch = true
		await value.wake(accepted.workflow.id)
		expect(value.projection(accepted.workflow.id).phase).toBe('blocked')
		expect(db.getUiQuarantine().active).toBe(true)
		expect(fake.sent).toHaveLength(1)

		// A restarted relay uses the corrected read-only matcher against the same
		// saved effect. Leaving the write failure armed proves no replay is needed.
		const recovered = withRecordedExplorer(db, fake)
		await recovered.wake(accepted.workflow.id)
		await recovered.wake(accepted.workflow.id)

		expect(recovered.projection(accepted.workflow.id)).toMatchObject({
			phase: 'exploring',
			actions: { canRetry: false, canReplayAmbiguous: false }
		})
		expect(
			db.listWorkflowEffects(accepted.workflow.id).find(effect => effect.kind === 'configure_child')
		).toMatchObject({
			state: 'committed',
			attemptCount: 1
		})
		expect(fake.configured).toEqual(['root-1'])
		expect(fake.opened).toHaveLength(1)
		expect(fake.sent).toHaveLength(2)
		expect(db.getUiQuarantine().active).toBe(false)
		db.close()
	})
})
