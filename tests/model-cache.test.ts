import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ModelCache } from '../src/model-cache.ts'
import { newestModelSnapshot } from '../src/shared.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
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
})
