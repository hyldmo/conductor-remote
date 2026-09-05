import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { createTools } from '../../../src/mcp/registry.ts'
import type { CallOptions, RelayCall } from '../../../src/mcp/types.ts'
import {
	prepareWorkflowRun,
	workflowBootstrapPrompt,
	workflowChildPrompt,
	workflowRootPrompt
} from '../../../src/orchestration/workflow/prompts.ts'
import { routes } from '../../../src/routes.ts'
import { workflowCapabilityToken } from '../../../src/shared.ts'
import type { CreateWorkspaceResult } from '../../../src/wire.ts'
import { WorkflowModePill } from '../../../web/src/components/orchestration/WorkflowModePill.tsx'

const groups = [
	{
		agentType: 'claude',
		models: ['Fable 5.1', 'Sonnet 4.6', '5.6 Sol', 'opencode-go/muse-spark-1.3-contributor'],
		updatedAt: 1
	}
]

const roles = {
	version: 1 as const,
	roles: {
		planning: {
			model: 'Fable 5.1',
			effort: 'max' as const,
			fast: false,
			preamble: 'Prefer the smallest complete plan.'
		},
		exploration: { model: 'opencode-go/muse-spark-1.3-contributor' },
		implementation: { model: '5.6 Sol', effort: 'high' as const, fast: false }
	}
}

describe('new-workspace Workflow mode', () => {
	test('freezes all three roles before building the managed root prompt', () => {
		const result = prepareWorkflowRun(roles, groups, 'Build the import flow.')

		expect(result).toMatchObject({
			ok: true,
			prepared: {
				roles: {
					planning: { model: 'Fable 5.1', agentType: 'claude', effort: 'max', fast: false },
					exploration: { agentType: 'acp' },
					implementation: { agentType: 'codex' }
				},
				rootAgent: { model: 'Fable 5.1', effort: 'max', fast: false }
			}
		})
		if (!result.ok) throw new Error('workflow should resolve')
		expect(Object.hasOwn(result.prepared.rootAgent, 'plan')).toBe(false)
		expect(Object.isFrozen(result.prepared.roles)).toBe(true)
		const prompt = workflowRootPrompt({
			workflowId: 'workflow-1',
			objective: result.prepared.objective,
			roles: result.prepared.roles,
			phaseCapability: workflowCapabilityToken('A'.repeat(43)),
			cycle: 1,
			revision: 0
		})
		expect(prompt).toContain('Build the import flow.')
		expect(prompt).toContain('Prefer the smallest complete plan.')
		expect(prompt).toContain('already scheduled one tracked explorer')
		expect(prompt).toContain('delegate_task')
		expect(prompt).toContain('Do not edit files')
		expect(prompt).toContain('## Frozen roles for this Workflow')
		expect(prompt).toContain('- planning — Fable 5.1: this root chat; plan and integrate delegated work')
		expect(prompt).toContain(
			'- exploration — opencode-go/muse-spark-1.3-contributor: read-only investigation and evidence'
		)
		expect(prompt).toContain('- implementation — 5.6 Sol: code changes and verification')
		expect(prompt).toContain('This catalog is authoritative for this run')
		expect(prompt).not.toContain('list_roles')
		expect(prompt).not.toContain('effort')
		expect(prompt).not.toContain('fast')
		expect(prompt).not.toContain('Plan mode')
	})

	test('refuses an empty objective or an invalid role before creating anything', () => {
		expect(
			prepareWorkflowRun(
				{ ...roles, roles: { ...roles.roles, planning: { model: 'Missing model' } } },
				groups,
				'Do work.'
			)
		).toMatchObject({
			ok: false,
			error: { code: 'model_missing' }
		})
		expect(prepareWorkflowRun(roles, groups, '   ')).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' }
		})
	})

	test('rejects unreadable roles and child roles on the planning provider', () => {
		expect(prepareWorkflowRun({ config: roles, warning: 'invalid JSON' }, groups, 'Build it.')).toMatchObject({
			ok: false,
			error: { code: 'invalid_request', message: expect.stringContaining('role editor') }
		})
		expect(
			prepareWorkflowRun(
				{ ...roles, roles: { ...roles.roles, exploration: { model: 'Sonnet 4.6' } } },
				groups,
				'Build it.'
			)
		).toMatchObject({ ok: false, error: { code: 'same_provider' } })
	})

	test('keeps the immutable objective separate in bootstrap and implementation prompts', () => {
		const result = prepareWorkflowRun(roles, groups, 'Keep this exact objective.')
		if (!result.ok) throw new Error('workflow should resolve')
		const bootstrap = workflowBootstrapPrompt({
			objective: result.prepared.objective,
			role: result.prepared.roles.exploration,
			handoffAttachment: '@⟦Transcript.md⟧(.context/attachments/ABC123/Transcript.md)'
		})
		const implementation = workflowChildPrompt({
			roleName: 'implementation',
			objective: result.prepared.objective,
			role: result.prepared.roles.implementation,
			task: 'Implement the validated parser change.'
		})

		expect(bootstrap).toContain('Do not edit files')
		expect(bootstrap).toContain('Keep this exact objective.')
		expect(bootstrap).toContain('## Baton')
		expect(implementation).toContain('Implement the validated parser change.')
		expect(implementation).toContain('## Original Workflow objective (immutable)')
	})

	test('renders Workflow as an explicit reversible mode pill', () => {
		const active = renderToStaticMarkup(<WorkflowModePill active onChange={vi.fn()} />)
		const inactive = renderToStaticMarkup(<WorkflowModePill active={false} onChange={vi.fn()} />)

		expect(active).toContain('Workflow')
		expect(active).toContain('Beta')
		expect(active).toContain('aria-pressed="true"')
		expect(inactive).toContain('aria-pressed="false"')
	})

	test('keeps Workflow start out of the create_workspace MCP utility', async () => {
		const seen: { route?: string; body?: unknown } = {}
		const call: RelayCall = async <T,>(route: string, options?: CallOptions) => {
			seen.route = route
			seen.body = options?.body
			return { ok: true, workspaceId: 'workspace-1' } satisfies CreateWorkspaceResult as T
		}
		const tools = createTools(call)
		const create = tools.find(tool => tool.name === 'create_workspace')
		if (!create) throw new Error('create_workspace does not exist')

		const properties = create.inputSchema.properties as Record<string, unknown>
		expect(properties).not.toHaveProperty('workflow')
		expect(tools.map(tool => tool.name)).not.toContain('start_workflow')
		const output = await create.run({ repo: 'conductor-remote', prompt: 'Build it.' })

		expect(seen).toEqual({
			route: routes.createWorkspace.path(),
			body: {
				repo: 'conductor-remote',
				prompt: 'Build it.',
				model: undefined,
				effort: undefined,
				plan: undefined,
				fast: undefined,
				send: false,
				sendImmediately: true
			}
		})
		expect(output).toContain('workspace_id: workspace-1')
		await expect(create.run({ repo: 'conductor-remote', prompt: 'Build it.', workflow: true })).rejects.toThrow(
			'unknown field: workflow'
		)
	})

	test('keeps Workflow start out of send_prompt too', async () => {
		let called = false
		const send = createTools(async <T,>() => {
			called = true
			return {} as T
		}).find(tool => tool.name === 'send_prompt')
		if (!send) throw new Error('send_prompt does not exist')

		const properties = send.inputSchema.properties as Record<string, unknown>
		expect(properties).not.toHaveProperty('workflow')
		await expect(send.run({ session_id: 'session-1', text: 'Build it.', workflow: true })).rejects.toThrow(
			'unknown field: workflow'
		)
		expect(called).toBe(false)
	})
})
