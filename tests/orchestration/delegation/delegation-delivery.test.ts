import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { stateDir } from '../../../src/config.ts'
import type { ConductorDb } from '../../../src/db.ts'
import { createDelegationsServices } from '../../../src/http/services/delegations.ts'
import { createDeliveryServices } from '../../../src/http/services/delivery.ts'
import { delegatedPrompt } from '../../../src/orchestration/delegation/prompt.ts'
import { DelegationStore } from '../../../src/orchestration/delegation/store.ts'
import type { PersistedDelegation } from '../../../src/orchestration/delegation/types.ts'
import { MessageReads } from '../../../src/reads/messages.ts'
import type { Reads } from '../../../src/reads/repository.ts'
import { SessionPoller } from '../../../src/reads/session-poller.ts'
import type { SessionRow, Workspace } from '../../../src/reads/types.ts'
import { attachmentTokens } from '../../../src/shared.ts'
import type { Actuator } from '../../../src/writes/types.ts'

vi.mock('../../../src/config.ts', async importOriginal => ({
	...(await importOriginal<typeof import('../../../src/config.ts')>()),
	stateDir: vi.fn(() => '/tmp/conductor-remote-delegation-tests')
}))

const cleanup: (() => void)[] = []

afterEach(() => {
	for (const close of cleanup.splice(0)) close()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

function fixture() {
	vi.useFakeTimers({ toFake: ['Date'] })
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-delivery-'))
	vi.mocked(stateDir).mockReturnValue(worktree)
	const db = new DatabaseSync(':memory:')
	cleanup.push(() => {
		db.close()
		fs.rmSync(worktree, { recursive: true, force: true })
	})
	db.exec(`
		CREATE TABLE session_messages (
			id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
			full_message TEXT, created_at TEXT, sent_at TEXT, queue_order INTEGER, turn_id TEXT
		);
		CREATE TABLE session_messages_outbox (
			message_id TEXT PRIMARY KEY, session_id TEXT, delivery_payload TEXT,
			created_at TEXT, mode TEXT, queue_order INTEGER
		);
	`)
	const ws = { id: 'workspace-1', worktree, branch: 'test-delegation' } as Workspace
	const child = { id: 'child-1', status: 'working', background_tasks: [] } as unknown as SessionRow
	const parent = { id: 'parent-1', status: 'working', background_tasks: [] } as unknown as SessionRow
	const messages = new MessageReads(
		{
			query: (sql: string, params: never[] = []) =>
				sql.includes('FROM sessions s') ? [] : db.prepare(sql).all(...params)
		} as unknown as ConductorDb,
		worktree
	)
	const reads = Object.assign(messages, {
		getWorkspace: () => ws,
		getSession: (id: string) => (id === child.id ? child : parent),
		listSessions: () => [parent, child]
	}) as unknown as Reads
	const store = new DelegationStore(worktree)
	function accept(id: string, sessionId: string, text: string) {
		db.prepare('INSERT INTO session_messages_outbox VALUES (?, ?, ?, ?, ?, ?)').run(
			id,
			sessionId,
			JSON.stringify({ message: text }),
			new Date().toISOString(),
			'queue',
			1
		)
	}
	function promote(id: string) {
		db.exec('BEGIN')
		db.prepare(`
			INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, turn_id)
			SELECT message_id, session_id, 'user', json_extract(delivery_payload, '$.message'),
				created_at, created_at, message_id FROM session_messages_outbox WHERE message_id = ?
		`).run(id)
		db.prepare('DELETE FROM session_messages_outbox WHERE message_id = ?').run(id)
		db.exec('COMMIT')
	}
	let dispatches = 0
	const send = vi.fn<Actuator['send']>(async (target, text) => {
		accept(`sent-${++dispatches}`, target.sessionId as string, text)
		return { ok: true, strategy: 'test' }
	})
	const actuator: Actuator = { name: 'test', caveat: '', precise: true, send }
	const delivery = createDeliveryServices({
		reads,
		actuator,
		sleep: async (ms: number) => {
			vi.setSystemTime(Date.now() + ms)
		}
	} as Parameters<typeof createDeliveryServices>[0])
	const createQueue = () =>
		createDelegationsServices({
			...delivery,
			reads,
			actuator,
			sessionPoller: new SessionPoller(() => []),
			delegationStore: () => new DelegationStore(worktree)
		}).delegationQueue
	const job: PersistedDelegation = {
		version: 1,
		id: 'job-1',
		workspaceId: ws.id,
		parentSessionId: parent.id,
		childSessionId: child.id,
		role: 'exploration',
		resolvedRole: { model: '5.6 Terra', agentType: 'codex' },
		prompt: 'Inspect this task.',
		returnMode: 'steer',
		includeThinking: false,
		status: 'sending',
		attempts: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		handoff: {
			name: 'Transcript.md',
			path: '.context/attachments/ABC123/Transcript.md',
			bytes: 100,
			token: '@⟦Transcript.md⟧(.context%2Fattachments%2FABC123%2FTranscript.md)'
		}
	}
	return { db, reads, store, send, delivery, createQueue, job, accept, promote, child, worktree }
}

function returningJob(f: ReturnType<typeof fixture>, returnMode: 'queue' | 'steer'): PersistedDelegation {
	f.accept('assignment', f.job.childSessionId as string, delegatedPrompt(f.job))
	f.promote('assignment')
	return {
		...f.job,
		status: 'returning',
		returnMode,
		sentRowid: 1,
		outcome: { kind: 'success', assistantRowid: 2, text: 'The task is complete.' }
	}
}

describe('delegation delivery receipts', () => {
	test('keeps an accepted child prompt pending across retries and restart until that id is dispatched', async () => {
		const f = fixture()
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'sending', attempts: 0 })
		for (let tick = 0; tick < 4; tick++) {
			vi.setSystemTime(Date.now() + 10_000)
			await queue.wake()
		}
		const resumed = f.createQueue()
		resumed.resume([f.store])
		await resumed.wake()
		expect(f.send).toHaveBeenCalledTimes(1)
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'sending', attempts: 0 })
		f.promote('sent-1')
		await resumed.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 1, attempts: 0 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('persists the original outbox boundary before sending and excludes an older identical prompt', async () => {
		const f = fixture()
		const text = delegatedPrompt(f.job)
		f.accept('older-copy', f.child.id, text)
		f.send.mockImplementationOnce(async (target, sent) => {
			expect(f.store.get(f.job.id)?.sendDelivery).toEqual({ rowid: 0, outboxIds: ['older-copy'] })
			f.promote('older-copy')
			f.accept('new-copy', target.sessionId as string, sent)
			return { ok: true, strategy: 'test' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'sending', sendDelivery: { messageId: 'new-copy' } })
		f.promote('new-copy')
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 2 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('does not substitute a later identical message for the accepted queued id', async () => {
		const f = fixture()
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		f.accept('later-copy', f.child.id, delegatedPrompt(f.job))
		f.promote('later-copy')
		await queue.wake()
		expect(f.store.get(f.job.id)?.status).toBe('sending')
		f.promote('sent-1')
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 2 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('recovers an accepted send after interruption before its receipt could be saved', async () => {
		const f = fixture()
		f.send.mockImplementationOnce(async (target, text) => {
			f.accept('interrupted-send', target.sessionId as string, text)
			throw new Error('interrupted after Conductor accepted the prompt')
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({
			status: 'sending',
			attempts: 1,
			sendDelivery: { rowid: 0, outboxIds: [] }
		})
		vi.setSystemTime(Date.now() + 10_000)
		const resumed = f.createQueue()
		resumed.resume([f.store])
		await resumed.wake()
		expect(f.store.get(f.job.id)?.sendDelivery?.messageId).toBe('interrupted-send')
		f.promote('interrupted-send')
		await resumed.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 1 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('reports a cancelled accepted message without sending it again', async () => {
		const f = fixture()
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		f.db.prepare('DELETE FROM session_messages_outbox WHERE message_id = ?').run('sent-1')
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({
			status: 'failed',
			failure: { code: 'send_failed', retryable: false, message: expect.stringContaining('removed') }
		})
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('accepts a prompt that goes straight into the transcript', async () => {
		const f = fixture()
		f.send.mockImplementationOnce(async (target, text) => {
			f.accept('immediate', target.sessionId as string, text)
			f.promote('immediate')
			return { ok: true, strategy: 'test' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 1, attempts: 0 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test.each([
		'steer',
		'queue'
	] as const)('returns a %s result once and follows its accepted id across restart', async mode => {
		const f = fixture()
		const finalReply = 'Context before the Baton.\n\n## Baton\nThe task is complete.\n'
		const job = returningJob(f, mode)
		job.outcome = { kind: 'success', assistantRowid: 2, text: finalReply }
		for (const [id, text] of [
			['completion', finalReply],
			['followup', 'A later reply.']
		]) {
			f.db
				.prepare('INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
				.run(id, f.child.id, 'assistant', text, new Date().toISOString())
		}
		f.send.mockImplementationOnce(async (target, text) => {
			const prepared = f.store.get(f.job.id)
			expect(prepared?.returnDelivery).toEqual({ rowid: 0, outboxIds: [] })
			expect(prepared?.returnText).toBe(text)
			f.accept('sent-1', target.sessionId as string, text)
			return { ok: true, strategy: 'test' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, job)
		await queue.wake()
		const pending = f.store.get(f.job.id)
		expect(pending).toMatchObject({ status: 'returning', attempts: 0, returnDelivery: { messageId: 'sent-1' } })
		expect(f.send.mock.calls[0]?.[2]?.queue).toBe(mode === 'queue')
		expect(f.send.mock.calls[0]?.[1]).toBe(pending?.returnText)
		const report = fs.readFileSync(path.join(f.worktree, pending!.returnAttachment!.path), 'utf8')
		expect(report.endsWith(finalReply)).toBe(true)
		expect(report).not.toContain('A later reply.')
		expect(pending!.returnText).not.toContain(finalReply)
		expect(attachmentTokens(pending!.returnText!)).toMatchObject([{ path: pending!.returnAttachment!.path }])
		// Following an accepted receipt only needs the saved report, even if the worktree stops resolving.
		f.reads.getWorkspace(job.workspaceId)!.worktree = null
		const resumed = f.createQueue()
		resumed.resume([f.store])
		for (let tick = 0; tick < 4; tick++) {
			vi.setSystemTime(Date.now() + 10_000)
			await resumed.wake()
		}
		expect(f.store.get(f.job.id)?.returnAttachment).toEqual(pending?.returnAttachment)
		f.promote('sent-1')
		await resumed.wake()
		expect(f.store.get(f.job.id)).toBeNull()
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('recognizes a queued result despite an actuator error after acceptance', async () => {
		const f = fixture()
		f.send.mockImplementationOnce(async (target, text) => {
			f.accept('accepted-with-error', target.sessionId as string, text)
			return { ok: false, strategy: 'test', error: 'timed out after pressing Enter' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, returningJob(f, 'queue'))
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'returning', attempts: 0 })
		f.promote('accepted-with-error')
		await queue.wake()
		expect(f.store.get(f.job.id)).toBeNull()
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('preserves a legacy queued result with no database receipt until its row appears', async () => {
		const f = fixture()
		f.send.mockResolvedValue({ ok: true, strategy: 'test' })
		const queue = f.createQueue()
		queue.enqueue(f.store, returningJob(f, 'queue'))
		await queue.wake()
		const pending = f.store.get(f.job.id)
		expect(pending).toMatchObject({ status: 'returning', attempts: 0, returnDelivery: { accepted: true } })
		const resumed = f.createQueue()
		resumed.resume([f.store])
		await resumed.wake()
		f.accept('late-legacy-return', f.job.parentSessionId, pending?.returnText as string)
		await resumed.wake()
		expect(f.store.get(f.job.id)?.returnDelivery?.messageId).toBe('late-legacy-return')
		f.promote('late-legacy-return')
		await resumed.wake()
		expect(f.store.get(f.job.id)).toBeNull()
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('resumes a pending return saved by an older relay without resending', async () => {
		const f = fixture()
		const job = returningJob(f, 'queue')
		const queue = f.createQueue()
		queue.enqueue(f.store, {
			...job,
			returnCursor: 0,
			returnAttachment: job.handoff,
			returnText: 'Previously accepted result'
		})
		await queue.wake()
		f.accept('old-relay-return', job.parentSessionId, 'Previously accepted result')
		f.promote('old-relay-return')
		await queue.wake()
		expect(f.store.get(job.id)).toBeNull()
		expect(f.send).not.toHaveBeenCalled()
	})

	test('recovers a receipt from a caller-supplied cursor before invoking the actuator', async () => {
		const f = fixture()
		const before = f.reads.deliveryCursor(f.child.id)
		const text = delegatedPrompt(f.job)
		f.accept('already-accepted', f.child.id, text)
		const result = await f.delivery.deliverPrompt(
			f.reads.getWorkspace(f.job.workspaceId) as Workspace,
			f.child.id,
			text,
			55_000,
			false,
			before
		)
		expect(result).toMatchObject({ ok: true, attempts: 0, receipt: { kind: 'outbox', id: 'already-accepted' } })
		expect(f.send).not.toHaveBeenCalled()
	})
})
