import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import type { ConductorDb } from '../../src/db.ts'
import { Reads } from '../../src/reads/repository.ts'

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		status TEXT,
		title TEXT,
		model TEXT,
		permission_mode TEXT,
		claude_effort_level TEXT,
		codex_thinking_level TEXT,
		fast_mode INTEGER,
		agent_type TEXT,
		context_used_percent FLOAT,
		unread_count INTEGER,
		created_at TEXT,
		updated_at TEXT,
		last_user_message_at TEXT,
		workspace_id TEXT,
		is_hidden INTEGER DEFAULT 0
	);
	CREATE TABLE session_messages (
		id TEXT PRIMARY KEY,
		session_id TEXT,
		role TEXT,
		content TEXT,
		created_at TEXT,
		sent_at TEXT,
		queue_order INTEGER,
		turn_id TEXT
	);
	CREATE TABLE workspaces (
		id TEXT PRIMARY KEY,
		state TEXT,
		workspace_name TEXT,
		pr_title TEXT,
		branch TEXT,
		directory_name TEXT,
		repository_id TEXT
	);
	CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT);
`)

const db = {
	query<T>(sql: string, params: unknown[] = []): T[] {
		return sqlite.prepare(sql).all(...(params as never[])) as T[]
	}
} as ConductorDb

const reads = new Reads(db, '/unused', () => new Map())

function addSession(id: string): void {
	sqlite
		.prepare(
			`INSERT INTO sessions
			 (id, status, title, created_at, updated_at, workspace_id)
			 VALUES (?, 'working', ?, '2026-09-03T11:00:00.000Z', '2026-09-03T11:00:00.000Z', 'workspace')`
		)
		.run(id, id)
}

function addMessage({
	id,
	sessionId,
	role,
	sentAt,
	turnId,
	queueOrder = null
}: {
	id: string
	sessionId: string
	role: 'user' | 'assistant'
	sentAt: string | null
	turnId: string | null
	queueOrder?: number | null
}): void {
	sqlite
		.prepare(
			`INSERT INTO session_messages
			 (id, session_id, role, content, created_at, sent_at, queue_order, turn_id)
			 VALUES (?, ?, ?, '', ?, ?, ?, ?)`
		)
		.run(id, sessionId, role, sentAt ?? '2026-09-03T12:10:00.000Z', sentAt, queueOrder, turnId)
}

beforeEach(() => {
	sqlite.exec('DELETE FROM session_messages; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM repos;')
	sqlite
		.prepare(
			`INSERT INTO workspaces
			 (id, state, workspace_name, branch, directory_name, repository_id)
			 VALUES ('workspace', 'ready', 'Timer test', 'test/timer', 'timer-test', 'repo')`
		)
		.run()
	sqlite.prepare("INSERT INTO repos (id, name) VALUES ('repo', 'conductor-remote')").run()
})

afterAll(() => sqlite.close())

describe('turn start reads', () => {
	test('uses the first user message in the latest dispatched turn', () => {
		addSession('current')
		addMessage({
			id: 'head',
			sessionId: 'current',
			role: 'user',
			sentAt: '2026-09-03T12:00:00.000Z',
			turnId: 'turn-1'
		})
		addMessage({
			id: 'progress',
			sessionId: 'current',
			role: 'assistant',
			sentAt: '2026-09-03T12:00:10.000Z',
			turnId: 'turn-1'
		})
		addMessage({
			id: 'steer',
			sessionId: 'current',
			role: 'user',
			sentAt: '2026-09-03T12:01:00.000Z',
			turnId: 'turn-1'
		})
		addMessage({
			id: 'more-progress',
			sessionId: 'current',
			role: 'assistant',
			sentAt: '2026-09-03T12:02:00.000Z',
			turnId: 'turn-1'
		})

		expect(reads.listSessions('workspace')[0]?.turn_started_at).toBe('2026-09-03T12:00:00.000Z')
		expect(reads.listSessionStates()[0]?.turnStartedAt).toBe('2026-09-03T12:00:00.000Z')
	})

	test('ignores a queued next turn and a later self-started lap', () => {
		addSession('queued')
		addMessage({
			id: 'head',
			sessionId: 'queued',
			role: 'user',
			sentAt: '2026-09-03T12:00:00.000Z',
			turnId: 'turn-1'
		})
		addMessage({
			id: 'self-started-lap',
			sessionId: 'queued',
			role: 'assistant',
			sentAt: '2026-09-03T12:05:00.000Z',
			turnId: 'turn-2'
		})
		addMessage({ id: 'queued-next', sessionId: 'queued', role: 'user', sentAt: null, turnId: 'turn-3' })

		expect(reads.listSessions('workspace')[0]?.turn_started_at).toBe('2026-09-03T12:00:00.000Z')
		expect(reads.listSessionStates()[0]?.turnStartedAt).toBe('2026-09-03T12:00:00.000Z')

		sqlite.prepare("UPDATE session_messages SET sent_at = '2026-09-03T12:10:00.000Z' WHERE id = 'queued-next'").run()
		expect(reads.listSessions('workspace')[0]?.turn_started_at).toBe('2026-09-03T12:10:00.000Z')
		expect(reads.listSessionStates()[0]?.turnStartedAt).toBe('2026-09-03T12:10:00.000Z')
	})

	test('falls back to queue_order for messages without turn ids', () => {
		addSession('legacy')
		addMessage({
			id: 'legacy-head',
			sessionId: 'legacy',
			role: 'user',
			sentAt: '2026-05-01T08:30:00.000Z',
			turnId: null,
			queueOrder: 0
		})

		expect(reads.listSessions('workspace')[0]?.turn_started_at).toBe('2026-05-01T08:30:00.000Z')
		expect(reads.listSessionStates()[0]?.turnStartedAt).toBe('2026-05-01T08:30:00.000Z')
	})
})
