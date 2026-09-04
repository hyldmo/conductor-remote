import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { type CallOptions, createTools, type RelayCall } from '../src/mcp-tools.ts'
import { routes } from '../src/routes.ts'
import type { CreateWorkspaceResult } from '../src/wire.ts'
import { prepareWorkflowRoot, WORKFLOW_ROOT_ROLE } from '../src/workflow.ts'
import { WorkflowModePill } from '../web/src/components/WorkflowModePill.tsx'

const groups = [
	{
		agentType: 'claude',
		models: ['Fable 5.1', '5.6 Sol', 'opencode-go/muse-spark-1.3-contributor'],
		updatedAt: 1
	}
]

describe('new-workspace Workflow mode', () => {
	test('turns the configured planning role into an explicitly authorized workflow root', () => {
		const prepared = prepareWorkflowRoot(
			{
				version: 1,
				roles: {
					planning: {
						model: 'Fable 5.1',
						effort: 'max',
						fast: false,
						preamble: 'Prefer the smallest complete plan.'
					}
				}
			},
			groups,
			'Build the import flow.'
		)

		expect(prepared).toMatchObject({
			ok: true,
			role: WORKFLOW_ROOT_ROLE,
			resolvedRole: { model: 'Fable 5.1', agentType: 'claude', effort: 'max', fast: false },
			agent: { model: 'Fable 5.1', effort: 'max', fast: false }
		})
		if (!prepared.ok) throw new Error('workflow should resolve')
		expect(Object.hasOwn(prepared.agent, 'plan')).toBe(false)
		expect(prepared.prompt).toContain('Build the import flow.')
		expect(prepared.prompt).toContain('Prefer the smallest complete plan.')
		expect(prepared.prompt).toContain('explicitly authorized')
		expect(prepared.prompt).toContain('list_roles')
		expect(prepared.prompt).toContain('delegate_task')
		expect(prepared.prompt).toContain('Do not use provider-native Agent, Task, or subagent functionality')
		expect(prepared.prompt).toContain('Never enable or use Conductor Plan mode')
	})

	test('refuses an empty objective or an invalid planning role before creating anything', () => {
		const config = { version: 1 as const, roles: { planning: { model: 'Missing model' } } }
		expect(prepareWorkflowRoot(config, groups, 'Do work.')).toMatchObject({
			ok: false,
			error: { code: 'model_missing' }
		})
		expect(
			prepareWorkflowRoot({ version: 1, roles: { planning: { model: 'Fable 5.1' } } }, groups, '   ')
		).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
	})

	test('renders Workflow as an explicit reversible mode pill', () => {
		const active = renderToStaticMarkup(<WorkflowModePill active onChange={vi.fn()} />)
		const inactive = renderToStaticMarkup(<WorkflowModePill active={false} onChange={vi.fn()} />)

		expect(active).toContain('Workflow')
		expect(active).toContain('Beta')
		expect(active).toContain('aria-pressed="true"')
		expect(inactive).toContain('aria-pressed="false"')
	})

	test('exposes the same mutually exclusive Workflow mode through create_workspace', async () => {
		const seen: { route?: string; body?: unknown } = {}
		const call: RelayCall = async <T,>(route: string, options?: CallOptions) => {
			seen.route = route
			seen.body = options?.body
			return {
				ok: true,
				workspaceId: 'workspace-1',
				workflow: { role: 'planning', model: 'Fable 5.1' }
			} satisfies CreateWorkspaceResult as T
		}
		const create = createTools(call).find(tool => tool.name === 'create_workspace')
		if (!create) throw new Error('create_workspace does not exist')

		const properties = create.inputSchema.properties as Record<string, unknown>
		expect(properties).toHaveProperty('workflow')
		const output = await create.run({ repo: 'conductor-remote', prompt: 'Build it.', workflow: true })

		expect(seen).toEqual({
			route: routes.createWorkspace.path(),
			body: {
				repo: 'conductor-remote',
				prompt: 'Build it.',
				workflow: true,
				send: false,
				sendImmediately: true
			}
		})
		expect(output).toContain('workflow root: planning · Fable 5.1')
		await expect(
			create.run({ repo: 'conductor-remote', prompt: 'Build it.', workflow: true, plan: false })
		).rejects.toThrow('workflow cannot be combined')
	})
})
