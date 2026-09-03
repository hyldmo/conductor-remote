import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DelegationStore, type PersistedDelegation } from '../src/delegations.ts'

const temporaryDirs: string[] = []

function testStore(): { store: DelegationStore; worktree: string } {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-delegations-'))
	temporaryDirs.push(worktree)
	return { store: new DelegationStore(worktree), worktree }
}

function job(overrides: Partial<PersistedDelegation> = {}): PersistedDelegation {
	return {
		version: 1,
		id: 'job-1',
		workspaceId: 'workspace-1',
		parentSessionId: 'parent-1',
		role: 'exploration',
		resolvedRole: { model: '5.6 Terra', agentType: 'codex', effort: 'high', fast: false },
		prompt: 'Inspect the queue contract.',
		returnMode: 'queue',
		includeThinking: true,
		status: 'queued',
		attempts: 0,
		createdAt: 100,
		updatedAt: 100,
		...overrides
	}
}

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('worktree delegation store', () => {
	test('round-trips jobs and session roles in the ignored worktree directory', () => {
		const { store, worktree } = testStore()
		store.put(job())
		store.assign('parent-1', { role: 'planning', assignedAt: 90 })
		store.assign('child-1', { role: 'exploration', delegationId: 'job-1', assignedAt: 110 })

		expect(store.list()).toEqual({ jobs: [job()], warnings: [] })
		expect(store.sessionRoles()).toEqual({
			sessions: {
				'parent-1': { role: 'planning', assignedAt: 90 },
				'child-1': { role: 'exploration', delegationId: 'job-1', assignedAt: 110 }
			}
		})
		const directory = path.join(worktree, '.context', 'delegations')
		expect(fs.statSync(path.join(directory, 'job-1.json')).mode & 0o777).toBe(0o600)
		expect(fs.statSync(path.join(directory, 'sessions.json')).mode & 0o777).toBe(0o600)
	})

	test('loads valid jobs beside malformed ones and never erases bad state', () => {
		const { store, worktree } = testStore()
		store.put(job())
		const directory = path.join(worktree, '.context', 'delegations')
		const malformed = path.join(directory, 'bad.json')
		const unsupported = path.join(directory, 'future.json')
		fs.writeFileSync(malformed, '{oops')
		fs.writeFileSync(unsupported, JSON.stringify({ ...job({ id: 'future' }), version: 2 }))

		const result = new DelegationStore(worktree).list()
		expect(result.jobs).toEqual([job()])
		expect(result.warnings).toHaveLength(2)
		expect(fs.existsSync(malformed)).toBe(true)
		expect(fs.existsSync(unsupported)).toBe(true)
	})

	test('enforces the fields required by each persisted stage', () => {
		const { store } = testStore()
		expect(() => store.put(job({ status: 'configuring' }))).toThrow(/childSessionId/)
		expect(() => store.put(job({ status: 'running', childSessionId: 'child-1' }))).toThrow(/sentRowid/)
		expect(() => store.put(job({ status: 'returning', childSessionId: 'child-1', sentRowid: 22 }))).toThrow(/outcome/)
		expect(() => store.put(job({ status: 'failed' }))).toThrow(/failure/)
	})

	test('rejects traversal ids before touching the filesystem', () => {
		const { store, worktree } = testStore()
		expect(() => store.put(job({ id: '../outside' }))).toThrow(/id/)
		expect(fs.existsSync(path.join(worktree, '.context'))).toBe(false)
	})

	test('deletes a completed job explicitly without deleting role identity', () => {
		const { store } = testStore()
		store.put(job())
		store.assign('child-1', { role: 'exploration', delegationId: 'job-1', assignedAt: 110 })

		expect(store.remove('job-1')).toBe(true)
		expect(store.list().jobs).toEqual([])
		expect(store.sessionRoles().sessions['child-1']?.role).toBe('exploration')
		expect(store.remove('job-1')).toBe(false)
	})

	test('reports a malformed session-role file without replacing it', () => {
		const { store, worktree } = testStore()
		const directory = path.join(worktree, '.context', 'delegations')
		fs.mkdirSync(directory, { recursive: true })
		const file = path.join(directory, 'sessions.json')
		fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: {} }))

		const result = store.sessionRoles()
		expect(result).toMatchObject({ sessions: {}, warning: expect.stringContaining('version') })
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2)
	})
})
