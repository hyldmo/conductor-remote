import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { ConductorDb } from '../src/db.ts'

describe('ConductorDb latency instrumentation', () => {
	test('names a slow query without logging its bound values', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-db-'))
		const file = path.join(dir, 'conductor.db')
		const raw = new DatabaseSync(file)
		raw.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('private value')")
		raw.close()

		const warnings: string[] = []
		const db = new ConductorDb(file, {
			slowQueryMs: 0,
			onSlowQuery: message => warnings.push(message)
		})
		expect(db.query<{ value: string }>('SELECT value FROM example WHERE value = ?', ['private value'])).toEqual([
			{ value: 'private value' }
		])
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain('slow Conductor DB query')
		expect(warnings[0]).toContain('SELECT value FROM example WHERE value = ?')
		expect(warnings[0]).not.toContain('private value')

		fs.rmSync(dir, { recursive: true, force: true })
	})
})
