import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	AutoModelConfigStore,
	autoModelIssues,
	DEFAULT_AUTO_MODEL_CONFIG,
	decodeAutoModelConfig,
	freezeAutoModelConfig
} from '../../src/agents/auto-model/config.ts'
import { chooseAutoModel, routingInput } from '../../src/agents/auto-model/decision.ts'
import { codexRouterId, routerCommand, routerOutput } from '../../src/agents/auto-model/provider.ts'
import { AutoModelQueue, type AutoQueueDeps } from '../../src/agents/auto-model/queue.ts'
import type { AutoModelDecision } from '../../src/agents/auto-model/types.ts'
import { attachmentToken } from '../../src/files/attachments.ts'
import type { CachedModelGroup } from '../../src/wire.ts'

const directories: string[] = []
const temp = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-model-test-'))
	directories.push(dir)
	return dir
}
afterEach(() => {
	vi.useRealTimers()
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const config = () => structuredClone(DEFAULT_AUTO_MODEL_CONFIG)
const catalog = (): CachedModelGroup[] => [
	{ agentType: 'codex', models: config().profiles.map(p => p.model), updatedAt: 1 }
]
const choice: AutoModelDecision = {
	model: '5.6 Luna',
	effort: 'low',
	fast: false,
	profile: 'quick',
	reason: 'A bounded local edit.',
	fallback: false,
	durationMs: 12
}
const input = { prompt: 'Move this button left.', images: [], incomplete: false }

describe('Auto model decisions', () => {
	test('validates exact labels, both Muse choices, profile uniqueness, and fallback', () => {
		expect(autoModelIssues(config(), catalog())).toEqual([])
		for (const model of ['opencode-go/muse-spark-1.3-contributor', 'opencode/muse-spark-1.3-contributor-free']) {
			const groups = catalog()
			groups[0].models.push(model)
			expect(autoModelIssues({ ...config(), router: { model } }, groups)).toEqual([])
		}
		expect(() => decodeAutoModelConfig({ ...config(), fallback: 'absent' })).toThrow('fallback')
		expect(() =>
			decodeAutoModelConfig({ ...config(), profiles: [config().profiles[0], config().profiles[0]] })
		).toThrow('unique')
		expect(() => decodeAutoModelConfig({ ...config(), router: { model: '5.6 Luna', plan: true } })).toThrow()
		const collision = {
			...config(),
			router: { model: 'missing' },
			profiles: [{ ...config().profiles[0], id: 'router' }],
			fallback: 'router'
		}
		expect(autoModelIssues(collision, catalog()).length).toBeGreaterThan(0)
	})
	test('freezes available profiles and requires the router and fallback', () => {
		const groups = catalog()
		groups[0].models = groups[0].models.filter(model => model !== 'GPT-6 Astra')
		const frozen = freezeAutoModelConfig(config(), groups)
		expect(frozen.profiles.some(p => p.id === 'deep')).toBe(false)
		groups[0].models = groups[0].models.filter(model => model !== '5.6 Sol')
		expect(() => freezeAutoModelConfig(config(), groups)).toThrow('fallback')
	})
	test('settings persist independently and a corrupt document never silently resets', () => {
		const file = path.join(temp(), 'auto-model.json')
		const store = new AutoModelConfigStore(file)
		expect(store.read()).toEqual(config())
		store.write({ ...config(), defaultAuto: true })
		expect(new AutoModelConfigStore(file).read().defaultAuto).toBe(true)
		fs.writeFileSync(file, 'broken')
		expect(() => store.read()).toThrow('could not be read')
	})
	test('the router returns only a profile; configured settings win', async () => {
		const run = vi.fn(async (_prompt: string) =>
			JSON.stringify({ profile: 'quick', reason: 'Small local edit.', missingContext: false })
		)
		const result = await chooseAutoModel(config(), input, run)
		expect(result).toMatchObject({ model: '5.6 Luna', effort: 'low', fast: false, fallback: false })
		expect(run.mock.calls[0][0]).toContain('Move this button left.')
	})
	test.each([
		'not json',
		JSON.stringify({ profile: 'invented', reason: 'Easy.', missingContext: false }),
		JSON.stringify({ profile: 'quick', reason: 'Easy.', missingContext: false, model: 'GPT-6 Astra' }),
		JSON.stringify({ profile: 'quick', reason: 'Cannot see the screenshot.', missingContext: true })
	])('uses the configured fallback for an unusable answer: %s', async answer => {
		expect(await chooseAutoModel(config(), input, async () => answer)).toMatchObject({
			model: '5.6 Sol',
			fallback: true
		})
	})
	test('bounds a hung router and aborts it', async () => {
		vi.useFakeTimers()
		let signal: AbortSignal | undefined
		const result = chooseAutoModel(config(), input, async (_prompt, _images, abort) => {
			signal = abort
			return new Promise(() => undefined)
		})
		await vi.advanceTimersByTimeAsync(15_000)
		expect(await result).toMatchObject({ fallback: true })
		expect(signal?.aborted).toBe(true)
	})
	test('reads only submitted files, carries images, and detects escapes and missing context', () => {
		const root = temp()
		const attachments = path.join(root, '.context/attachments/abc123')
		fs.mkdirSync(attachments, { recursive: true })
		fs.writeFileSync(path.join(attachments, 'note.txt'), 'Change only the margin.')
		fs.writeFileSync(path.join(attachments, 'screen.png'), 'fake image')
		fs.writeFileSync(path.join(root, 'secret.txt'), 'not supplied')
		const note = attachmentToken('note.txt', '.context/attachments/abc123/note.txt')
		const image = attachmentToken('screen.png', '.context/attachments/abc123/screen.png')
		const result = routingInput(`${note}\n${image}\nMove this`, 'repo', root)
		expect(result.incomplete).toBe(false)
		expect(result.prompt).toContain('Change only the margin.')
		expect(result.prompt).not.toContain('not supplied')
		expect(result.images).toHaveLength(1)
		fs.symlinkSync(path.join(root, 'secret.txt'), path.join(attachments, 'escape.txt'))
		expect(
			routingInput(attachmentToken('escape.txt', '.context/attachments/abc123/escape.txt'), 'repo', root).incomplete
		).toBe(true)
		expect(routingInput('x'.repeat(32_001), 'repo', root).incomplete).toBe(true)
	})
	test('missing context bypasses the classifier', async () => {
		const run = vi.fn()
		expect(await chooseAutoModel(config(), { ...input, incomplete: true }, run)).toMatchObject({ fallback: true })
		expect(run).not.toHaveBeenCalled()
	})
	test('CLI requests are isolated and parse only final text events', () => {
		const codex = routerCommand(config().router, 'prompt', ['/tmp/image.png'], temp())
		expect(codexRouterId('GPT-6 Astra')).toBe('gpt-6-astra')
		expect(codex.args).toEqual(
			expect.arrayContaining([
				'--ephemeral',
				'--ignore-user-config',
				'--ignore-rules',
				'features.shell_tool=false',
				'features.apps=false'
			])
		)
		expect(codex.stdin).toBe('prompt')
		const muse = routerCommand({ model: 'opencode/muse-spark-1.3-contributor-free' }, 'prompt', [], temp())
		expect(muse.args).toContain('--pure')
		expect(
			JSON.parse(fs.readFileSync(muse.env.OPENCODE_CONFIG as string, 'utf8')).agent['auto-model-router'].permission
		).toEqual({ '*': 'deny' })
		expect(
			routerOutput(
				JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"profile":"quick"}' } }),
				'codex'
			)
		).toBe('{"profile":"quick"}')
		expect(routerOutput(JSON.stringify({ type: 'text', part: { type: 'text', text: 'answer' } }), 'opencode')).toBe(
			'answer'
		)
		expect(() => routerOutput('{"type":"turn.failed"}', 'codex')).toThrow()
	})
})

function queueFixture() {
	const directory = temp()
	let now = 1000
	const deps = {
		inspect: vi.fn<AutoQueueDeps['inspect']>(() => ({
			sessionId: 'session',
			ready: true,
			worktree: '/unused/worktree'
		})),
		locked: vi.fn(async () => false),
		choose: vi.fn(async () => choice),
		deliver: vi.fn(async () => ({ ok: true, error: undefined as string | undefined, blocked: false })),
		materialize: vi.fn(),
		cursor: vi.fn(() => ({ rowid: 0, outboxIds: [] as string[] })),
		received: vi.fn(() => false),
		now: () => now
	} satisfies AutoQueueDeps
	const queue = new AutoModelQueue(directory, deps)
	const accept = () =>
		queue.accept({
			workspaceId: 'workspace',
			sessionId: 'session',
			repo: 'repo',
			text: 'Move the button.',
			config: config()
		})
	return {
		queue,
		deps,
		accept,
		directory,
		advance: () => {
			now += 6000
		}
	}
}

describe('Auto submission ownership', () => {
	test('a chat started manually releases Auto instead of trapping the controls behind a hidden failure', async () => {
		const f = queueFixture()
		f.accept()
		f.deps.inspect.mockReturnValue({
			ready: true,
			sessionId: 'session',
			obsolete: true,
			error: 'The chat has already started.'
		})
		await f.queue.tick()
		expect(f.queue.state('session', 'workspace')?.status).toBe('cancelled')
		expect(f.queue.pending()).toHaveLength(0)
		expect(f.deps.choose).not.toHaveBeenCalled()
		expect(f.deps.deliver).not.toHaveBeenCalled()
	})
	test('saves the choice before sending and resumes without rerouting', async () => {
		const f = queueFixture()
		f.accept()
		f.deps.deliver.mockImplementation(async () => {
			expect(new AutoModelQueue(f.directory, f.deps).get('session')?.decision).toEqual(choice)
			return { ok: false, error: 'busy', blocked: false }
		})
		await f.queue.tick()
		f.advance()
		const restarted = new AutoModelQueue(f.directory, f.deps)
		await restarted.tick()
		expect(f.deps.choose).toHaveBeenCalledTimes(1)
		expect(f.deps.deliver).toHaveBeenCalledTimes(2)
	})
	test('recovers a send receipt after a restart before any settings or classifier call', async () => {
		const f = queueFixture()
		f.accept()
		await f.queue.tick()
		// Model an exit after Conductor accepted but before the job was marked delivered.
		const job = f.queue.get('session')!
		job.status = 'waiting'
		fs.writeFileSync(path.join(f.directory, `${job.id}.json`), JSON.stringify(job))
		f.deps.received.mockReturnValue(true)
		f.deps.choose.mockClear()
		f.deps.deliver.mockClear()
		await new AutoModelQueue(f.directory, f.deps).tick()
		expect(f.queue.get('session')?.status).toBe('delivered')
		expect(f.deps.choose).not.toHaveBeenCalled()
		expect(f.deps.deliver).not.toHaveBeenCalled()
	})
	test('duplicate intake reuses one submission and a different prompt conflicts', () => {
		const f = queueFixture()
		expect(f.accept().id).toBe(f.accept().id)
		expect(f.queue.list()).toHaveLength(1)
		expect(() =>
			f.queue.accept({ workspaceId: 'workspace', sessionId: 'session', repo: '', text: 'Different', config: config() })
		).toThrow('already has')
	})
	test('a cancellation during selection prevents the late decision and send', async () => {
		const f = queueFixture()
		f.accept()
		f.deps.choose.mockImplementation(async () => {
			f.queue.cancel('session')
			return choice
		})
		await f.queue.tick()
		expect(f.queue.get('session')?.status).toBe('cancelled')
		expect(f.deps.deliver).not.toHaveBeenCalled()
	})
	test('independent queue instances share the classifier lease', async () => {
		const f = queueFixture()
		f.accept()
		f.deps.choose.mockImplementation(async () => {
			await new AutoModelQueue(f.directory, f.deps).tick()
			return choice
		})
		await f.queue.tick()
		expect(f.deps.choose).toHaveBeenCalledTimes(1)
		expect(f.deps.deliver).toHaveBeenCalledTimes(1)
	})
	test('lock waits spend no attempts and three unlocked failures stay visible with a reusable choice', async () => {
		const f = queueFixture()
		f.accept()
		f.deps.locked.mockResolvedValue(true)
		await f.queue.tick()
		expect(f.queue.pending()[0]).toMatchObject({
			attempts: 0,
			reason: 'Waiting for the Mac to unlock',
			autoModel: true
		})
		f.deps.locked.mockResolvedValue(false)
		f.deps.deliver.mockResolvedValue({ ok: false, error: 'busy', blocked: false })
		for (let n = 0; n < 3; n++) {
			f.advance()
			await f.queue.tick()
		}
		expect(f.queue.pending()[0].status).toBe('failed')
		f.accept()
		await f.queue.tick()
		expect(f.deps.choose).toHaveBeenCalledTimes(1)
	})
	test('empty workspace intents do not classify before a message arrives', async () => {
		const f = queueFixture()
		f.queue.accept({ workspaceId: 'workspace', sessionId: 'session', repo: '', text: '', config: config() })
		await f.queue.tick()
		expect(f.queue.state('session', 'workspace')?.status).toBe('draft')
		expect(f.deps.choose).not.toHaveBeenCalled()
		f.accept()
		await f.queue.tick()
		expect(f.deps.choose).toHaveBeenCalledTimes(1)
	})
})
