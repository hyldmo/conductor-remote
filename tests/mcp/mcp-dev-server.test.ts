import { describe, expect, test } from 'vitest'
import { INSTRUCTIONS } from '../../src/mcp/protocol.ts'
import { createTools } from '../../src/mcp/registry.ts'
import type { CallOptions, RelayCall } from '../../src/mcp/types.ts'
import { routes } from '../../src/routes.ts'
import type { DevServerResult, DevServerState } from '../../src/wire.ts'

const stopped: DevServerState = {
	available: true,
	running: false,
	forwarded: false,
	port: 41_000,
	url: null,
	forwards: [
		{ name: 'Web', port: 41_000, running: false, forwarded: false, url: null },
		{ name: 'API', port: 41_001, running: false, forwarded: false, url: null }
	],
	runConfigs: [
		{ id: 'web', name: 'Web' },
		{ id: 'api-worker', name: 'Api Worker' }
	]
}

function devServerTool(call: RelayCall) {
	const tool = createTools(call).find(candidate => candidate.name === 'dev_server')
	if (!tool) throw new Error('dev_server does not exist')
	return tool
}

describe('MCP dev_server', () => {
	test('defaults to a read-only status and names exact Run config IDs', async () => {
		const calls: Array<{ route: string; options?: CallOptions }> = []
		const output = await devServerTool(async <T>(route: string, options?: CallOptions): Promise<T> => {
			calls.push({ route, options })
			return stopped as T
		}).run({ workspace_id: 'workspace-1' })

		expect(calls).toEqual([{ route: routes.devServer.path('workspace-1'), options: undefined }])
		expect(output).toContain('stopped · port 41000')
		expect(output).toContain('run configs: web (Web), api-worker (Api Worker)')
		expect(output).toContain('API: port 41001 · stopped · not forwarded')
	})

	test('starts an exact Run config through the shared route and returns every preview', async () => {
		const calls: Array<{ route: string; options?: CallOptions }> = []
		const started: DevServerResult = {
			...stopped,
			ok: true,
			changed: true,
			running: true,
			forwarded: true,
			url: 'https://mac.example.ts.net:51000/app',
			task: 'Web',
			forwards: [
				{
					name: 'Web',
					port: 41_000,
					running: true,
					forwarded: true,
					url: 'https://mac.example.ts.net:51000/app'
				},
				{
					name: 'API',
					port: 41_001,
					running: true,
					forwarded: true,
					url: 'https://mac.example.ts.net:51001/docs'
				}
			]
		}
		const output = await devServerTool(async <T>(route: string, options?: CallOptions): Promise<T> => {
			calls.push({ route, options })
			return started as T
		}).run({ workspace_id: 'workspace-1', action: 'start', run_config_id: 'web' })

		expect(calls).toEqual([
			{
				route: routes.startDevServer.path('workspace-1'),
				options: {
					method: routes.startDevServer.method,
					body: { runConfigId: 'web' },
					timeoutMs: 75_000
				}
			}
		])
		expect(output).toContain('started · task Web · port 41000 · forwarded https://mac.example.ts.net:51000/app')
		expect(output).toContain('API: port 41001 · running · forwarded https://mac.example.ts.net:51001/docs')
	})

	test('stops through Conductor and reports an already-stopped task', async () => {
		const calls: Array<{ route: string; options?: CallOptions }> = []
		const result: DevServerResult = { ...stopped, ok: true, changed: false }
		const output = await devServerTool(async <T>(route: string, options?: CallOptions): Promise<T> => {
			calls.push({ route, options })
			return result as T
		}).run({ workspace_id: 'workspace-1', action: 'stop' })

		expect(calls).toEqual([
			{
				route: routes.stopDevServer.path('workspace-1'),
				options: { method: routes.stopDevServer.method, timeoutMs: 75_000 }
			}
		])
		expect(output).toContain('already stopped · port 41000')
	})

	test('rejects invalid actions, misplaced config choices and controller failures', async () => {
		let calls = 0
		const tool = devServerTool(async <T>(): Promise<T> => {
			calls++
			return { ...stopped, ok: false, error: 'Choose which Run config to start' } as T
		})

		await expect(tool.run({ workspace_id: 'workspace-1', action: 'restart' })).rejects.toThrow('action is invalid')
		await expect(tool.run({ workspace_id: 'workspace-1', run_config_id: 'web' })).rejects.toThrow(
			'run_config_id is only valid with action start'
		)
		expect(calls).toBe(0)

		await expect(tool.run({ workspace_id: 'workspace-1', action: 'start' })).rejects.toThrow(
			'Choose which Run config to start'
		)
		expect(calls).toBe(1)
	})

	test('instructs agents to prefer the managed Run task over a shell server', () => {
		expect(INSTRUCTIONS).toContain('dev_server')
		expect(INSTRUCTIONS).toContain('instead of launching a long-lived development server from a shell')
	})
})
