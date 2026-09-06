import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { stateDir } from '../../src/config.ts'
import { createDeliveryServices } from '../../src/http/services/delivery.ts'
import type { SessionRow, Workspace } from '../../src/reads/types.ts'
import { newChat } from '../../src/writes/chats.ts'
import { configureSharedUiLeaseProvider, uiQueueDepth, uiTurn } from '../../src/writes/ui-lock.ts'

vi.mock('../../src/config.ts', async importOriginal => ({
	...(await importOriginal<typeof import('../../src/config.ts')>()),
	stateDir: vi.fn(() => '/tmp/conductor-remote-open-chat-tests')
}))
vi.mock('../../src/writes/chats.ts', () => ({ newChat: vi.fn() }))

const directories: string[] = []
afterEach(() => {
	configureSharedUiLeaseProvider(null)
	vi.resetAllMocks()
	vi.useRealTimers()
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
	vi.useFakeTimers()
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'open-chat-test-'))
	directories.push(worktree)
	vi.mocked(stateDir).mockReturnValue(worktree)
	const workspace = { id: 'ws', worktree, branch: 'test' } as Workspace
	const sessions = [{ id: 'existing' }] as SessionRow[]
	const listSessions = vi.fn(() => [...sessions])
	const delivery = createDeliveryServices({
		reads: { listSessions },
		actuator: { name: 'test' },
		sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
	} as unknown as Parameters<typeof createDeliveryServices>[0])
	vi.mocked(newChat).mockImplementation(() => uiTurn(async () => ({ ok: true, strategy: 'applescript' })))
	return { ...delivery, workspace, sessions, listSessions }
}

describe('new chat receipts', () => {
	test('serializes baseline, shortcut and receipt across concurrent opens and other UI work', async () => {
		const f = fixture()
		const release = vi.fn()
		const acquire = vi.fn(async () => ({ markMayExecute: vi.fn(), release }))
		configureSharedUiLeaseProvider({ acquire })
		let sequence = 0
		vi.mocked(newChat).mockImplementation(() =>
			uiTurn(async () => {
				const id = `new-${++sequence}`
				setTimeout(() => f.sessions.push({ id } as SessionRow), 750)
				return { ok: true, strategy: 'applescript' }
			})
		)
		const first = f.openChat(f.workspace)
		const second = f.openChat(f.workspace)
		const nextWrite = vi.fn(async () => {})
		const waiting = uiTurn(nextWrite)
		await vi.advanceTimersByTimeAsync(500)
		expect(newChat).toHaveBeenCalledTimes(1)
		expect(nextWrite).not.toHaveBeenCalled()
		expect(release).not.toHaveBeenCalled()
		await vi.runAllTimersAsync()
		expect(await first).toEqual({ sessionId: 'new-1' })
		expect(await second).toEqual({ sessionId: 'new-2' })
		await waiting
		expect(acquire).toHaveBeenCalledTimes(3)
		expect(release).toHaveBeenCalledTimes(3)
		expect(uiQueueDepth()).toEqual({ busy: false, waiting: 0 })
	})

	test('takes its baseline only after a preceding UI operation releases the lease', async () => {
		const f = fixture()
		const previous = uiTurn(async () => {
			await new Promise(resolve => setTimeout(resolve, 500))
			f.sessions.push({ id: 'someone-elses-tab' } as SessionRow)
		})
		vi.mocked(newChat).mockImplementation(() =>
			uiTurn(async () => {
				f.sessions.push({ id: 'mine' } as SessionRow)
				return { ok: true, strategy: 'applescript' }
			})
		)
		const opened = f.openChat(f.workspace)
		expect(f.listSessions).not.toHaveBeenCalled()
		await vi.runAllTimersAsync()
		await previous
		expect(await opened).toEqual({ sessionId: 'mine' })
	})

	test('recovers a late chat receipt after the shortcut script reports an error', async () => {
		const f = fixture()
		vi.mocked(newChat).mockImplementation(() =>
			uiTurn(async () => {
				setTimeout(() => f.sessions.push({ id: 'accepted' } as SessionRow), 1_000)
				return { ok: false, strategy: 'applescript', error: 'timed out after the shortcut' }
			})
		)
		const opened = f.openChat(f.workspace)
		await vi.runAllTimersAsync()
		expect(await opened).toEqual({ sessionId: 'accepted' })
		expect(newChat).toHaveBeenCalledTimes(1)
	})

	test.each([true, false])('an unconfirmed shortcut fails without automatic replay (script ok=%s)', async ok => {
		const f = fixture()
		vi.mocked(newChat).mockResolvedValue({ ok, strategy: 'applescript', ...(ok ? {} : { error: 'timed out' }) })
		const opened = f.openChat(f.workspace)
		await vi.runAllTimersAsync()
		expect(await opened).toMatchObject({
			error: true,
			retryable: false,
			result: { ok: false, error: ok ? expect.stringContaining('did not confirm a new chat') : 'timed out' }
		})
		expect(newChat).toHaveBeenCalledTimes(1)
		expect(uiQueueDepth().busy).toBe(false)
	})

	test('refuses multiple fresh rows instead of selecting the newest', async () => {
		const f = fixture()
		vi.mocked(newChat).mockImplementation(async () => {
			f.sessions.push({ id: 'one' } as SessionRow, { id: 'two' } as SessionRow)
			return { ok: true, strategy: 'applescript' }
		})
		const opened = f.openChat(f.workspace)
		await vi.runAllTimersAsync()
		expect(await opened).toMatchObject({
			error: true,
			retryable: false,
			result: { error: expect.stringContaining('refusing to guess') }
		})
	})
})
