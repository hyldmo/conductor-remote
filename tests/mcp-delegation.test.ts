import { describe, expect, test } from 'vitest'
import { chatCursor } from '../src/chat-cursor.ts'
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
		exploration: { model: 'Muse Spark', effort: 'high', fast: false }
	},
	issues: [
		{
			role: 'exploration',
			error: { code: 'model_missing', message: 'choose an exact picker model', retryable: false }
		}
	]
}

describe('delegation MCP tools', () => {
	test('marks delegation as an explicitly requested live-agent action', () => {
		const delegate = tool('delegate_task', async <T>() => roles as T)
		expect(delegate.description).toContain('Only use it when the user asked')
		expect(INSTRUCTIONS).toContain('delegate_task later drives the real Mac UI and launches another agent')
	})

	test('keeps Plan mode out of the role editor schema', () => {
		const setRole = tool('set_role', async <T>() => roles as T)
		const properties = setRole.inputSchema.properties as Record<string, unknown>
		expect(properties).toHaveProperty('model')
		expect(properties).not.toHaveProperty('plan')
	})

	test('maps the delegation cursor and snake-case tool fields to the HTTP contract', async () => {
		const seen: { route?: string; body?: Record<string, unknown> } = {}
		const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
			seen.route = route
			seen.body = options?.body as Record<string, unknown>
			return { ok: true, delegationId: 'job-1', role: 'exploration', model: '5.6 Terra' } as T
		}

		const output = await tool('delegate_task', call).run({
			session_id: 'parent-1',
			workspace_id: 'workspace-1',
			role: 'exploration',
			prompt: 'Inspect this.',
			through: chatCursor(42),
			include_thinking: false,
			return_mode: 'queue'
		})

		expect(seen.route).toBe(routes.delegateTask.path('parent-1'))
		expect(seen.body).toEqual({
			role: 'exploration',
			prompt: 'Inspect this.',
			workspaceId: 'workspace-1',
			throughRowid: 42,
			includeThinking: false,
			returnMode: 'queue'
		})
		expect(output).toContain('job-1')
	})

	test('lists invalid roles without hiding their saved model', async () => {
		const output = await tool('list_roles', async <T>() => roles as T).run({})
		expect(output).toContain('exploration: Muse Spark · high')
		expect(output).toContain('model_missing')
	})

	test('drops inherited controls when changing a role to an OpenCode model', async () => {
		const calls: Array<{ route: string; body?: unknown }> = []
		const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
			calls.push({ route, body: options?.body })
			if (route === routes.roles.path() && !options?.method) return roles as T
			return { ok: true, config: options?.body } as T
		}

		await tool('set_role', call).run({
			role: 'exploration',
			model: 'opencode/muse-spark-1.3-contributor-free'
		})

		expect(calls[1]).toMatchObject({ route: routes.updateRoles.path() })
		expect(calls[1].body).toMatchObject({
			version: 1,
			roles: {
				planning: roles.roles.planning,
				exploration: { model: 'opencode/muse-spark-1.3-contributor-free' }
			}
		})
	})

	test('rejects an explicit OpenCode effort before updating role state', async () => {
		let called = false
		const call: RelayCall = async <T>() => {
			called = true
			return roles as T
		}

		await expect(
			tool('set_role', call).run({
				role: 'exploration',
				model: 'opencode/muse-spark-1.3-contributor-free',
				effort: 'high'
			})
		).rejects.toThrow(/no Conductor reasoning control/)
		expect(called).toBe(false)
	})

	test('lists and dismisses jobs through their canonical routes', async () => {
		const calls: string[] = []
		const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
			calls.push(`${options?.method ?? 'GET'} ${route}`)
			if (route === routes.delegations.path() || route.startsWith(`${routes.delegations.path()}?`)) {
				return {
					delegations: [
						{
							id: 'job-1',
							workspaceId: 'workspace-1',
							parentSessionId: 'parent-1',
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
			return { ok: true, delegationId: 'job-1' } as T
		}

		expect(await tool('list_delegations', call).run({ workspace_id: 'workspace-1' })).toContain('running')
		expect(await tool('dismiss_delegation', call).run({ delegation_id: 'job-1' })).toContain('dismissed')
		expect(calls).toEqual(['GET /api/delegations?workspaceId=workspace-1', 'DELETE /api/delegations/job-1'])
	})
})
