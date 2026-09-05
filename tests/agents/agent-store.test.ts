import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { decodeAgents, parseAgentFile, serializeAgentFile } from '../../src/agents/agent-file.ts'
import { AgentStore } from '../../src/agents/agent-store.ts'
import { DEFAULT_AUTO_MODEL_CONFIG, freezeAutoModelConfig } from '../../src/agents/auto-model/config.ts'
import { DEFAULT_ROLES } from '../../src/agents/roles.ts'
import { decodeRoutingConfig, routingGlobals, routingIssues } from '../../src/agents/routing.ts'
import type { AgentDefinition, AutoModelConfig, RolesConfig } from '../../src/wire.ts'

const directories: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const globals = () => routingGlobals(DEFAULT_AUTO_MODEL_CONFIG)
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-test-'))
	directories.push(root)
	const directory = path.join(root, 'agents')
	const store = new AgentStore(directory)
	const file = (name: string) => path.join(directory, `${name}.md`)
	const readFile = (name: string) => fs.readFileSync(file(name), 'utf8')
	const save = (agents: AgentDefinition[]) => {
		expect(store.write({ version: 1, agents })).toMatchObject({ ok: true })
	}
	return { root, directory, store, file, readFile, save }
}

describe('flat agent frontmatter', () => {
	test('round-trips unknown blocks, comments, mixed newlines and the Markdown body byte for byte', () => {
		const unknown =
			'tools:\r\n  - Read\r\n  - "Bash(node:*)"\r\n# retained comment\n  \r\ncolor: purple\r\npermissions:\r\n  shell: deny\r\n'
		const body = '\r\n# Instructions\r\n\r\nUse $HOME literally.  \r\n---\nFinal line'
		const source = `---\r\nmodel: '5.6 Sol' # picker\r\n${unknown}effort: high\r\n---\r\n${body}`
		const parsed = parseAgentFile(source)
		expect(parsed.fields).toEqual({ model: '5.6 Sol', effort: 'high' })
		expect(parsed.body).toBe(body)
		expect(serializeAgentFile(parsed)).toBe(source)
		expect(serializeAgentFile(parsed, { model: '5.6 Sol', effort: 'high' })).toBe(source)
		const rewritten = serializeAgentFile(parsed, { model: '5.6 Terra', fast: false, effort: undefined })
		expect(rewritten).toContain(unknown)
		expect(rewritten).toContain('model: "5.6 Terra"\r\n')
		expect(rewritten).toContain('fast: false\r\n')
		expect(rewritten).not.toContain('effort:')
		expect(parseAgentFile(rewritten).body).toBe(body)
	})

	test('decodes bare, single-quoted and double-quoted scalars without treating unknown YAML as values', () => {
		const parsed = parseAgentFile(`---
description: 'It''s for "small" tasks: # literal' # comment
model: "5.6 Sol"
effort: 'xhigh'
fast: "false"
routing: true
tools: [Read, Bash]
---
body`)
		expect(parsed.fields).toEqual({
			description: 'It\'s for "small" tasks: # literal',
			model: '5.6 Sol',
			effort: 'xhigh',
			fast: false,
			routing: true
		})
		const description = 'A "quote", a slash \\ and a\nnewline'
		expect(parseAgentFile(serializeAgentFile(parsed, { description })).fields.description).toBe(description)
		expect(parseAgentFile('---\nmodel: 5.6 Sol # exact\ndescription: bare: text\n---').fields).toEqual({
			model: '5.6 Sol',
			description: 'bare: text'
		})
	})

	test('preserves files without frontmatter and can add a header without changing their body', () => {
		for (const source of ['', '# A role\n\nBody with trailing spaces  \n', 'No trailing newline']) {
			const parsed = parseAgentFile(source)
			expect(serializeAgentFile(parsed)).toBe(source)
			expect(parsed.body).toBe(source)
			const added = serializeAgentFile(parsed, { model: '5.6 Sol' })
			expect(parseAgentFile(added)).toMatchObject({ fields: { model: '5.6 Sol' }, body: source })
		}
		expect(serializeAgentFile(parseAgentFile('---\nmodel: 5.6 Sol\n---'))).toBe('---\nmodel: 5.6 Sol\n---')
	})

	test('keeps continuations with their key across blank and comment lines', () => {
		const unknown = 'tools:\n  - Read\n\n# still the tools block\n  - Bash\n'
		const source = `---\n${unknown}model: 5.6 Sol\n---\nBody`
		const parsed = parseAgentFile(source)
		expect(parsed.blocks.find(block => block.key === 'tools')?.lines.join('')).toBe(unknown)
		expect(serializeAgentFile(parsed, { model: '5.6 Terra' })).toContain(unknown)
		for (const separator of ['\n', '# comment\n', '# comment: containing a colon\n']) {
			expect(() =>
				parseAgentFile(`---\ndescription: first line\n${separator}  continued value\nmodel: 5.6 Sol\n---\n`)
			).toThrow('flat scalar')
		}
	})

	test.each([
		'---\nmodel: 5.6 Sol',
		'---\nmodel: 5.6 Sol\nmodel: 5.6 Terra\n---',
		'---\nfast: yes\n---',
		'---\neffort: turbo\n---',
		'---\nmodel: "unterminated\n---',
		'---\ndescription: |\n  multiline\n---',
		'---\nmodel: 5.6 Sol\n  nested: value\n---'
	])('refuses ambiguous or unsupported known values: %s', source => {
		expect(() => parseAgentFile(source)).toThrow()
	})
})

describe('agent migration', () => {
	test('copies role tuples and bodies, merges only profile descriptions on collision, and leaves legacy bytes unchanged', () => {
		const f = fixture()
		const roles: RolesConfig = {
			version: 1,
			roles: {
				exploration: { model: '5.6 Sol', effort: 'xhigh', fast: true, preamble: '\n# Explore\nNo trimming.  \n' },
				implementation: { model: '5.6 Terra', preamble: 'Implement.' }
			}
		}
		const auto: AutoModelConfig = {
			...DEFAULT_AUTO_MODEL_CONFIG,
			defaultAuto: true,
			fallback: 'quick',
			rules: 'Custom rules.',
			timeoutMs: 8000,
			profiles: [
				{ id: 'exploration', model: '5.6 Luna', effort: 'low', fast: false, description: 'Find evidence.' },
				{ id: 'quick', model: '5.6 Luna', effort: 'low', description: 'Small changes.' }
			]
		}
		const legacy = [
			['roles.json', JSON.stringify(roles, null, 2)],
			['auto-model.json', JSON.stringify(auto, null, 2)]
		] as const
		for (const [name, contents] of legacy) fs.writeFileSync(path.join(f.root, name), contents)
		expect(f.store.read()).toEqual({
			version: 1,
			agents: [
				{ name: 'exploration', ...roles.roles.exploration, description: 'Find evidence.' },
				{ name: 'implementation', ...roles.roles.implementation },
				{ name: 'quick', model: '5.6 Luna', effort: 'low', description: 'Small changes.', preamble: '' }
			]
		})
		expect(f.store.roles.read().config.roles.exploration).toEqual(roles.roles.exploration)
		expect(f.store.autoModel.read().profiles.find(p => p.id === 'exploration')).toEqual({
			id: 'exploration',
			model: '5.6 Sol',
			effort: 'xhigh',
			fast: true,
			description: 'Find evidence.'
		})
		expect(JSON.parse(fs.readFileSync(path.join(f.root, 'routing.json'), 'utf8'))).toEqual(routingGlobals(auto))
		for (const [name, contents] of legacy) expect(fs.readFileSync(path.join(f.root, name), 'utf8')).toBe(contents)
		for (const name of ['exploration', 'implementation', 'quick'])
			expect(fs.statSync(f.file(name)).mode & 0o777).toBe(0o600)
		expect(fs.statSync(path.join(f.root, 'routing.json')).mode & 0o777).toBe(0o600)
		expect(fs.readdirSync(f.root).sort()).toEqual(['agents', 'auto-model.json', 'roles.json', 'routing.json'])
		// An old relay's later edits are a frozen legacy snapshot, not another live authority.
		fs.writeFileSync(path.join(f.root, 'roles.json'), 'broken')
		expect(new AgentStore(f.directory).roles.read().config.roles.exploration).toEqual(roles.roles.exploration)
	})

	test('uses both shipped defaults when legacy files are absent without creating legacy JSON', () => {
		const f = fixture()
		expect(f.store.read().agents).toHaveLength(8)
		expect(f.store.roles.read().config.roles.exploration).toEqual(DEFAULT_ROLES.roles.exploration)
		expect(f.store.routing.read()).toEqual(globals())
		expect(fs.readdirSync(f.root).sort()).toEqual(['agents', 'routing.json'])
	})

	test.each([
		'roles.json',
		'auto-model.json'
	])('preserves corrupt legacy %s without publishing a partial migration', name => {
		const f = fixture()
		fs.writeFileSync(path.join(f.root, name), '{broken')
		expect(f.store.read().warning).toContain(name)
		expect(fs.existsSync(f.directory)).toBe(false)
		expect(fs.readFileSync(path.join(f.root, name), 'utf8')).toBe('{broken')
		fs.unlinkSync(path.join(f.root, name))
		expect(f.store.read().warning).toBeUndefined()
	})
})

describe('canonical agent store and compatibility views', () => {
	test('patches known fields while preserving unknown bytes and body, and deletes omitted files', () => {
		const f = fixture()
		f.store.read()
		const body = '\n# Custom instructions\n\nDo this exactly.  '
		const unknown = 'tools:\n  - Read\n  - Bash\ncolor: green\n'
		fs.writeFileSync(f.file('custom'), `---\n${unknown}model: '5.6 Sol'\n---\n${body}`)
		const custom = f.store.read().agents.find(a => a.name === 'custom')!
		f.save([{ ...custom, model: '5.6 Terra', description: 'Bounded edits.' }])
		expect(f.readFile('custom')).toContain(unknown)
		expect(parseAgentFile(f.readFile('custom')).body).toBe(body)
		expect(fs.readdirSync(f.directory)).toEqual(['custom.md'])
		expect(fs.statSync(f.file('custom')).mode & 0o777).toBe(0o600)
		f.save([])
		expect(f.store.read()).toEqual({ version: 1, agents: [] })
		expect(fs.readdirSync(f.directory)).toEqual([])
	})

	test('sees hand edits, additions and deletions across store instances and returns detached values', () => {
		const f = fixture()
		f.save([{ name: 'custom', model: '5.6 Sol' }])
		const other = new AgentStore(f.directory)
		expect(other.read().agents[0].model).toBe('5.6 Sol')
		fs.writeFileSync(f.file('custom'), '---\nmodel: 5.6 Terra\n---\nNew body')
		expect(other.read().agents[0]).toMatchObject({ model: '5.6 Terra', preamble: 'New body' })
		const detached = other.read()
		detached.agents[0].model = 'Mutated outside the cache'
		expect(other.read().agents[0].model).toBe('5.6 Terra')
		fs.writeFileSync(f.file('new'), '---\nmodel: 5.6 Luna\n---\n')
		expect(other.read().agents).toHaveLength(2)
		fs.unlinkSync(f.file('custom'))
		expect(other.read().agents.map(a => a.name)).toEqual(['new'])
	})

	test('reports undecodable files and refuses a batch that would silently delete or replace them', () => {
		const f = fixture()
		f.save([{ name: 'valid', model: '5.6 Sol' }])
		const bad = '---\nmodel: 5.6 Sol\nfast: maybe\n---\nKeep me.'
		fs.writeFileSync(f.file('bad'), bad)
		const read = f.store.read()
		expect(read.agents.map(a => a.name)).toEqual(['valid'])
		expect(read.warning).toContain('bad.md')
		expect(f.store.roles.read().warning).toBe(read.warning)
		expect(f.store.write({ version: 1, agents: [] })).toMatchObject({ ok: false })
		expect(f.store.write({ version: 1, agents: [{ name: 'bad', model: '5.6 Terra' }] })).toMatchObject({ ok: false })
		expect(fs.readdirSync(f.directory)).toEqual(['bad.md', 'valid.md'])
		expect(f.readFile('bad')).toBe(bad)
		fs.writeFileSync(f.file('bad'), '---\nmodel: 5.6 Terra\n---\nFixed.')
		expect(f.store.read().warning).toBeUndefined()
	})

	test('does not follow symlinks or hide a body-only file with a missing model', () => {
		const f = fixture()
		f.save([])
		fs.writeFileSync(path.join(f.root, 'outside.md'), '---\nmodel: 5.6 Sol\n---\nPrivate')
		fs.symlinkSync(path.join(f.root, 'outside.md'), f.file('link'))
		fs.writeFileSync(f.file('body'), '# Instructions only')
		expect(f.store.read()).toMatchObject({ agents: [], warning: expect.stringContaining('link.md') })
		expect(f.store.read().warning).toContain('body.md')
	})

	test('reports invalid UTF-8 without replacing opaque bytes during a rewrite', () => {
		const f = fixture()
		f.save([{ name: 'valid', model: '5.6 Sol' }])
		const bytes = Buffer.concat([
			Buffer.from('---\nmodel: 5.6 Sol\nunknown: '),
			Buffer.from([0xff]),
			Buffer.from('\n---\nKeep the original bytes.')
		])
		fs.writeFileSync(f.file('invalid'), bytes)
		expect(f.store.read()).toMatchObject({
			agents: [{ name: 'valid', model: '5.6 Sol', preamble: '' }],
			warning: expect.stringContaining('invalid.md')
		})
		expect(f.store.read().warning).toContain('UTF-8')
		expect(f.store.write({ version: 1, agents: [{ name: 'invalid', model: '5.6 Terra' }] })).toMatchObject({
			ok: false
		})
		expect(fs.readFileSync(f.file('invalid'))).toEqual(bytes)
	})

	test('rejects invalid or excessive rosters before persisting anything', () => {
		const f = fixture()
		f.save([{ name: 'valid', model: '5.6 Sol' }])
		const before = f.readFile('valid')
		for (const agents of [
			[{ name: '../escape', model: '5.6 Sol' }],
			[{ name: 'UPPER', model: '5.6 Sol' }],
			[{ name: 'valid', model: '5.6 Sol', plan: true }],
			[{ name: 'valid', model: '5.6 Sol', description: 'x'.repeat(1001) }],
			[{ name: 'valid', model: '5.6 Sol', preamble: 'x'.repeat(50_001) }],
			[{ name: 'valid', model: '5.6 Sol', routing: 'false' }],
			[
				{ name: 'valid', model: '5.6 Sol' },
				{ name: 'valid', model: '5.6 Terra' }
			],
			Array.from({ length: 33 }, (_, n) => ({ name: `agent-${n}`, model: '5.6 Sol' }))
		])
			expect(f.store.write({ version: 1, agents })).toMatchObject({ ok: false })
		expect(f.readFile('valid')).toBe(before)
		expect(fs.readdirSync(f.directory)).toEqual(['valid.md'])
		expect(() => decodeAgents({ version: 2, agents: [] })).toThrow()
	})

	test('roles PATCH changes tuples/body, removes omitted agents, and leaves surviving routing metadata verbatim', () => {
		const f = fixture()
		f.save([{ name: 'custom', model: '5.6 Sol', description: 'Route here.', routing: false }])
		fs.writeFileSync(
			f.file('custom'),
			`---\nmodel: 5.6 Sol\ndescription: 'Route here.' # keep\nrouting: false\ntools:\n  - Read\n---\nOld body`
		)
		expect(
			f.store.roles.write({ version: 1, roles: { custom: { model: '5.6 Luna', fast: false, preamble: 'New body\n' } } })
		).toMatchObject({ ok: true })
		expect(f.readFile('custom')).toContain("description: 'Route here.' # keep\nrouting: false\ntools:\n  - Read\n")
		expect(f.store.read().agents[0]).toEqual({
			name: 'custom',
			model: '5.6 Luna',
			fast: false,
			description: 'Route here.',
			routing: false,
			preamble: 'New body\n'
		})
		expect(f.store.roles.write({ version: 1, roles: { replacement: { model: '5.6 Terra' } } })).toMatchObject({
			ok: true
		})
		expect(fs.readdirSync(f.directory)).toEqual(['replacement.md'])
	})

	test('derives only descriptions opted into routing and keeps delegation instructions out of Auto', () => {
		const f = fixture()
		f.save([
			{
				name: 'fallback',
				model: '5.6 Sol',
				effort: 'high',
				fast: false,
				description: ' Fallback. ',
				preamble: 'Do not leak.'
			},
			{ name: 'included', model: '5.6 Luna', description: 'Cheap.', routing: true },
			{ name: 'excluded', model: '5.6 Terra', description: 'Disabled.', routing: false },
			{ name: 'empty', model: '5.6 Sol', description: '  ' },
			{ name: 'role', model: '5.6 Sol' }
		])
		f.store.routing.write({ ...globals(), fallback: 'fallback' })
		const config = f.store.autoModel.read()
		expect(config.profiles).toEqual([
			{ id: 'fallback', model: '5.6 Sol', effort: 'high', fast: false, description: 'Fallback.' },
			{ id: 'included', model: '5.6 Luna', description: 'Cheap.' }
		])
		expect(JSON.stringify(config)).not.toContain('Do not leak.')
		for (const fallback of ['absent', 'excluded', 'empty', 'role'])
			expect(() => f.store.routing.write({ ...globals(), fallback })).toThrow('Choose an existing fallback profile.')
		f.save(f.store.read().agents.filter(a => a.name !== 'fallback'))
		expect(() => f.store.autoModel.read()).toThrow('Choose an existing fallback profile.')
		expect(f.store.routing.read().fallback).toBe('fallback')
	})

	test('supports 32 routable agents and retains existing unavailable-fallback messages', () => {
		const f = fixture()
		f.save(Array.from({ length: 32 }, (_, n) => ({ name: `agent-${n}`, model: '5.6 Sol', description: 'Task.' })))
		f.store.routing.write({ ...globals(), fallback: 'agent-0' })
		expect(f.store.autoModel.read().profiles).toHaveLength(32)
		expect(() => freezeAutoModelConfig(f.store.autoModel.read(), [])).toThrow(
			'Auto’s fallback model is unavailable. Update Auto settings.'
		)
	})

	test('Auto PATCH upserts profiles, clears removed descriptions, and keeps role files, bodies and unknown frontmatter', () => {
		const f = fixture()
		f.save([
			{ name: 'kept', model: '5.6 Sol', description: 'Old.', preamble: '# Keep body\n' },
			{ name: 'removed', model: '5.6 Sol', description: 'Remove description.' },
			{ name: 'disabled', model: '5.6 Sol', description: 'Keep opt-out.', routing: false },
			{ name: 'role', model: '5.6 Terra', preamble: 'Role only.' }
		])
		fs.writeFileSync(f.file('kept'), '---\nmodel: 5.6 Sol\ndescription: Old.\ntools:\n  - Read\n---\n# Keep body\n')
		f.store.routing.write({ ...globals(), fallback: 'kept' })
		const saved = f.store.autoModel.write({
			...globals(),
			defaultAuto: true,
			fallback: 'new',
			profiles: [
				{ id: 'kept', model: '5.6 Luna', fast: false, description: 'New description.' },
				{ id: 'new', model: '5.6 Sol', description: 'New profile.' }
			]
		})
		expect(saved.defaultAuto).toBe(true)
		expect(saved.profiles.map(p => p.id)).toEqual(['kept', 'new'])
		expect(f.readFile('kept')).toContain('tools:\n  - Read\n')
		expect(f.store.roles.read().config.roles.kept).toMatchObject({
			model: '5.6 Luna',
			fast: false,
			preamble: '# Keep body\n'
		})
		expect(f.store.read().agents.find(a => a.name === 'removed')?.description).toBeUndefined()
		expect(f.store.read().agents.find(a => a.name === 'disabled')).toMatchObject({
			description: 'Keep opt-out.',
			routing: false
		})
		expect(fs.readdirSync(f.directory)).toEqual(['disabled.md', 'kept.md', 'new.md', 'removed.md', 'role.md'])
		// Legacy editors can explicitly re-include an opted-out file.
		f.store.autoModel.write({
			...saved,
			profiles: [...saved.profiles, { id: 'disabled', model: '5.6 Sol', description: 'Enabled.' }]
		})
		expect(f.store.autoModel.read().profiles.map(p => p.id)).toContain('disabled')
	})

	test('routing validation isolates router/fallback issues and rejects profiles in globals', () => {
		const agents = [
			{ name: 'fallback', model: '5.6 Sol', description: 'Fallback.' },
			{ name: 'optional', model: 'missing', description: 'Unavailable.' }
		]
		const config = { ...globals(), fallback: 'fallback' }
		const catalog = [{ agentType: 'codex', models: ['5.6 Luna', '5.6 Sol'], updatedAt: 1 }]
		expect(routingIssues(config, agents, catalog)).toEqual([])
		expect(routingIssues({ ...config, fallback: 'optional' }, agents, catalog)).toEqual([
			expect.stringContaining('profile_optional')
		])
		expect(routingIssues({ ...config, router: { model: 'Fable 5' } }, agents, catalog)[0]).toContain('router supports')
		expect(() => decodeRoutingConfig({ ...config, profiles: [] })).toThrow()
	})
})
