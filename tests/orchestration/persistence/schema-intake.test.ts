import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
	canonicalRequestHash,
	IdempotencyConflictError,
	OrchestrationDb,
	UnsupportedOrchestrationSchemaError,
	WorkflowTransitionError
} from '../../../src/orchestration/persistence/db.ts'
import { databaseFile, roles, startExisting } from './fixtures.ts'

describe('OrchestrationDb schema and intake', () => {
	test('creates a WAL database and atomically persists accepted intent before effects', () => {
		const file = databaseFile()
		const db = new OrchestrationDb(file)
		const accepted = startExisting(db)

		expect(accepted.replayed).toBe(false)
		expect(accepted.run).toMatchObject({
			phase: 'pending_root',
			workspaceId: 'workspace-1',
			rootSessionId: 'root-1',
			cancellationGeneration: 0
		})
		expect(db.listWorkflowJobs(accepted.run.id)).toMatchObject([
			{ logicalKey: 'explore:0', role: 'exploration', state: 'dormant', prompt: 'Inspect the orchestration boundary' }
		])
		expect(db.getWorkflowEffect(accepted.run.id, 'send-root')).toMatchObject({
			kind: 'send_root',
			state: 'prepared',
			attemptCount: 0
		})
		expect(db.listWorkflowEvents(accepted.run.id).map(event => event.type)).toEqual(['workflow_started'])

		const raw = new DatabaseSync(file, { readOnly: true })
		expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
		expect(
			(raw.prepare("SELECT value FROM orchestration_meta WHERE key = 'schema_version'").get() as { value: string })
				.value
		).toBe('1')
		expect(
			(
				raw.prepare('SELECT run_id FROM workflow_idempotency WHERE operation = ?').get('start_workflow') as {
					run_id: string
				}
			).run_id
		).toBe(accepted.run.id)
		raw.close()
		db.close()
	})

	test('returns the stable run for exact idempotent repeats and rejects changed bodies', () => {
		const file = databaseFile()
		const first = new OrchestrationDb(file)
		const accepted = startExisting(first)
		const second = new OrchestrationDb(file)

		const repeated = startExisting(second, {
			id: randomUUID(),
			// Derived state may legitimately differ when the phone retries after Start.
			roles: { ...roles, planning: { ...roles.planning, preamble: 'A later global edit.' } },
			pristineEvidence: { userRows: 1 }
		})
		expect(repeated.replayed).toBe(true)
		expect(repeated.run.id).toBe(accepted.run.id)
		expect(second.listWorkflowJobs(accepted.run.id)).toHaveLength(1)
		expect(second.listWorkflowEvents(accepted.run.id)).toHaveLength(1)
		expect(
			second.getIdempotentMutation<{ runId: string }>('start_workflow', 'start-client', {
				objective: 'Build a deterministic pipeline',
				target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' }
			})?.result.runId
		).toBe(accepted.run.id)

		expect(() => startExisting(second, { objective: 'A different objective' })).toThrow(IdempotencyConflictError)
		expect(() =>
			second.getIdempotentMutation('start_workflow', 'start-client', {
				objective: 'A different objective',
				target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' }
			})
		).toThrow(IdempotencyConflictError)
		expect(second.getWorkflowRun(accepted.run.id)?.objective).toBe('Build a deterministic pipeline')
		first.close()
		second.close()
	})

	test('canonical request hashing ignores object key order but not material input', () => {
		expect(canonicalRequestHash({ b: 2, a: { y: undefined, x: -0 } })).toBe(canonicalRequestHash({ a: { x: 0 }, b: 2 }))
		expect(canonicalRequestHash({ value: ['a', undefined] })).not.toBe(canonicalRequestHash({ value: ['a'] }))
	})

	test('enforces one non-terminal run per root and frees the claim only at terminal state', () => {
		const db = new OrchestrationDb(databaseFile())
		const first = startExisting(db).run
		expect(() => startExisting(db, { clientId: 'another-start', id: 'run-2' })).toThrow(WorkflowTransitionError)

		db.transitionWorkflowRun({
			runId: first.id,
			expectedPhase: 'pending_root',
			expectedCancellationGeneration: 0,
			phase: 'completed',
			eventKey: 'complete',
			eventType: 'workflow_completed'
		})
		const next = startExisting(db, { clientId: 'another-start', id: 'run-2' })
		expect(next.run.id).toBe('run-2')
		db.close()
	})

	test('projects only the newest Workflow identity for each requested workspace', () => {
		let clock = 1_000
		const db = new OrchestrationDb(databaseFile(), { now: () => clock++ })
		const first = startExisting(db).run
		db.transitionWorkflowRun({
			runId: first.id,
			expectedPhase: 'pending_root',
			expectedCancellationGeneration: 0,
			phase: 'completed',
			eventKey: 'complete-first',
			eventType: 'workflow_completed'
		})
		const newestRoles = { ...roles, planning: { ...roles.planning, model: 'Newest planner' } }
		const newest = startExisting(db, {
			id: 'newest-workspace-1',
			clientId: 'newest-workspace-1-client',
			roles: newestRoles
		}).run
		db.transitionWorkflowRun({
			runId: newest.id,
			expectedPhase: 'pending_root',
			expectedCancellationGeneration: 0,
			phase: 'cancelled',
			eventKey: 'cancel-newest',
			eventType: 'workflow_cancelled'
		})
		const other = startExisting(db, {
			id: 'workspace-2-run',
			clientId: 'workspace-2-client',
			target: { kind: 'existing_session', workspaceId: 'workspace-2', sessionId: 'root-2' }
		}).run

		const projected = db.listLatestWorkflowProjectionsForWorkspaces([
			'workspace-1',
			'workspace-2',
			'workspace-1',
			'unknown'
		])
		const byWorkspace = new Map(projected.map(run => [run.workspaceId, run]))

		expect(projected).toHaveLength(2)
		expect(byWorkspace.get('workspace-1')).toMatchObject({
			id: newest.id,
			phase: 'cancelled',
			roles: { planning: { model: 'Newest planner' } }
		})
		expect(byWorkspace.get('workspace-2')).toMatchObject({ id: other.id, phase: 'pending_root' })
		expect(db.listLatestWorkflowProjectionsForWorkspaces([])).toEqual([])
		db.close()
	})

	test('preserves an unsupported future schema and refuses writes', () => {
		const file = databaseFile()
		const raw = new DatabaseSync(file)
		raw.exec(`
			CREATE TABLE orchestration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
			INSERT INTO orchestration_meta VALUES ('schema_version', '99');
			CREATE TABLE future_data (value TEXT NOT NULL) STRICT;
			INSERT INTO future_data VALUES ('keep me');
		`)
		raw.close()

		const db = new OrchestrationDb(file)
		expect(db.writable).toBe(false)
		expect(db.schemaVersion).toBe(99)
		expect(() => startExisting(db)).toThrow(UnsupportedOrchestrationSchemaError)
		db.close()
		const verify = new DatabaseSync(file, { readOnly: true })
		expect((verify.prepare('SELECT value FROM future_data').get() as { value: string }).value).toBe('keep me')
		verify.close()
	})

	test('preserves corrupt current schema metadata and refuses writes', () => {
		const missingVersionFile = databaseFile()
		const missingVersion = new DatabaseSync(missingVersionFile)
		missingVersion.exec(`
			CREATE TABLE orchestration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
			CREATE TABLE preserved_data (value TEXT NOT NULL) STRICT;
			INSERT INTO preserved_data VALUES ('missing version survives');
		`)
		missingVersion.close()

		const missingVersionDb = new OrchestrationDb(missingVersionFile)
		expect(missingVersionDb).toMatchObject({
			writable: false,
			schemaVersion: -1,
			schemaWarning: 'orchestration schema version metadata is missing'
		})
		expect(() => startExisting(missingVersionDb)).toThrow('orchestration schema version metadata is missing')
		missingVersionDb.close()
		const missingVersionVerify = new DatabaseSync(missingVersionFile, { readOnly: true })
		expect((missingVersionVerify.prepare('SELECT value FROM preserved_data').get() as { value: string }).value).toBe(
			'missing version survives'
		)
		missingVersionVerify.close()

		const incompleteFile = databaseFile()
		const incomplete = new DatabaseSync(incompleteFile)
		incomplete.exec(`
			CREATE TABLE orchestration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
			INSERT INTO orchestration_meta VALUES ('schema_version', '1');
			CREATE TABLE preserved_data (value TEXT NOT NULL) STRICT;
			INSERT INTO preserved_data VALUES ('incomplete schema survives');
		`)
		incomplete.close()

		const incompleteDb = new OrchestrationDb(incompleteFile)
		expect(incompleteDb.writable).toBe(false)
		expect(incompleteDb.schemaVersion).toBe(1)
		expect(incompleteDb.schemaWarning).toContain('orchestration schema is missing:')
		expect(() => startExisting(incompleteDb)).toThrow('orchestration schema is missing:')
		incompleteDb.close()
		const verify = new DatabaseSync(incompleteFile, { readOnly: true })
		expect((verify.prepare('SELECT value FROM preserved_data').get() as { value: string }).value).toBe(
			'incomplete schema survives'
		)
		verify.close()

		const interruptedFile = databaseFile()
		const interrupted = new DatabaseSync(interruptedFile)
		interrupted.exec(`
			CREATE TABLE workflow_runs (value TEXT NOT NULL) STRICT;
			CREATE TABLE preserved_data (value TEXT NOT NULL) STRICT;
			INSERT INTO preserved_data VALUES ('interrupted migration survives');
		`)
		interrupted.close()

		const interruptedDb = new OrchestrationDb(interruptedFile)
		expect(interruptedDb).toMatchObject({ writable: false, schemaVersion: -1 })
		expect(interruptedDb.schemaWarning).toContain('metadata is missing')
		expect(() => startExisting(interruptedDb)).toThrow('metadata is missing')
		interruptedDb.close()
		const interruptedVerify = new DatabaseSync(interruptedFile, { readOnly: true })
		expect((interruptedVerify.prepare('SELECT value FROM preserved_data').get() as { value: string }).value).toBe(
			'interrupted migration survives'
		)
		interruptedVerify.close()

		const malformedFile = databaseFile()
		const malformed = new DatabaseSync(malformedFile)
		malformed.exec(`
			CREATE TABLE orchestration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
			INSERT INTO orchestration_meta VALUES ('schema_version', '1');
			CREATE TABLE workflow_runs (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_capabilities (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_jobs (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_job_attempts (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_effects (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_effect_attempts (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_events (value TEXT NOT NULL) STRICT;
			CREATE TABLE workflow_idempotency (value TEXT NOT NULL) STRICT;
			CREATE TABLE relay_instances (value TEXT NOT NULL) STRICT;
			CREATE TABLE ui_mutex (value TEXT NOT NULL) STRICT;
			CREATE TABLE ui_quarantine (value TEXT NOT NULL) STRICT;
			CREATE TABLE preserved_data (value TEXT NOT NULL) STRICT;
			INSERT INTO preserved_data VALUES ('malformed schema survives');
		`)
		malformed.close()

		const malformedDb = new OrchestrationDb(malformedFile)
		expect(malformedDb).toMatchObject({ writable: false, schemaVersion: 1 })
		expect(malformedDb.schemaWarning).toContain('orchestration schema could not be validated')
		expect(() => startExisting(malformedDb)).toThrow('orchestration schema could not be validated')
		malformedDb.close()
		const malformedVerify = new DatabaseSync(malformedFile, { readOnly: true })
		expect((malformedVerify.prepare('SELECT value FROM preserved_data').get() as { value: string }).value).toBe(
			'malformed schema survives'
		)
		malformedVerify.close()
	})
})
