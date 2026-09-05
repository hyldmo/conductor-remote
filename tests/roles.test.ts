import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
	DEFAULT_ROLES,
	newestModelSnapshot,
	ROLE_CONTROL_CAPABILITIES,
	RoleStore,
	resolveRole,
	roleModelIssues
} from '../src/roles.ts'

const temporaryDirs: string[] = []

function testStore(): { store: RoleStore; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-roles-'))
	temporaryDirs.push(dir)
	const file = path.join(dir, 'roles.json')
	return { store: new RoleStore(file), file }
}

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('delegated role store', () => {
	test('starts with the shipped roles without persisting or enabling Plan mode', () => {
		const { store, file } = testStore()
		const result = store.read()

		expect(result).toEqual({ config: DEFAULT_ROLES })
		expect(result.config.roles.planning).toMatchObject({ model: 'Fable 5', effort: 'max', fast: false })
		expect(result.config.roles.exploration).toEqual({
			model: 'Muse Spark',
			preamble: expect.any(String)
		})
		expect(result.config.roles.implementation).toMatchObject({ model: '5.6 Sol', effort: 'xhigh' })
		expect(Object.values(result.config.roles).every(role => !Object.hasOwn(role, 'plan'))).toBe(true)
		expect(fs.existsSync(file)).toBe(false)
	})

	test('atomically replaces a valid v1 document and writes it privately', () => {
		const { store, file } = testStore()
		const result = store.write({
			version: 1,
			roles: {
				exploration: { model: 'opencode/muse-spark-1.3-contributor-free' },
				implementation: { model: '5.6 Sol', effort: 'ultracode', preamble: 'Implement the accepted baton.' }
			}
		})

		expect(result.ok).toBe(true)
		expect(store.read().config.roles.exploration.model).toContain('muse-spark')
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		expect(fs.readdirSync(path.dirname(file))).toEqual(['roles.json'])
	})

	test('invalidates its process cache when roles.json changes outside this process', () => {
		const { store, file } = testStore()
		expect(store.write({ version: 1, roles: { planning: { model: 'Fable 5' } } }).ok).toBe(true)
		expect(store.read().config.roles.planning.model).toBe('Fable 5')

		fs.writeFileSync(file, JSON.stringify({ version: 1, roles: { planning: { model: 'Fable 5.1' } } }))
		const changed = new Date(Date.now() + 2000)
		fs.utimesSync(file, changed, changed)

		expect(store.read().config.roles.planning.model).toBe('Fable 5.1')
	})

	test("refuses controls Conductor doesn't render for an OpenCode role", () => {
		const groups = [
			{
				agentType: 'acp',
				models: ['opencode-go/muse-spark-1.3-contributor'],
				updatedAt: 1
			}
		]

		for (const role of [
			{ model: 'opencode-go/muse-spark-1.3-contributor', effort: 'high' as const },
			{ model: 'opencode-go/muse-spark-1.3-contributor', fast: false }
		]) {
			const config = { version: 1 as const, roles: { exploration: role } }
			expect(roleModelIssues(config, groups)).toMatchObject([
				{ role: 'exploration', error: { code: 'invalid_request' } }
			])
			expect(resolveRole(config, 'exploration', groups)).toMatchObject({
				ok: false,
				error: { code: 'invalid_request' }
			})
		}
	})

	test('uses the versioned verified-control table instead of provider guesses', () => {
		expect(ROLE_CONTROL_CAPABILITIES.version).toBe(1)
		expect(ROLE_CONTROL_CAPABILITIES.providers.codex.efforts).toContain('none')
		expect(ROLE_CONTROL_CAPABILITIES.providers.claude.efforts).not.toContain('none')
	})

	test('rejects unknown fields, including Plan, without replacing the last good value', () => {
		const { store, file } = testStore()
		const before = store.write({ version: 1, roles: { exploration: { model: '5.6 Terra', effort: 'high' } } })
		expect(before.ok).toBe(true)
		const bytes = fs.readFileSync(file, 'utf8')

		const rejected = store.write({
			version: 1,
			roles: { exploration: { model: '5.6 Terra', effort: 'high', plan: true } }
		})

		expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('plan') })
		expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
		expect(store.read().config.roles.exploration.model).toBe('5.6 Terra')
	})

	test('preserves a malformed or unsupported file and reports the problem', () => {
		for (const raw of ['{oops', JSON.stringify({ version: 2, roles: {} })]) {
			const { store, file } = testStore()
			fs.writeFileSync(file, raw)

			const result = store.read()
			expect(result.warning).toBeTruthy()
			expect(result.config).toEqual(DEFAULT_ROLES)
			expect(fs.readFileSync(file, 'utf8')).toBe(raw)
		}
	})

	test('reports unavailable, ambiguous, and unknown-provider models without changing them', () => {
		const groups = [
			{
				agentType: 'codex',
				models: [
					'Fable 5',
					'opencode-go/muse-spark-1.3-contributor',
					'opencode/muse-spark-1.3-contributor-free',
					'5.6 Sol'
				],
				updatedAt: 3
			}
		]
		const issues = roleModelIssues(DEFAULT_ROLES, groups)

		expect(issues).toEqual([
			expect.objectContaining({ role: 'exploration', error: expect.objectContaining({ code: 'model_missing' }) })
		])
		expect(DEFAULT_ROLES.roles.exploration.model).toBe('Muse Spark')
		expect(resolveRole(DEFAULT_ROLES, 'implementation', groups)).toEqual({
			ok: true,
			role: { model: '5.6 Sol', agentType: 'codex', effort: 'xhigh', fast: false, preamble: expect.any(String) }
		})
		expect(resolveRole(DEFAULT_ROLES, 'exploration', groups)).toMatchObject({
			ok: false,
			error: { code: 'model_missing' }
		})
		expect(resolveRole(DEFAULT_ROLES, 'missing', groups)).toMatchObject({
			ok: false,
			error: { code: 'role_not_found' }
		})
	})

	test('deduplicates whole-picker caches and resolves each exact label to its real provider', () => {
		const config = {
			version: 1 as const,
			roles: {
				planning: { model: 'Fable 5.1' },
				exploration: { model: 'opencode-go/muse-spark-1.3-contributor' },
				implementation: { model: '5.6 Sol' }
			}
		}
		const models = ['Fable 5.1', 'opencode-go/muse-spark-1.3-contributor', '5.6 Sol']
		const groups = [
			{ agentType: 'claude', models, updatedAt: 1 },
			{ agentType: 'codex', models, updatedAt: 2 }
		]

		expect(roleModelIssues(config, groups)).toEqual([])
		expect(resolveRole(config, 'planning', groups)).toMatchObject({
			ok: true,
			role: { model: 'Fable 5.1', agentType: 'claude' }
		})
		expect(resolveRole(config, 'exploration', groups)).toMatchObject({
			ok: true,
			role: { model: 'opencode-go/muse-spark-1.3-contributor', agentType: 'acp' }
		})
		expect(resolveRole(config, 'implementation', groups)).toMatchObject({
			ok: true,
			role: { model: '5.6 Sol', agentType: 'codex' }
		})
	})

	test('uses only the newest non-empty whole-picker snapshot', () => {
		const groups = [
			{ agentType: 'claude', models: ['Fable 5', '5.6 Sol'], updatedAt: 10 },
			{ agentType: 'codex', models: ['5.6 Sol'], snapshotAt: null, updatedAt: 30 },
			{ agentType: 'codex', models: ['Fable 5.1', '5.6 Sol'], updatedAt: 20 }
		]
		expect(newestModelSnapshot(groups)?.updatedAt).toBe(20)
		expect(resolveRole({ version: 1, roles: { planning: { model: 'Fable 5' } } }, 'planning', groups)).toMatchObject({
			ok: false,
			error: { code: 'model_missing' }
		})
		expect(resolveRole({ version: 1, roles: { planning: { model: 'Fable 5.1' } } }, 'planning', groups)).toMatchObject({
			ok: true
		})
	})

	test('a newer Spark menu cannot invalidate other providers, but a provider rename still does', () => {
		const spark = 'opencode-go/muse-spark-1.3-contributor'
		const config = {
			version: 1 as const,
			roles: {
				planning: { model: 'Fable 5.1' },
				exploration: { model: spark },
				implementation: { model: '5.6 Sol' }
			}
		}
		const groups = [
			{ agentType: 'claude', models: ['Fable 5', '5.6 Sol', spark], snapshotAt: 1, updatedAt: 1 },
			{ agentType: 'codex', models: ['Fable 5.1', '5.6 Sol', spark], snapshotAt: 2, updatedAt: 2 },
			// v1.107.0 learned this row without recording snapshotAt.
			{ agentType: 'acp', models: [spark], updatedAt: 3 },
			{ agentType: 'claude', models: ['Fable 5'], snapshotAt: null, updatedAt: 4 }
		]
		expect(roleModelIssues(config, groups)).toEqual([])
		for (const role of Object.keys(config.roles)) expect(resolveRole(config, role, groups)).toMatchObject({ ok: true })
		expect(resolveRole({ version: 1, roles: { planning: { model: 'Fable 5' } } }, 'planning', groups)).toMatchObject({
			ok: false,
			error: { code: 'model_missing' }
		})
	})

	test('refuses an exact picker label whose provider is unknown', () => {
		const config = { version: 1 as const, roles: { exploration: { model: 'unknown-model' } } }
		const groups = [{ agentType: 'codex', models: ['unknown-model'], updatedAt: 1 }]

		expect(roleModelIssues(config, groups)).toMatchObject([
			{ role: 'exploration', error: { code: 'provider_unknown' } }
		])
		expect(resolveRole(config, 'exploration', groups)).toMatchObject({
			ok: false,
			error: { code: 'provider_unknown' }
		})
	})

	test('refuses Codex-only None effort before any UI work', () => {
		const config = { version: 1 as const, roles: { planning: { model: 'Fable 5', effort: 'none' as const } } }
		const groups = [{ agentType: 'claude', models: ['Fable 5'], updatedAt: 1 }]

		expect(roleModelIssues(config, groups)).toMatchObject([{ role: 'planning', error: { code: 'invalid_request' } }])
		expect(resolveRole(config, 'planning', groups)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' }
		})
	})
})
