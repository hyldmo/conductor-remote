import { describe, expect, test } from 'vitest'
import { type CallOptions, createTools, INSTRUCTIONS, type RelayCall, type Tool } from '../src/mcp-tools.ts'
import { routes } from '../src/routes.ts'
import type { RolesResponse } from '../src/wire.ts'

function tool(name: string, call: RelayCall): Tool {
	const found = createTools(call).find(candidate => candidate.name === name)
	if (!found) throw new Error(`${name} does not exist`)
	return found
}

const roles: RolesResponse = {
	version: 1,
	roles: {
		planning: { model: 'Fable 5', effort: 'max', fast: false },
		exploration: { model: 'Muse Spark', effort: 'high', fast: false },
		implementation: { model: '5.6 Terra', effort: 'high', fast: false }
	},
	issues: [
		{
			role: 'exploration',
			error: { code: 'model_missing', message: 'choose an exact picker model', retryable: false }
		}
	]
}

describe('delegation MCP tools', () => {
	test('limits agent mutations to a previously authorized Workflow delegation', () => {
		const tools = createTools(async <T>() => roles as T)
		const delegate = tools.find(candidate => candidate.name === 'delegate_task')
		if (!delegate) throw new Error('delegate_task does not exist')

		expect(delegate.description).toContain('Workflow this root already belongs to')
		expect(INSTRUCTIONS).toContain('Workflow already authorized from the phone')
		expect(INSTRUCTIONS).not.toContain('Plan mode')
		expect(tools.map(candidate => candidate.name)).not.toContain('set_role')
		expect(tools.map(candidate => candidate.name)).not.toContain('dismiss_delegation')
	})

	test('posts the exact capability-scoped contract to the Workflow route', async () => {
		const seen: { route?: string; method?: string; body?: Record<string, unknown> } = {}
		const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
			seen.route = route
			seen.method = options?.method
			seen.body = options?.body as Record<string, unknown>
			return {
				ok: true,
				workflowId: 'workflow-1',
				delegationId: 'job-1',
				role: 'exploration',
				model: '5.6 Terra'
			} as T
		}

		const delegate = tool('delegate_task', call)
		const schema = delegate.inputSchema as {
			properties: Record<string, unknown>
			required: string[]
			additionalProperties?: boolean
		}
		expect(Object.keys(schema.properties)).toEqual(['workflow_id', 'phase_capability', 'session_id', 'role', 'prompt'])
		expect(schema.required).toEqual(Object.keys(schema.properties))
		expect(schema.additionalProperties).toBe(false)

		const output = await delegate.run({
			workflow_id: 'workflow-1',
			phase_capability: 'secret-capability',
			session_id: 'root-1',
			role: 'exploration',
			prompt: 'Inspect this.'
		})

		expect(seen).toEqual({
			route: routes.workflowDelegation.path('workflow-1'),
			method: routes.workflowDelegation.method,
			body: {
				workflow_id: 'workflow-1',
				phase_capability: 'secret-capability',
				session_id: 'root-1',
				role: 'exploration',
				prompt: 'Inspect this.'
			}
		})
		expect(output).toContain('job-1')
	})

	test('rejects role overrides and unknown fields before calling the relay', async () => {
		let calls = 0
		const delegate = tool('delegate_task', async <T>() => {
			calls += 1
			return {} as T
		})

		await expect(
			delegate.run({
				workflow_id: 'workflow-1',
				phase_capability: 'capability',
				session_id: 'root-1',
				role: 'exploration',
				prompt: 'Inspect this.',
				return_mode: 'queue'
			})
		).rejects.toThrow('unknown field: return_mode')
		await expect(
			delegate.run({
				workflow_id: 'workflow-1',
				phase_capability: 'capability',
				session_id: 'root-1',
				role: 'planning',
				prompt: 'Implement this.'
			})
		).rejects.toThrow('role is invalid')
		expect(calls).toBe(0)
	})

	test('lists invalid roles without exposing an editor', async () => {
		const output = await tool('list_roles', async <T>() => roles as T).run({})
		expect(output).toContain('exploration: Muse Spark · high')
		expect(output).toContain('model_missing')
		expect(createTools(async <T>() => roles as T).map(candidate => candidate.name)).not.toContain('set_role')
	})

	test('keeps delegation status read-only over MCP', async () => {
		const calls: string[] = []
		const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
			calls.push(`${options?.method ?? 'GET'} ${route}`)
			return {
				delegations: [
					{
						id: 'job-1',
						workflowId: 'workflow-1',
						logicalKey: 'explore:0',
						bootstrap: true,
						workspaceId: 'workspace-1',
						parentSessionId: 'root-1',
						role: 'exploration',
						resolvedRole: { model: '5.6 Terra', agentType: 'codex' },
						prompt: 'Inspect',
						returnMode: 'queue',
						status: 'running',
						attempts: 0,
						createdAt: 1,
						updatedAt: 2
					}
				]
			} as T
		}

		expect(await tool('list_delegations', call).run({ workspace_id: 'workspace-1' })).toContain('running')
		expect(calls).toEqual(['GET /api/delegations?workspaceId=workspace-1'])
	})
})
