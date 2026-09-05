import { once } from 'node:events'
import fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES } from '../../src/agents/agent-import.ts'
import { AgentStore } from '../../src/agents/agent-store.ts'
import { DEFAULT_AUTO_MODEL_CONFIG } from '../../src/agents/auto-model/config.ts'
import { routingGlobals } from '../../src/agents/routing.ts'
import { createRelayServer } from '../../src/http/router.ts'
import { createResponsesServices } from '../../src/http/services/responses.ts'
import type { RelayServices } from '../../src/http/services.ts'
import type {
	AgentDefinition,
	AgentImportScanResponse,
	AgentsResponse,
	ImportAgentsResult,
	RolesResponse,
	UpdateAgentsResult
} from '../../src/wire.ts'

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

async function importFixture() {
	const f = await fixture()
	const home = path.join(f.root, 'home')
	const source = path.join(home, '.claude', 'agents')
	fs.mkdirSync(source, { recursive: true })
	vi.spyOn(os, 'homedir').mockReturnValue(home)
	const candidate = (name: string, bytes = '---\nmodel: haiku\ndescription: Imported work.\n---\nInstructions.\n') => {
		const file = path.join(source, `${name}.md`)
		fs.writeFileSync(file, bytes)
		return file
	}
	const scan = async (): Promise<AgentImportScanResponse> => {
		const response = await f.request('/api/agents/import')
		expect(response.status).toBe(200)
		return response.json()
	}
	const importNames = async (names: string[], overwrite?: boolean): Promise<ImportAgentsResult> => {
		const response = await f.request('/api/agents/import', 'POST', { names, overwrite })
		expect(response.status).toBe(200)
		return response.json()
	}
	return { ...f, home, source, candidate, scan, importNames }
}

describe('user-scoped Claude agent import HTTP contracts', () => {
	test('authenticates both import routes before inspecting or copying files', async () => {
		const f = await importFixture()
		const names = vi.spyOn(f.store, 'names')
		const copy = vi.spyOn(f.store, 'importFile')
		for (const method of ['GET', 'POST'])
			expect((await f.request('/api/agents/import', method, undefined, false)).status).toBe(401)
		expect(names).not.toHaveBeenCalled()
		expect(copy).not.toHaveBeenCalled()
	})

	test('treats a missing directory as empty without scanning repositories', async () => {
		const f = await importFixture()
		fs.rmSync(f.source, { recursive: true })
		const repoAgents = path.join(f.home, 'repo', '.claude', 'agents')
		fs.mkdirSync(repoAgents, { recursive: true })
		fs.writeFileSync(path.join(repoAgents, 'ignored.md'), '---\nmodel: haiku\n---\n')
		expect(await f.scan()).toEqual({ candidates: [], skipped: [], truncated: false, limit: MAX_IMPORT_FILES })
		expect((await f.importNames(['ignored'])).results).toMatchObject([{ name: 'ignored', ok: false }])
	})

	test('previews filename identities, raw model scalars, bodies, collisions and rejected definitions', async () => {
		const f = await importFixture()
		f.candidate('good', '---\nname: opaque-other-name\nmodel: " haiku "\ndescription: Quick work.\n---\nBody\n')
		f.candidate('helper', '---\nmodel: sonnet\n---\n \n')
		f.candidate('bad', '---\nmodel: haiku\ndescription: >\n  Multiline\n---\n')
		f.candidate('missing', '---\ndescription: No model\n---\n')
		f.candidate('Upper')
		fs.writeFileSync(path.join(f.source, 'utf8.md'), Buffer.from([0xff]))
		fs.writeFileSync(path.join(f.source, 'ignored.txt'), 'Ignored')
		const scan = await f.scan()
		expect(scan.candidates).toEqual([
			{ name: 'good', description: 'Quick work.', model: ' haiku ', hasBody: true, collision: false },
			{ name: 'helper', model: 'sonnet', hasBody: false, collision: true }
		])
		expect(scan.skipped.map(entry => entry.name)).toEqual(['Upper', 'bad', 'missing', 'utf8'])
		expect(scan.skipped.find(entry => entry.name === 'bad')?.reason).toContain('flat scalar')
		expect(scan.skipped.find(entry => entry.name === 'missing')?.reason).toContain('model')
		expect(scan.skipped.find(entry => entry.name === 'utf8')?.reason).toContain('UTF-8')
		expect(scan.truncated).toBe(false)
	})

	test('skips symlinks, directories and oversized files and never imports their contents', async () => {
		const f = await importFixture()
		const outside = path.join(f.root, 'outside.md')
		fs.writeFileSync(outside, '---\nmodel: haiku\n---\n')
		fs.symlinkSync(outside, path.join(f.source, 'escape.md'))
		fs.symlinkSync(f.candidate('good'), path.join(f.source, 'link.md'))
		fs.mkdirSync(path.join(f.source, 'directory.md'))
		fs.writeFileSync(path.join(f.source, 'huge.md'), Buffer.alloc(MAX_IMPORT_BYTES + 1, 'a'))
		const scan = await f.scan()
		expect(scan.candidates.map(candidate => candidate.name)).toEqual(['good'])
		expect(scan.skipped.map(entry => entry.name)).toEqual(['directory', 'escape', 'huge', 'link'])
		expect(scan.skipped.find(entry => entry.name === 'escape')?.reason).toContain('outside')
		expect(scan.skipped.find(entry => entry.name === 'huge')?.reason).toContain('256 KiB')
		const result = await f.importNames(['escape', 'link', 'directory', 'huge', '../outside'])
		expect(result.results.every(outcome => !outcome.ok)).toBe(true)
		expect(result.config.agents).toHaveLength(2)
	})

	test('copies bytes exactly, preserves foreign name/tools/color lines and reports native model issues', async () => {
		const f = await importFixture()
		const source = Buffer.from(
			'---\r\n# Keep this comment\r\nname: other-identity\r\ntools:\r\n  - Read\r\n  - Bash\r\ncolor: purple\r\nmodel: haiku\r\ndescription: Quick work.\r\n---\r\n\r\n# Body ☃\r\nNo final newline'
		)
		fs.writeFileSync(path.join(f.source, 'imported.md'), source)
		const result = await f.importNames(['imported'])
		expect(result.results).toEqual([{ name: 'imported', ok: true, overwritten: false }])
		expect(fs.readFileSync(f.file('imported'))).toEqual(source)
		expect(fs.readFileSync(path.join(f.source, 'imported.md'))).toEqual(source)
		expect(fs.statSync(f.file('imported')).mode & 0o777).toBe(0o600)
		expect(result.config.agents.find(agent => agent.name === 'imported')).toMatchObject({
			model: 'haiku',
			description: 'Quick work.'
		})
		expect(result.config.issues).toMatchObject([{ agent: 'imported', error: { code: 'model_missing' } }])
		expect(result.config.warning).toBeUndefined()
		expect(result.config).toEqual(await (await f.request('/api/agents')).json())
	})

	test('refuses collisions individually and overwrites only with an explicit true option', async () => {
		const f = await importFixture()
		const original = fs.readFileSync(f.file('helper'))
		f.candidate('helper')
		f.candidate('fresh')
		const result = await f.importNames(['helper', 'fresh'])
		expect(result.results).toEqual([
			{ name: 'helper', ok: false, error: expect.stringContaining('overwrite') },
			{ name: 'fresh', ok: true, overwritten: false }
		])
		expect(fs.readFileSync(f.file('helper'))).toEqual(original)
		expect((await f.importNames(['helper'], false)).results[0].ok).toBe(false)
		expect((await f.importNames(['helper'], true)).results).toEqual([{ name: 'helper', ok: true, overwritten: true }])
		expect(fs.readFileSync(f.file('helper'))).toEqual(fs.readFileSync(path.join(f.source, 'helper.md')))
		expect(fs.readFileSync(f.file('extra'), 'utf8')).toContain('Simple work.')
	})

	test('counts unreadable canonical files as collisions and can repair one by explicit overwrite', async () => {
		const f = await importFixture()
		fs.writeFileSync(f.file('broken'), 'Malformed canonical file')
		f.candidate('broken')
		expect((await f.scan()).candidates[0].collision).toBe(true)
		expect((await f.importNames(['broken'])).results[0].ok).toBe(false)
		expect((await f.importNames(['broken'], true)).config.warning).toBeUndefined()
		fs.symlinkSync(f.file('helper'), f.file('linked'))
		f.candidate('linked')
		expect((await f.importNames(['linked'], true)).results).toMatchObject([
			{ ok: false, error: expect.stringContaining('regular file') }
		])
		expect(fs.readFileSync(f.file('helper'), 'utf8')).toContain('5.6 Sol')
	})

	test('caps the canonical roster at 32, including undecodable files, while permitting replacements', async () => {
		const f = await importFixture()
		const agents = Array.from({ length: 31 }, (_, index) => ({ name: `agent-${index}`, model: '5.6 Sol' }))
		expect(f.store.write({ version: 1, agents }).ok).toBe(true)
		f.candidate('first')
		f.candidate('second')
		fs.writeFileSync(f.file('bad'), 'Bad canonical file')
		expect((await f.importNames(['first'])).results).toMatchObject([
			{ ok: false, error: expect.stringContaining('32') }
		])
		fs.unlinkSync(f.file('bad'))
		const result = await f.importNames(['first', 'second'])
		expect(result.results).toEqual([
			{ name: 'first', ok: true, overwritten: false },
			{ name: 'second', ok: false, error: expect.stringContaining('32') }
		])
		expect(result.config.agents).toHaveLength(32)
		f.candidate('first', '---\nmodel: sonnet\n---\nUpdated')
		expect((await f.importNames(['first'], true)).results[0].ok).toBe(true)
		expect(f.store.names()).toHaveLength(32)
	})

	test('bounds the scan and refuses ambiguous duplicate requests without copying either occurrence', async () => {
		const f = await importFixture()
		for (let index = 0; index <= MAX_IMPORT_FILES; index++) f.candidate(`agent-${String(index).padStart(2, '0')}`)
		const scan = await f.scan()
		expect(scan.candidates).toHaveLength(MAX_IMPORT_FILES)
		expect(scan.truncated).toBe(true)
		const result = await f.importNames(['agent-00', 'agent-00', 'agent-01', 'agent-64'])
		expect(result.results.map(outcome => outcome.ok)).toEqual([false, false, true, false])
		expect(result.results[0]).toMatchObject({ error: expect.stringContaining('more than once') })
		expect(fs.existsSync(f.file('agent-00'))).toBe(false)
		expect(fs.existsSync(f.file('agent-64'))).toBe(false)
	})

	test('rechecks source contents and canonical collisions at import time', async () => {
		const f = await importFixture()
		f.candidate('changed')
		f.candidate('collision')
		expect((await f.scan()).candidates).toHaveLength(2)
		f.candidate('changed', '---\nmodel: haiku\nfast: maybe\n---\n')
		fs.writeFileSync(f.file('collision'), '---\nmodel: 5.6 Sol\n---\nCreated after preview')
		const result = await f.importNames(['changed', 'collision'])
		expect(result.results).toMatchObject([
			{ ok: false, error: expect.stringContaining('true or false') },
			{ ok: false, error: expect.stringContaining('already exists') }
		])
		expect(fs.existsSync(f.file('changed'))).toBe(false)
		expect(fs.readFileSync(f.file('collision'), 'utf8')).toContain('Created after preview')
	})

	test('validates the whole request before any writes', async () => {
		const f = await importFixture()
		f.candidate('good')
		const copy = vi.spyOn(f.store, 'importFile')
		for (const body of [
			'{bad',
			{},
			{ names: [] },
			{ names: ['good'], overwrite: 'true' },
			{ names: ['good'], directory: '/tmp' },
			{ names: Array(65).fill('good') }
		])
			expect((await f.request('/api/agents/import', 'POST', body)).status).toBe(400)
		expect(copy).not.toHaveBeenCalled()
	})
})
