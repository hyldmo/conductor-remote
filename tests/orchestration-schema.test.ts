import { DatabaseSync } from 'node:sqlite'
import { asc } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { describe, expect, test } from 'vitest'
import {
	ORCHESTRATION_BOOTSTRAP_SQL,
	ORCHESTRATION_TABLE_NAMES,
	orchestrationSchema,
	workflowRunSelectSchema,
	workflowRuns
} from '../src/orchestration-schema.ts'

const validRunRow = {
	id: 'run-1',
	objective: 'Keep one authoritative schema',
	target: { kind: 'existing_session' as const, workspaceId: 'workspace-1', sessionId: 'session-1' },
	roles: {
		planning: { agentType: 'codex', model: 'GPT-5.6 Sol', effort: 'high' as const },
		exploration: { agentType: 'claude', model: 'Claude Sonnet 4.6' },
		implementation: { agentType: 'cursor', model: 'Composer 1.5', fast: true }
	},
	phase: 'pending_root' as const,
	cycle: 0,
	revision: 0,
	workspaceId: 'workspace-1',
	rootSessionId: 'session-1',
	pristineEvidence: null,
	deliveryBaseline: null,
	planningInterpretation: null,
	cancellationGeneration: 0,
	blockedActionId: null,
	blockedErrorCode: null,
	blockedMessage: null,
	resumePhase: null,
	retryClass: null,
	blockedCandidates: null,
	blockedAt: null,
	implementationBatonsDelivered: 0,
	createdAt: 1,
	updatedAt: 1,
	terminalAt: null
}

describe('orchestration Drizzle schema', () => {
	test('is the complete source for a strict, constrained bootstrap database', () => {
		expect(new Set(ORCHESTRATION_TABLE_NAMES).size).toBe(Object.keys(orchestrationSchema).length)

		const db = new DatabaseSync(':memory:')
		db.exec('PRAGMA foreign_keys = ON')
		db.exec(ORCHESTRATION_BOOTSTRAP_SQL)

		const rows = db
			.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as unknown as Array<{ name: string; sql: string }>
		expect(rows.map(row => row.name)).toEqual([...ORCHESTRATION_TABLE_NAMES].sort())
		expect(rows.every(row => /\) STRICT$/i.test(row.sql))).toBe(true)
		expect(db.prepare('SELECT id FROM ui_mutex').get()).toMatchObject({ id: 1 })
		expect(db.prepare('SELECT id, active FROM ui_quarantine').get()).toMatchObject({ id: 1, active: 0 })

		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_runs
						(id, objective, target_json, roles_json, phase, created_at, updated_at)
					 VALUES ('bad-json', 'x', 'not-json', '{}', 'pending_root', 1, 1)`
				)
				.run()
		).toThrow()
		expect(() =>
			db
				.prepare(
					`INSERT INTO workflow_runs
						(id, objective, target_json, roles_json, phase, created_at, updated_at)
					 VALUES ('bad-phase', 'x', '{}', '{}', 'surprise', 1, 1)`
				)
				.run()
		).toThrow()
		db.close()
	})

	test('derives runtime row validation from the same table model', () => {
		expect(workflowRunSelectSchema.parse(validRunRow)).toEqual(validRunRow)
		expect(
			workflowRunSelectSchema.safeParse({
				...validRunRow,
				target: { kind: 'existing_session', workspaceId: 'workspace-1' }
			}).success
		).toBe(false)
		expect(workflowRunSelectSchema.safeParse({ ...validRunRow, phase: 'surprise' }).success).toBe(false)
	})

	test('preserves the difference between SQL NULL and an explicit JSON null', () => {
		const client = new DatabaseSync(':memory:')
		client.exec(ORCHESTRATION_BOOTSTRAP_SQL)
		const insert = client.prepare(
			`INSERT INTO workflow_runs
				(id, objective, target_json, roles_json, phase, pristine_evidence_json, created_at, updated_at)
			 VALUES (?, 'x', ?, ?, 'pending_root', ?, 1, 1)`
		)
		const target = JSON.stringify(validRunRow.target)
		const roles = JSON.stringify(validRunRow.roles)
		insert.run('absent', target, roles, null)
		insert.run('explicit', target, roles, 'null')

		const rows = drizzle({ client }).select().from(workflowRuns).orderBy(asc(workflowRuns.id)).all()
		expect(rows[0]?.pristineEvidence).toBeNull()
		expect(rows[1]?.pristineEvidence).toEqual({ value: null })
		client.close()
	})
})
