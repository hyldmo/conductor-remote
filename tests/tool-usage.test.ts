import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { ConductorDb } from '../src/db.ts'
import { readToolUsage, ToolUsageAccumulator } from '../src/tool-usage.ts'
import { ToolUsageService } from '../src/tool-usage-service.ts'

function frame(blocks: unknown[], parent?: string) {
	return JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: blocks } })
}
const call = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content })

describe('tool traffic accounting', () => {
	test('joins results by ID, combines calls by name, and ranks by inputs plus results', () => {
		const accumulator = new ToolUsageAccumulator()
		accumulator.add({ rowid: 1, role: 'assistant', content: frame([result('read1', 'x'.repeat(4000))]), in_range: 1 })
		accumulator.add({
			rowid: 2,
			role: 'assistant',
			content: frame([call('read1', 'Read'), call('read2', 'Read'), call('edit1', 'Edit')]),
			in_range: 1
		})
		accumulator.add({
			rowid: 3,
			role: 'assistant',
			content: frame([result('read2', 'short'), result('edit1', 'done')]),
			in_range: 1
		})
		const tools = accumulator.tools()
		expect(tools.map(tool => tool.name)).toEqual(['Read', 'Edit'])
		expect(tools[0].calls).toBe(2)
		expect(tools[0].outputTokens).toBeGreaterThan(1000)
		expect(tools[0].inputTokens + tools[0].outputTokens).toBe(tools[0].totalTokens)
		expect(tools[0].largestCallTokens).toBeGreaterThan(tools[0].totalTokens / 2)
		expect(tools[0].largestCallTokens).toBeLessThan(tools[0].totalTokens)
	})

	test('counts duplicate snapshots once and keeps the fullest saved result', () => {
		const accumulator = new ToolUsageAccumulator()
		for (const [index, block] of [
			call('id', 'Read'),
			result('id', 'short'),
			call('id', 'Read'),
			result('id', 'x'.repeat(4000)),
			result('id', 'short')
		].entries()) {
			accumulator.add({ rowid: index, role: 'assistant', content: frame([block]), in_range: 1 })
		}
		expect(accumulator.tools()[0]).toMatchObject({ name: 'Read', calls: 1 })
		expect(accumulator.tools()[0].outputTokens).toBeGreaterThan(1000)
		expect(accumulator.tools()[0].outputTokens).toBeLessThan(1100)
	})

	test('keeps prior call names without charging their earlier input and retains unlinked results', () => {
		const accumulator = new ToolUsageAccumulator()
		accumulator.add({
			rowid: 1,
			role: 'assistant',
			content: frame([call('old', 'Bash', { command: 'x'.repeat(4000) })]),
			in_range: 0
		})
		accumulator.add({
			rowid: 2,
			role: 'assistant',
			content: frame([result('old', 'done'), result('missing', 'orphan')]),
			in_range: 1
		})
		expect(accumulator.tools().find(tool => tool.name === 'Bash')).toMatchObject({ calls: 1, inputTokens: 0 })
		expect(accumulator.tools().find(tool => tool.name === null)?.outputTokens).toBeGreaterThan(0)
	})

	test('ignores mirrored child internals, malformed frames, ordinary JSON, and binary image bytes', () => {
		const accumulator = new ToolUsageAccumulator()
		for (const [index, content] of [
			frame([call('child', 'ChildOnly')], 'agent-parent'),
			'{broken',
			JSON.stringify({ task: 'tool_use', input: 'not a frame' }),
			frame([
				call('image', 'Screenshot'),
				result('image', [{ type: 'image', source: { type: 'base64', data: 'x'.repeat(100_000) } }])
			])
		].entries())
			accumulator.add({ rowid: index, role: 'assistant', content, in_range: 1 })
		expect(accumulator.tools()).toHaveLength(1)
		expect(accumulator.tools()[0].totalTokens).toBeLessThan(100)
	})

	test('does not charge MCP image data serialized inside a result string as text tokens', () => {
		const accumulator = new ToolUsageAccumulator()
		const output = {
			content: [
				{ type: 'text', text: 'Screenshot saved.' },
				{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(400_000) }
			]
		}
		accumulator.add({
			rowid: 1,
			role: 'assistant',
			content: frame([call('image', 'Screenshot'), result('image', JSON.stringify(output))]),
			in_range: 1
		})
		expect(accumulator.tools()[0].totalTokens).toBeLessThan(150)
	})
})

describe('recent tool usage from SQLite', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-tool-usage-'))
	const file = path.join(dir, 'conductor.db')
	const sqlite = new DatabaseSync(file)
	sqlite.exec(`
		CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_type TEXT, updated_at TEXT, is_hidden INTEGER);
		CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, created_at TEXT);
		CREATE INDEX messages_session ON session_messages(session_id);
	`)
	const db = new ConductorDb(file)
	const now = Date.parse('2026-09-05T12:00:00Z')
	const session = (id: string, provider: string, at = '2026-09-05 12:00:00') =>
		sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, 1)').run(id, provider, at)
	const message = (sessionId: string, at: string, blocks: unknown[]) =>
		sqlite.prepare('INSERT INTO session_messages VALUES (?, ?, ?, ?)').run(sessionId, 'assistant', frame(blocks), at)
	beforeEach(() => sqlite.exec('DELETE FROM sessions; DELETE FROM session_messages;'))
	afterAll(() => {
		sqlite.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	test('includes hidden chats, handles SQLite/ISO timestamps, and omits older/future traffic', () => {
		session('s', 'codex')
		message('s', '2026-09-04 11:59:59', [call('prior', 'Bash')])
		message('s', '2026-09-04T12:00:00Z', [result('prior', 'boundary result')])
		message('s', '2026-09-05 11:59:59', [call('now', 'Read'), result('now', 'a source file')])
		message('s', '2026-09-05T12:00:01Z', [call('future', 'Future')])
		message('s', '2026-09-03 12:00:00', [call('old', 'Old'), result('old', 'older')])
		const snapshot = readToolUsage(db, '24h', now)
		expect(snapshot.providers[0].sessionCount).toBe(1)
		expect(snapshot.providers[0].tools.map(tool => tool.name).sort()).toEqual(['Bash', 'Read'])
		expect(snapshot.providers[0].tools.find(tool => tool.name === 'Bash')?.inputTokens).toBe(0)
		expect(readToolUsage(db, '7d', now).providers[0].tools.map(tool => tool.name)).toContain('Old')
	})

	test('isolates reused call IDs by chat and groups OpenCode under its Models provider', () => {
		session('a', 'acp')
		session('b', 'acp')
		session('empty', 'claude')
		message('a', '2026-09-05 10:00:00', [call('reused', 'Read'), result('reused', 'file')])
		message('b', '2026-09-05 10:00:00', [call('reused', 'Read'), result('reused', 'other file')])
		const snapshot = readToolUsage(db, '24h', now)
		expect(snapshot.providers).toHaveLength(1)
		expect(snapshot.providers[0]).toMatchObject({
			provider: 'opencode',
			sessionCount: 2,
			tools: [{ name: 'Read', calls: 2 }]
		})
	})

	test('the worker shares concurrent reads, serves cache, and refreshes explicitly', async () => {
		session('s', 'claude', new Date().toISOString())
		message('s', new Date(Date.now() - 1000).toISOString(), [call('first', 'Read')])
		const service = new ToolUsageService(file)
		const first = service.read('24h')
		expect(service.read('24h', true)).toBe(first)
		const snapshot = await first
		expect(snapshot.providers[0].tools[0].calls).toBe(1)
		message('s', new Date(Date.now() - 500).toISOString(), [call('second', 'Read')])
		expect(await service.read('24h')).toBe(snapshot)
		expect((await service.read('24h', true)).providers[0].tools[0].calls).toBe(2)
	})

	test('a failed worker read can be retried after the source becomes available', async () => {
		const missingFile = path.join(dir, 'later.db')
		const service = new ToolUsageService(missingFile)
		await expect(service.read('24h')).rejects.toThrow()
		const later = new DatabaseSync(missingFile)
		later.exec('CREATE TABLE sessions (id TEXT, agent_type TEXT, updated_at TEXT)')
		later.close()
		expect((await service.read('24h')).providers).toEqual([])
	})

	test('does not forward Node watch process flags that workers reject', async () => {
		const previous = process.execArgv
		process.execArgv = [...previous, '--stack-trace-limit=10', '--use-largepages=off']
		try {
			expect((await new ToolUsageService(file).read('24h')).providers).toEqual([])
		} finally {
			process.execArgv = previous
		}
	})
})
