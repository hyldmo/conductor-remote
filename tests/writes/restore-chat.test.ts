import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ConductorDb } from '../../src/db.ts'
import { Reads } from '../../src/reads/repository.ts'
import { isLockedError } from '../../src/shared.ts'
import { restoreChat } from '../../src/writes/chats.ts'
import { uiQueueDepth, uiTurn } from '../../src/writes/ui-lock.ts'

// Never dispatch a real deep link or touch the Mac's UI in this suite.
const { execute } = vi.hoisted(() => ({
	execute: vi.fn<(command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))
vi.mock('node:child_process', async importOriginal => {
	const original = await importOriginal<typeof import('node:child_process')>()
	const execFile = vi.fn()
	Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: execute })
	return { ...original, execFile }
})

describe('closed session reads', () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, model TEXT, agent_type TEXT,
			created_at TEXT, updated_at TEXT, is_hidden INTEGER
		);
	`)
	const reads = new Reads(
		{
			query: (sql: string, params: never[] = []) => sqlite.prepare(sql).all(...params)
		} as ConductorDb,
		'/unused',
		() => {
			throw new Error('Closed tabs must not scan live agent processes')
		}
	)
	beforeEach(() => sqlite.exec('DELETE FROM sessions'))
	afterAll(() => sqlite.close())

	test('returns only hidden chats in this workspace, newest activity first across timestamp formats', () => {
		const insert = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		for (const [id, workspace, updatedAt, hidden] of [
			['older', 'ws', '2026-09-05T09:00:00.000Z', 1],
			['newer', 'ws', '2026-09-05 10:00:00', 1],
			['other-workspace', 'other', '2026-09-05 11:00:00', 1],
			['open', 'ws', '2026-09-05 12:00:00', 0],
			['legacy-open', 'ws', '2026-09-05 13:00:00', null]
		]) {
			insert.run(id, workspace, 'Same title', 'gpt-5.6-sol', 'codex', '2026-09-01 00:00:00', updatedAt, hidden)
		}
		expect(reads.listClosedSessions('ws').map(session => session.id)).toEqual(['newer', 'older'])
		expect(reads.listClosedSessions('missing')).toEqual([])
		// No transcript tables exist: this picker stays a lightweight metadata read.
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE is_hidden = 1').get()).toEqual({ n: 3 })
	})

	test('removes a restored chat from the closed snapshot without deleting its row', () => {
		sqlite.exec(`INSERT INTO sessions (id, workspace_id, is_hidden) VALUES ('chat', 'ws', 1)`)
		expect(reads.listClosedSessions('ws')).toHaveLength(1)
		// Simulate Conductor's own unhide write using the fixture's separate writable handle.
		sqlite.exec(`UPDATE sessions SET is_hidden = 0 WHERE id = 'chat'`)
		expect(reads.listClosedSessions('ws')).toEqual([])
		expect(reads.sessionWorkspaceId('chat')).toBe('ws')
	})
})

describe('restore chat actuator', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		execute.mockReset()
		execute.mockImplementation(async command => ({ stdout: command === 'osascript' ? 'unlocked' : '', stderr: '' }))
	})
	afterEach(() => vi.useRealTimers())

	test('addresses the exact workspace and chat and holds the UI lease until the database confirms it', async () => {
		let visible = false
		const restored = restoreChat('workspace /?=&', 'chat /?=&', () => visible)
		await vi.advanceTimersByTimeAsync(0)
		const openCall = execute.mock.calls.find(([command]) => command === 'open')
		expect(openCall).toBeDefined()
		const url = new URL(openCall?.[1][0] ?? '')
		expect(url.protocol).toBe('conductor:')
		expect(url.host).toBe('workspace')
		expect(url.pathname).toBe('')
		expect([...url.searchParams]).toEqual([
			['id', 'workspace /?=&'],
			['session', 'chat /?=&']
		])
		const nextWrite = vi.fn(async () => {})
		const waiting = uiTurn(nextWrite)
		expect(nextWrite).not.toHaveBeenCalled()
		expect(uiQueueDepth()).toMatchObject({ busy: true, waiting: 1 })
		visible = true
		await vi.runAllTimersAsync()
		expect(await restored).toMatchObject({ ok: true })
		await waiting
		expect(nextWrite).toHaveBeenCalledOnce()
		expect(uiQueueDepth()).toMatchObject({ busy: false, waiting: 0 })
	})

	test('a retry for a tab already restored needs no UI, even while the Mac is locked', async () => {
		expect(await restoreChat('ws', 'chat', () => true)).toMatchObject({ ok: true, alreadyOpen: true })
		expect(execute).not.toHaveBeenCalled()
	})

	test('rechecks after a concurrent restore instead of dispatching the same deep link twice', async () => {
		let visible = false
		const first = restoreChat('ws', 'chat', () => visible)
		const second = restoreChat('ws', 'chat', () => visible)
		await vi.advanceTimersByTimeAsync(0)
		visible = true
		await vi.runAllTimersAsync()
		expect(await first).toMatchObject({ ok: true })
		expect(await second).toMatchObject({ ok: true, alreadyOpen: true })
		expect(execute.mock.calls.filter(([command]) => command === 'open')).toHaveLength(1)
	})

	test('a locked Mac returns an actionable refusal without opening or launching Conductor', async () => {
		execute.mockResolvedValue({ stdout: 'locked', stderr: '' })
		const result = await restoreChat('ws', 'chat', () => false)
		expect(result.ok).toBe(false)
		expect(isLockedError(result.error)).toBe(true)
		expect(execute.mock.calls.map(([command]) => command)).toEqual(['osascript'])
	})

	test('opening a link is not success if the exact tab stays hidden', async () => {
		const result = restoreChat('ws', 'chat', () => false)
		await vi.runAllTimersAsync()
		expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('has not restored') })
		expect(execute.mock.calls.filter(([command]) => command === 'open')).toHaveLength(1)
		expect(uiQueueDepth().busy).toBe(false)
	})

	test('a failed deep link releases the UI for the next action', async () => {
		execute.mockImplementation(async command => {
			if (command === 'open') throw new Error('No application knows how to open this URL')
			return { stdout: 'unlocked', stderr: '' }
		})
		expect(await restoreChat('ws', 'chat', () => false)).toMatchObject({ ok: false })
		expect(uiQueueDepth().busy).toBe(false)
	})
})
