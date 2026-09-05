import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ModelCache } from '../src/model-cache.ts'
import { currentModelCatalog, newestModelSnapshot } from '../src/shared.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
	vi.useRealTimers()
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('model cache', () => {
	test('normalizes labels, separates harnesses, and persists across restarts', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		const cache = new ModelCache(file)

		cache.remember('claude', ['Opus 5 NEW', 'Sonnet 4.6'], 'Opus 5 NEW')
		cache.rememberModel('claude', 'Opus 5')
		cache.remember('codex', ['GPT-5.4'])
		cache.rememberDefault('GPT-5.4')

		const groups = cache.list()
		expect(groups.find(group => group.agentType === 'claude')?.models).toEqual(['Opus 5', 'Sonnet 4.6'])
		expect(groups.map(group => group.agentType)).toEqual(['claude', 'codex'])
		expect(cache.defaultModel()).toBe('GPT-5.4')
		expect(groups.every(group => group.defaultModel === 'GPT-5.4')).toBe(true)
		expect(new ModelCache(file).list()).toEqual(groups)
	})

	test('loads a pre-default cache and learns the star on its next live read', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		fs.writeFileSync(file, JSON.stringify([{ agentType: 'codex', models: ['5.6 Sol'], updatedAt: 1 }]))

		const cache = new ModelCache(file)
		expect(cache.defaultModel()).toBeUndefined()
		cache.remember('codex', ['5.6 Sol', '5.6 Terra'], '5.6 Sol')
		expect(cache.defaultModel()).toBe('5.6 Sol')
	})

	test('does not let a single learned model shadow the newest complete picker snapshot', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		const cache = new ModelCache(file)

		cache.remember('claude', ['Fable 5.1', '5.6 Sol', '5.6 Terra'])
		cache.rememberModel('codex', '5.6 Sol')
		cache.rememberModel('codex', '5.6 Terra')

		const groups = cache.list()
		expect(groups.find(entry => entry.agentType === 'codex')?.snapshotAt).toBeNull()
		expect(newestModelSnapshot(groups)?.models).toEqual(['5.6 Sol', '5.6 Terra', 'Fable 5.1'])
		expect(newestModelSnapshot(new ModelCache(file).list())?.models).toEqual(['5.6 Sol', '5.6 Terra', 'Fable 5.1'])
	})

	test('keeps provider menus independent across restarts and retires renamed labels within their provider', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		const spark = 'opencode-go/muse-spark-1.3-contributor'
		fs.writeFileSync(
			file,
			JSON.stringify([
				{ agentType: 'claude', models: ['Fable 5', '5.6 Sol'], updatedAt: 1 },
				{ agentType: 'codex', models: ['Fable 5.1', '5.6 Sol'], snapshotAt: 2, updatedAt: 2 },
				{ agentType: 'acp', models: [spark], updatedAt: 3 }
			])
		)
		const cache = new ModelCache(file)
		expect(currentModelCatalog(cache.list())).toEqual(['5.6 Sol', 'Fable 5.1', spark])
		cache.remember('acp', [spark])
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual(['5.6 Sol', 'Fable 5.1', spark])
	})

	test('a legacy selected row cannot erase other choices from the same provider', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		const first = 'opencode/model-a'
		const second = 'opencode/model-b'
		fs.writeFileSync(
			file,
			JSON.stringify([
				{ agentType: 'codex', models: [first, second], snapshotAt: 1, updatedAt: 1 },
				{ agentType: 'acp', models: [first], updatedAt: 2 }
			])
		)
		const cache = new ModelCache(file)
		expect(currentModelCatalog(cache.list())).toEqual([first, second])
		cache.rememberModel('acp', first)
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual([first, second])
		// Only a real later menu can establish that the second choice has disappeared.
		cache.remember('acp', [first])
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual([first])
	})

	test('a selected model adds evidence without replacing a menu, and a later menu can retire it', () => {
		const menu = { models: ['5.6 Sol', '5.6 Terra'], snapshotAt: 2, updatedAt: 2 }
		const selected = { models: ['5.6 Astra'], snapshotAt: null, updatedAt: 3 }
		expect(currentModelCatalog([menu, selected])).toEqual(['5.6 Astra', '5.6 Sol', '5.6 Terra'])
		expect(currentModelCatalog([{ ...menu, snapshotAt: 4, updatedAt: 4 }, selected])).toEqual(['5.6 Sol', '5.6 Terra'])
	})

	test('a selection after a newer menu is usable without reviving earlier selections after restart', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		const cache = new ModelCache(file)
		vi.useFakeTimers()
		vi.setSystemTime(1)
		cache.remember('codex', ['Fable 5', '5.6 Sol'])
		vi.setSystemTime(2)
		cache.rememberModel('codex', 'Fable 5')
		vi.setSystemTime(3)
		cache.remember('claude', ['Fable 5.1', '5.6 Sol'])
		vi.setSystemTime(4)
		cache.rememberModel('codex', 'Fable 5.2')
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual(['5.6 Sol', 'Fable 5.1', 'Fable 5.2'])
		vi.setSystemTime(5)
		cache.remember('claude', ['Fable 5.1', '5.6 Sol'])
		vi.setSystemTime(6)
		cache.rememberModel('codex', '5.6 Terra')
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual(['5.6 Sol', '5.6 Terra', 'Fable 5.1'])
	})

	test('learning a provider absent from a saved menu cannot imply its other choices disappeared', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-cache-'))
		temporaryDirectories.push(directory)
		const file = path.join(directory, 'models.json')
		fs.writeFileSync(file, JSON.stringify([{ agentType: 'legacy', models: ['5.6 Sol', '5.6 Terra'], updatedAt: 1 }]))
		const cache = new ModelCache(file)
		vi.useFakeTimers()
		vi.setSystemTime(2)
		cache.remember('codex', ['Fable 5.1'])
		vi.setSystemTime(3)
		cache.rememberModel('codex', '5.6 Sol')
		expect(currentModelCatalog(new ModelCache(file).list())).toEqual(['5.6 Sol', '5.6 Terra', 'Fable 5.1'])
	})
})
