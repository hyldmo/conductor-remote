import { once } from 'node:events'
import fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentStore } from '../../src/agents/agent-store.ts'
import { DEFAULT_AUTO_MODEL_CONFIG } from '../../src/agents/auto-model/config.ts'
import { routingGlobals } from '../../src/agents/routing.ts'
import { createRelayServer } from '../../src/http/router.ts'
import { createResponsesServices } from '../../src/http/services/responses.ts'
import type { RelayServices } from '../../src/http/services.ts'
import type { AgentDefinition, AgentsResponse, RolesResponse, UpdateAgentsResult } from '../../src/wire.ts'

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		servers.splice(0).map(server => {
			server.closeAllConnections()
			return new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		})
	)
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** Real auth, dispatch, HTTP envelopes and stores; no DB, GUI, classifier or live relay. */
async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-test-'))
	directories.push(root)
	const cfg = {
		token: 'agent-http-token',
		dbPath: '/unused/db',
		workspacesRoot: '/unused/workspaces',
		publicDir: '/unused/public',
		port: 0,
		host: '127.0.0.1',
		writeStrategy: 'applescript' as const,
		preventScreenLock: false
	}
	const store = new AgentStore(path.join(root, 'agents'))
	const seed: AgentDefinition[] = [
		{ name: 'helper', model: '5.6 Sol', effort: 'high', description: 'Bounded work.', preamble: '# Delegate\n' },
		{ name: 'extra', model: '5.6 Luna', description: 'Simple work.' }
	]
	expect(store.write({ version: 1, agents: seed })).toMatchObject({ ok: true })
	store.routing.write({ ...routingGlobals(DEFAULT_AUTO_MODEL_CONFIG), fallback: 'helper' })
	const services = {
		...createResponsesServices({ cfg }),
		agentStore: store,
		roleStore: store.roles,
		autoModelConfig: store.autoModel,
		routingConfig: store.routing,
		modelCache: {
			list: () => [
				{
					agentType: 'codex',
					models: ['5.6 Sol', '5.6 Luna', '5.6 Terra', 'opencode-go/muse-spark-1.3-contributor'],
					updatedAt: 1
				}
			]
		},
		workflowHttpError: () => null
	} as unknown as RelayServices
	const server = createRelayServer(services)
	servers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const request = (pathname: string, method = 'GET', body?: unknown, authenticated = true) =>
		fetch(`${base}${pathname}`, {
			method,
			headers: authenticated ? { authorization: `Bearer ${cfg.token}` } : {},
			...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(5000)
		})
	const file = (name: string) => path.join(root, 'agents', `${name}.md`)
	return { root, store, request, seed, file }
}

describe('agent and routing HTTP contracts', () => {
	test('authenticates all four new routes before reading or writing', async () => {
		const f = await fixture()
		const read = vi.spyOn(f.store, 'read')
		const write = vi.spyOn(f.store, 'write')
		for (const endpoint of ['/api/agents', '/api/routing']) {
			for (const method of ['GET', 'PATCH'])
				expect((await f.request(endpoint, method, undefined, false)).status).toBe(401)
		}
		expect(read).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
	})

	test('serves editable definitions and patches body/known keys without exposing or losing unknown frontmatter', async () => {
		const f = await fixture()
		const unknown = 'tools:\n  - Read\npermissions:\n  shell: deny\n'
		fs.writeFileSync(f.file('helper'), `---\nmodel: 5.6 Sol\ndescription: Bounded work.\n${unknown}---\n# Delegate\n`)
		const get = await f.request('/api/agents')
		expect(get.status).toBe(200)
		const read: AgentsResponse = await get.json()
		expect(read).toMatchObject({ version: 1, issues: [] })
		expect(read.agents.find(a => a.name === 'helper')).toEqual({
			name: 'helper',
			model: '5.6 Sol',
			description: 'Bounded work.',
			preamble: '# Delegate\n'
		})
		expect(JSON.stringify(read)).not.toContain('permissions')
		const patch = await f.request('/api/agents', 'PATCH', {
			version: 1,
			agents: [{ ...read.agents.find(a => a.name === 'helper'), model: '5.6 Terra', preamble: '\n# Changed body\n\n' }]
		})
		expect(patch.status).toBe(200)
		const result: UpdateAgentsResult = await patch.json()
		expect(result).toEqual({
			ok: true,
			config: {
				version: 1,
				agents: [
					{ name: 'helper', model: '5.6 Terra', description: 'Bounded work.', preamble: '\n# Changed body\n\n' }
				],
				issues: []
			}
		})
		expect(fs.readFileSync(f.file('helper'), 'utf8')).toContain(unknown)
		expect(fs.existsSync(f.file('extra'))).toBe(false)
		const roles: RolesResponse = await (await f.request('/api/roles')).json()
		expect(roles.roles.helper).toEqual({ model: '5.6 Terra', preamble: '\n# Changed body\n\n' })
	})

	test('rejects every invalid agent before writing and returns role-compatible 409 issues keyed by agent', async () => {
		const f = await fixture()
		const before = fs.readFileSync(f.file('helper'), 'utf8')
		for (const raw of [
			'{bad',
			{ version: 2, agents: f.seed },
			{ version: 1, agents: [f.seed[0], f.seed[0]] },
			{ version: 1, agents: [{ ...f.seed[0], tools: ['Read'] }] }
		]) {
			const result = await f.request('/api/agents', 'PATCH', raw)
			expect(result.status).toBe(400)
			expect(await result.json()).toMatchObject({ ok: false, error: { code: 'invalid_request', retryable: false } })
		}
		for (const agent of [
			{ ...f.seed[0], model: 'no such model' },
			{ ...f.seed[0], model: 'opencode-go/muse-spark-1.3-contributor', effort: 'high' }
		]) {
			const result = await f.request('/api/agents', 'PATCH', { version: 1, agents: [agent] })
			expect(result.status).toBe(409)
			const body = await result.json()
			expect(body).toEqual({ ok: false, error: body.issues[0].error, issues: [{ agent: 'helper', error: body.error }] })
		}
		expect(fs.readFileSync(f.file('helper'), 'utf8')).toBe(before)
		expect(fs.existsSync(f.file('extra'))).toBe(true)
	})

	test('exposes invalid-file warnings and refuses a destructive whole-roster save', async () => {
		const f = await fixture()
		const bad = '---\nmodel: 5.6 Sol\nfast: maybe\n---\nKeep this.'
		fs.writeFileSync(f.file('bad'), bad)
		const get = await (await f.request('/api/agents')).json()
		expect(get.warning).toContain('bad.md')
		expect(get.agents).toHaveLength(2)
		const patch = await f.request('/api/agents', 'PATCH', { version: 1, agents: f.seed })
		expect(patch.status).toBe(500)
		expect(await patch.json()).toMatchObject({ ok: false, error: { code: 'state_invalid' } })
		expect(fs.readFileSync(f.file('bad'), 'utf8')).toBe(bad)
	})

	test('roles compatibility writes preserve description and unknown lines while updating tuples and delegation body', async () => {
		const f = await fixture()
		fs.appendFileSync(f.file('helper'), 'Additional body.\n')
		const patch = await f.request('/api/roles', 'PATCH', {
			version: 1,
			roles: { helper: { model: '5.6 Terra', fast: false, preamble: 'Replacement body.' } }
		})
		expect(patch.status).toBe(200)
		expect(await patch.json()).toEqual({
			ok: true,
			config: { version: 1, roles: { helper: { model: '5.6 Terra', fast: false, preamble: 'Replacement body.' } } }
		})
		expect(f.store.read().agents).toEqual([
			{ name: 'helper', model: '5.6 Terra', fast: false, description: 'Bounded work.', preamble: 'Replacement body.' }
		])
		const auto = await (await f.request('/api/auto-model')).json()
		expect(auto.config.profiles).toEqual([
			{ id: 'helper', model: '5.6 Terra', fast: false, description: 'Bounded work.' }
		])
	})

	test('Auto compatibility writes update shared tuples, preserve bodies and retain removed profile files', async () => {
		const f = await fixture()
		const config = {
			...f.store.autoModel.read(),
			defaultAuto: true,
			fallback: 'new',
			profiles: [
				{ id: 'helper', model: '5.6 Terra', description: 'New description.' },
				{ id: 'new', model: '5.6 Sol', description: 'New profile.' }
			]
		}
		const result = await f.request('/api/auto-model', 'PATCH', config)
		expect(result.status).toBe(200)
		expect(await result.json()).toEqual({ config, issues: [] })
		expect(f.store.roles.read().config.roles.helper).toEqual({ model: '5.6 Terra', preamble: '# Delegate\n' })
		expect(f.store.read().agents.find(a => a.name === 'extra')?.description).toBeUndefined()
		expect(fs.existsSync(f.file('extra'))).toBe(true)
		expect((await (await f.request('/api/routing')).json()).config).toEqual(routingGlobals(config))
	})

	test('routing endpoints validate globals, router and fallback without blocking on optional profile models', async () => {
		const f = await fixture()
		fs.writeFileSync(f.file('extra'), '---\nmodel: missing\ndescription: Optional.\n---\n')
		const read = await (await f.request('/api/routing')).json()
		expect(read).toEqual({ config: f.store.routing.read(), issues: [] })
		expect(read.config).not.toHaveProperty('profiles')
		const config = { ...read.config, rules: 'Updated rules.', defaultAuto: true, timeoutMs: 8000 }
		const patch = await f.request('/api/routing', 'PATCH', config)
		expect(patch.status).toBe(200)
		expect(await patch.json()).toEqual({ config, issues: [] })
		for (const invalid of [
			{ ...config, fallback: 'absent' },
			{ ...config, fallback: 'extra' },
			{ ...config, router: { model: 'Fable 5' } },
			{ ...config, profiles: [] },
			{ ...config, timeoutMs: 1 }
		])
			expect((await f.request('/api/routing', 'PATCH', invalid)).status).toBe(400)
		expect(f.store.routing.read()).toEqual(config)
		fs.unlinkSync(f.file('helper'))
		expect((await (await f.request('/api/routing')).json()).issues).toContain('Choose an existing fallback profile.')
	})
})
