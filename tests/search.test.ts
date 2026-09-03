import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ConductorDb } from '../src/db.ts'
import { Reads } from '../src/reads.ts'
import { matchQuery, SearchIndex } from '../src/search.ts'

/**
 * The match grammar (src/search.ts ▸ matchQuery), which decides whether a search
 * finds the sentence someone remembers. Both of its failure modes are silent and
 * look like "no results": an expression FTS5 refuses to parse surfaces as an error
 * the pane reads as an empty index, and an OR-of-common-words query buries the one
 * chunk holding the exact phrase under every chunk that merely uses the words a lot
 * — the live bug this file pins ("may i run the" matched nothing anyone wanted).
 * The ranking half runs against a real in-memory FTS5 table rather than string
 * asserts alone, because the string can be right and the semantics still wrong.
 */

describe('matchQuery', () => {
	test('nothing searchable is null, not an FTS5 error', () => {
		expect(matchQuery('')).toBeNull()
		expect(matchQuery('   ')).toBeNull()
		expect(matchQuery('""')).toBeNull()
		expect(matchQuery('“”')).toBeNull()
		expect(matchQuery('- * : ( )')).toBeNull()
	})

	test('a single word keeps the old shape: quoted, prefix from three characters', () => {
		expect(matchQuery('lamp')).toBe('"lamp"*')
		expect(matchQuery('la')).toBe('"la"')
		expect(matchQuery('lamp ')).toBe('"lamp"')
	})

	test('several words add one phrase term beside the OR tokens', () => {
		expect(matchQuery('manual lamp ')).toBe('("manual lamp" OR "manual" OR "lamp")')
		expect(matchQuery('may i run the')).toBe('("may i run the"* OR "may" OR "i" OR "run" OR "the"*)')
	})

	test('a quoted phrase is required, loose words stay OR', () => {
		expect(matchQuery('"race condition"')).toBe('"race condition"')
		expect(matchQuery('"race condition" parked')).toBe('"race condition" AND "parked"*')
		expect(matchQuery('fix "race condition" parked queue')).toBe(
			'"race condition" AND ("fix" OR "parked queue"* OR "parked" OR "queue"*)'
		)
	})

	test('curly quotes count — iOS smart punctuation sends “” for the quote key', () => {
		expect(matchQuery('“race condition” parked')).toBe('"race condition" AND "parked"*')
	})

	test('an unclosed quote is the phrase still being typed, prefix and all', () => {
		expect(matchQuery('"may i run')).toBe('"may i run"*')
		expect(matchQuery('"may i ru')).toBe('"may i ru"')
	})

	test('a leading closed empty quote does not flip which segments count as quoted', () => {
		// The report that started this: `""may i run the` — two quotes, then the phrase.
		expect(matchQuery('""may i run the')).toBe('("may i run the"* OR "may" OR "i" OR "run" OR "the"*)')
	})
})

describe('matchQuery against real FTS5', () => {
	const db = new DatabaseSync(':memory:')
	db.exec("CREATE VIRTUAL TABLE chunks USING fts5(body, tokenize='porter unicode61')")
	const insert = db.prepare('INSERT INTO chunks(body) VALUES (?)')
	// One chunk holds the exact sentence; the others use the same words more often.
	insert.run('The controls are the correct local path. May I run the separate stop check?')
	insert.run('Running the headless artifact render. The first run may do a full import, and the run may repeat.')
	insert.run('The build is still running. The CI run may not have triggered, and the retry may run the same way.')
	insert.run('A parked prompt survives a race condition in the queue.')
	const search = (raw: string): string[] => {
		const match = matchQuery(raw)
		if (!match) return []
		return (
			db.prepare('SELECT body FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks)').all(match) as {
				body: string
			}[]
		).map(r => r.body)
	}

	test('every expression parses, hostile input included', () => {
		const inputs = [
			'may i run the',
			'"may i run the',
			'""may i run the',
			'“may i run the”',
			"can't fix the drawer",
			'NEAR AND OR NOT',
			'foo* -bar :baz (qux',
			'a "b" c "d e" f',
			'🙂 "🙂 ok"'
		]
		for (const raw of inputs) expect(() => search(raw), raw).not.toThrow()
	})

	test('the exact sentence outranks the chunks that merely use its words', () => {
		expect(search('may i run the')[0]).toContain('May I run the separate stop check')
	})

	test('a quoted phrase drops every chunk that lacks it', () => {
		expect(search('"may i run the" ')).toHaveLength(1)
		expect(search('"race condition" parked')).toHaveLength(1)
	})

	test('stemming still applies inside quotes', () => {
		expect(search('"running the headless" ')).toHaveLength(1)
	})
})

describe('SearchIndex.search scoped to a chat list', () => {
	/**
	 * The repo filter reaches the index as a list of chat ids, and it has to narrow the
	 * *ranking*, not the rows handed back: the chunk limit is spent before any
	 * post-filter runs, so a dense chat outside the scope would take the slot and the
	 * in-scope hit would fold up to nothing. Pinned with a limit of one, where the two
	 * behaviours give different answers.
	 */
	const row = (rowid: number, session_id: string, content: string) => ({
		rowid,
		id: `m${rowid}`,
		session_id,
		role: 'user',
		content,
		full_message: null,
		created_at: `2026-09-02 10:00:0${rowid}`,
		sent_at: `2026-09-02 10:00:0${rowid}`,
		queue_order: null
	})
	const rows = [
		row(1, 'busy', 'lamp lamp lamp lamp lamp'),
		row(2, 'quiet', 'the lamp is on the desk'),
		row(3, 'other', 'nothing about lights here')
	]
	// Only the three source queries `SearchIndex` makes, told apart by shape.
	const source = {
		query<T>(sql: string, params: unknown[] = []): T[] {
			if (sql.includes('MAX(rowid)')) return [{ m: rows.length }] as T[]
			if (sql.startsWith('SELECT rowid FROM session_messages')) {
				const [after, limit] = params as [number, number]
				return rows
					.filter(r => r.rowid > after)
					.slice(0, limit)
					.map(r => ({ rowid: r.rowid })) as T[]
			}
			const [after, end] = params as [number, number]
			return rows.filter(r => r.rowid > after && r.rowid <= end) as T[]
		}
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-search-'))
	const index = new SearchIndex(source as unknown as ConductorDb, path.join(dir, 'search.db'))

	beforeAll(async () => {
		index.start()
		const deadline = Date.now() + 5000
		while (!index.status().ready) {
			if (Date.now() > deadline) throw new Error('index never caught up')
			await new Promise(r => setTimeout(r, 10))
		}
	})
	afterAll(() => {
		index.stop()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const sessions = (raw: string, opts?: { limit?: number; sessionIds?: string[] }) =>
		index.search(raw, opts).map(h => h.sessionId)

	test('unscoped, the dense chat wins the only slot', () => {
		expect(sessions('lamp', { limit: 1 })).toEqual(['busy'])
	})

	test('scoped, the slot goes to the chat in scope rather than to nothing', () => {
		expect(sessions('lamp', { limit: 1, sessionIds: ['quiet'] })).toEqual(['quiet'])
		expect(sessions('lamp', { sessionIds: ['quiet', 'other'] })).toEqual(['quiet'])
	})

	test('an empty list matches nothing, never everything', () => {
		expect(sessions('lamp', { sessionIds: [] })).toEqual([])
	})

	test('no list at all is the old unscoped search', () => {
		expect(sessions('lamp')).toEqual(['busy', 'quiet'])
	})
})

describe('workspace search scope', () => {
	const raw = new DatabaseSync(':memory:')
	raw.exec(`
		CREATE TABLE repos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			icon TEXT,
			root_path TEXT,
			remote_url TEXT
		);
		CREATE TABLE workspaces (
			id TEXT PRIMARY KEY,
			workspace_name TEXT,
			pr_title TEXT,
			branch TEXT,
			directory_name TEXT,
			state TEXT,
			updated_at TEXT NOT NULL,
			repository_id TEXT
		);
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			workspace_id TEXT
		);
		INSERT INTO repos VALUES
			('repo-1', 'one', NULL, NULL, NULL),
			('repo-2', 'two', NULL, NULL, NULL);
		INSERT INTO workspaces VALUES
			('live', 'Lamp current', NULL, 'feat/lamp', 'lamp-v1', 'ready', '2026-09-02', 'repo-1'),
			('archived', 'Lamp old', NULL, 'fix/lamp', 'lamp-v2', 'archived', '2026-09-01', 'repo-1'),
			('unknown', 'Lamp unknown', NULL, 'try/lamp', 'lamp-v3', NULL, '2026-08-31', 'repo-2');
		INSERT INTO sessions VALUES
			('live-chat', 'live'),
			('archived-chat', 'archived'),
			('unknown-chat', 'unknown');
	`)
	const db = {
		query<T>(sql: string, params: unknown[] = []): T[] {
			return raw.prepare(sql).all(...(params as never[])) as T[]
		}
	} as unknown as ConductorDb
	const reads = new Reads(db, '/unused')
	const ids = (values: string[]) => [...values].sort()
	afterAll(() => raw.close())

	test('keeps archived chats in the default scope', () => {
		expect(ids(reads.searchSessionIds(undefined, true))).toEqual(['archived-chat', 'live-chat', 'unknown-chat'])
	})

	test('excludes only archived chats before full-text ranking', () => {
		expect(ids(reads.searchSessionIds(undefined, false))).toEqual(['live-chat', 'unknown-chat'])
		expect(reads.searchSessionIds(['one'], false)).toEqual(['live-chat'])
	})

	test('applies the same archive scope to workspace-name matches', () => {
		expect(reads.findWorkspacesByName(['lamp']).map(w => w.id)).toContain('archived')
		expect(reads.findWorkspacesByName(['lamp'], 20, undefined, false).map(w => w.id)).toEqual(
			expect.arrayContaining(['live', 'unknown'])
		)
		expect(reads.findWorkspacesByName(['lamp'], 20, undefined, false).map(w => w.id)).not.toContain('archived')
		expect(reads.findWorkspacesByName(['lamp'], 20, ['one'], false).map(w => w.id)).toEqual(['live'])
	})
})
