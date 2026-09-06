import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { stateDir } from '../../../src/config.ts'
import type { ConductorDb } from '../../../src/db.ts'
import { createDelegationsServices } from '../../../src/http/services/delegations.ts'
import { createDeliveryServices } from '../../../src/http/services/delivery.ts'
import { delegatedPrompt, writeDelegatedAssignment } from '../../../src/orchestration/delegation/prompt.ts'
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
	test.each([
		false,
		true
	])('keeps Unicode on disk and survives every socket split and restart (interrupted=%s)', async interrupted => {
		const f = fixture()
		f.job.prompt = `${'Inspect the delivery path. '.repeat(400)}globals → routing.json; café; 日本語; 🧪`
		f.job.resolvedRole.preamble = 'Respect ÆØÅ and return the requested résumé → 🧪.'
		const inline = delegatedPrompt(f.job)
		f.job.assignment = writeDelegatedAssignment(f.job, f.worktree)
		const assignment = f.job.assignment
		const body = fs.readFileSync(path.join(f.worktree, assignment.path), 'utf8')
		expect(body).toContain(inline)
		expect(body).toContain(JSON.stringify(f.job.handoff!.path))
		const text = delegatedPrompt(f.job)
		expect(Buffer.byteLength(text)).toBe(text.length)
		expect(text.length).toBeLessThan(500)
		f.send.mockImplementationOnce(async (target, actual) => {
			// Check durability before the first external action, then reproduce the
			// runtime's per-chunk decoding at every possible transport boundary.
			expect(f.store.get(f.job.id)?.assignment).toEqual(assignment)
			const bytes = Buffer.from(JSON.stringify({ message: actual }))
			for (let split = 1; split < bytes.length; split++) {
				const decoded = JSON.parse(bytes.subarray(0, split).toString() + bytes.subarray(split).toString()).message
				expect(decoded).toBe(text)
			}
			f.accept('unicode-assignment', target.sessionId as string, actual)
			if (interrupted) throw new Error('disconnected after acceptance')
			return { ok: true, strategy: 'test' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		vi.setSystemTime(Date.now() + 10_000)
		const resumed = f.createQueue()
		resumed.resume([new DelegationStore(f.worktree)])
		await resumed.wake()
		expect(f.send).toHaveBeenCalledTimes(1)
		f.promote('unicode-assignment')
		await resumed.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 1, assignment })
		expect(fs.readFileSync(path.join(f.worktree, assignment.path), 'utf8')).toBe(body)
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('retains the assignment reference when an altered bootstrap must be correlated after restart', async () => {
		const f = fixture()
		f.job.assignment = writeDelegatedAssignment(f.job, f.worktree)
		f.store.put({
			...f.job,
			status: 'failed',
			sendDelivery: { rowid: 0, outboxIds: [] },
			failure: { code: 'send_failed', message: 'disconnected', retryable: true }
		})
		f.accept('altered-bootstrap', f.child.id, `${delegatedPrompt(f.job)}changed`)
		const queue = f.createQueue()
		queue.resume([f.store])
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({
			status: 'failed',
			sendDelivery: { messageId: 'altered-bootstrap' },
			failure: { code: 'delivery_altered', retryable: false }
		})
		expect(f.send).not.toHaveBeenCalled()
	})

	test.each([
		'outbox',
		'message',
		'error',
		'interrupted'
	])('never resends a UTF-8-corrupted assignment accepted via %s', async mode => {
		const f = fixture()
		f.job.prompt = 'globals → routing.json, legacy files untouched'
		f.send.mockImplementationOnce(async (target, text) => {
			// Reproduce Conductor decoding a socket chunk inside the three-byte arrow.
			const bytes = Buffer.from(JSON.stringify({ message: text }))
			const split = bytes.indexOf(Buffer.from('→')) + 2
			const corrupted = JSON.parse(bytes.subarray(0, split).toString() + bytes.subarray(split).toString()).message
			expect(corrupted).toBe(text.replace('→', '��'))
			f.accept('corrupted', target.sessionId as string, corrupted)
			if (mode === 'message') f.promote('corrupted')
			if (mode === 'interrupted') throw new Error('interrupted after acceptance')
			return { ok: mode !== 'error', strategy: 'test', ...(mode === 'error' ? { error: 'timed out' } : {}) }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		vi.setSystemTime(Date.now() + 10_000)
		const resumed = f.createQueue()
		resumed.resume([f.store])
		await resumed.wake()
		expect(f.store.get(f.job.id)).toMatchObject({
			status: 'failed',
			sendDelivery: { messageId: 'corrupted' },
			failure: {
				code: 'delivery_altered',
				retryable: false,
				message: expect.stringContaining('not be resent automatically')
			}
		})
		await resumed.wake()
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test('checks integrity again when an accepted outbox id is promoted', async () => {
		const f = fixture()
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		f.promote('sent-1')
		f.db.prepare("UPDATE session_messages SET content = content || 'changed' WHERE id = 'sent-1'").run()
		await queue.wake()
		expect(f.store.get(f.job.id)?.failure?.code).toBe('delivery_altered')
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test.each([false, true])('reconciles a late receipt after terminal send failure (altered=%s)', async altered => {
		const f = fixture()
		const queue = f.createQueue()
		f.store.put({
			...f.job,
			status: 'failed',
			attempts: 3,
			sendDelivery: { rowid: 0, outboxIds: [] },
			failure: { code: 'send_failed', message: 'No matching receipt', retryable: true }
		})
		queue.resume([f.store])
		await queue.wake()
		expect(f.store.get(f.job.id)?.status).toBe('failed')
		f.accept('late-receipt', f.child.id, delegatedPrompt(f.job) + (altered ? 'changed' : ''))
		f.promote('late-receipt')
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject(
			altered
				? { status: 'failed', failure: { code: 'delivery_altered' }, sendDelivery: { messageId: 'late-receipt' } }
				: { status: 'running', sentRowid: 1 }
		)
		expect(f.send).not.toHaveBeenCalled()
	})

	test('does not adopt an older corrupted message promoted from the baseline outbox', async () => {
		const f = fixture()
		f.accept('older-corrupted', f.child.id, `${delegatedPrompt(f.job)}changed`)
		f.send.mockImplementationOnce(async (target, text) => {
			f.promote('older-corrupted')
			f.accept('new', target.sessionId as string, text)
			f.promote('new')
			return { ok: true, strategy: 'test' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, f.job)
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({ status: 'running', sentRowid: 2 })
		expect(f.send).toHaveBeenCalledTimes(1)
	})

	test.each([false, true])('reconciles a failed return without sending again (altered=%s)', async altered => {
		const f = fixture()
		const job = returningJob(f, 'queue')
		const text = `Report: ${job.handoff!.token}`
		f.store.put({
			...job,
			status: 'failed',
			attempts: 3,
			returnText: text,
			returnAttachment: job.handoff,
			returnCursor: 0,
			returnDelivery: { rowid: 0, outboxIds: [] },
			failure: { code: 'return_failed', message: 'No matching receipt', retryable: true }
		})
		f.accept('late-return', job.parentSessionId, text + (altered ? 'changed' : ''))
		f.promote('late-return')
		const queue = f.createQueue()
		queue.resume([f.store])
		await queue.wake()
		if (altered) {
			expect(f.store.get(job.id)).toMatchObject({
				status: 'failed',
				failure: { code: 'delivery_altered' },
				returnDelivery: { messageId: 'late-return' }
			})
		} else {
			expect(f.store.get(job.id)).toBeNull()
		}
		expect(f.send).not.toHaveBeenCalled()
	})

	test.each(['steer', 'queue'] as const)('never resends a changed %s completion notice', async mode => {
		const f = fixture()
		f.send.mockImplementationOnce(async (target, text) => {
			f.accept('changed-return', target.sessionId as string, `${text}changed`)
			return { ok: false, strategy: 'test', error: 'timed out after acceptance' }
		})
		const queue = f.createQueue()
		queue.enqueue(f.store, returningJob(f, mode))
		await queue.wake()
		expect(f.store.get(f.job.id)).toMatchObject({
			status: 'failed',
			returnDelivery: { messageId: 'changed-return' },
			failure: { code: 'delivery_altered', retryable: false }
		})
		await queue.wake()
		expect(f.send).toHaveBeenCalledTimes(1)
	})

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
