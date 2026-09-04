import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
	canonicalRequestHash,
	type FrozenWorkflowRoles,
	hashCapabilityToken,
	IdempotencyConflictError,
	ORCHESTRATION_PROTOCOL_VERSION,
	OrchestrationDb,
	type RelayIdentity,
	UnsupportedOrchestrationSchemaError,
	WorkflowTransitionError
} from '../src/orchestration-db.ts'
import { workflowCapabilityToken, workflowPrivateEnvelope } from '../src/shared.ts'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const databaseFile = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-orchestration-'))
	directories.push(directory)
	return join(directory, 'orchestration.db')
}

const roles: FrozenWorkflowRoles = {
	planning: {
		agentType: 'codex',
		model: 'GPT-5.6 Sol',
		effort: 'high',
		preamble: 'PRIVATE PLANNING PREAMBLE'
	},
	exploration: { agentType: 'claude', model: 'Claude Sonnet 4.6', effort: 'medium' },
	implementation: { agentType: 'cursor', model: 'Composer 1.5', fast: true }
}

const relay = (instanceId: string, pid: number, processStartedAt = `start-${pid}`): RelayIdentity => ({
	instanceId,
	pid,
	processStartedAt,
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
})

const startExisting = (
	db: OrchestrationDb,
	overrides: Partial<Parameters<OrchestrationDb['createWorkflowRun']>[0]> = {}
) =>
	db.createWorkflowRun({
		clientId: 'start-client',
		objective: 'Build a deterministic pipeline',
		target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
		roles,
		pristineEvidence: { durableRows: 0, outboxIds: [] },
		deliveryBaseline: { rowid: 12, outboxIds: [] },
		bootstrapPrompt: 'Inspect the orchestration boundary',
		initialEffect: {
			actionId: 'send-root',
			kind: 'send_root',
			cursor: { rowid: 12, outboxIds: [] },
			inputs: { marker: 'root-correlation' }
		},
		...overrides
	})

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

describe('OrchestrationDb transitions, jobs, and effects', () => {
	test('rolls a materialized transition back when its audit event cannot commit', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		expect(() =>
			db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'pending_root',
				expectedCancellationGeneration: 0,
				phase: 'exploring',
				eventKey: 'workflow_started',
				eventType: 'root_delivered'
			})
		).toThrow()
		expect(db.getWorkflowRun(run.id)?.phase).toBe('pending_root')
		expect(db.listWorkflowEvents(run.id).map(event => event.type)).toEqual(['workflow_started'])
		db.close()
	})

	test('claims a queued logical job once across database connections', () => {
		const file = databaseFile()
		const db1 = new OrchestrationDb(file)
		const run = startExisting(db1).run
		const bootstrap = db1.listWorkflowJobs(run.id)[0]
		db1.activateWorkflowJob(bootstrap.id, 0, 'activate-bootstrap')
		const db2 = new OrchestrationDb(file)
		const owner1 = relay('relay-a', 101)
		const owner2 = relay('relay-b', 102)

		expect(db1.claimNextWorkflowJob(owner1)?.owner).toEqual(owner1)
		expect(db2.claimNextWorkflowJob(owner2)).toBeUndefined()
		expect(() => db1.createWorkflowJobAttempt({ jobId: bootstrap.id, owner: owner2 })).toThrow(WorkflowTransitionError)
		const attempt = db1.createWorkflowJobAttempt({ jobId: bootstrap.id, owner: owner1 })
		expect(attempt).toMatchObject({ attemptNumber: 1, owner: owner1 })
		expect(db2.getWorkflowJob(bootstrap.id)?.attemptCount).toBe(1)
		db1.close()
		db2.close()
	})

	test('can reclaim repeated pre-attempt job claims without reusing audit keys', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-for-reclaim')

		for (const [index, owner] of [relay('dead-a', 111), relay('dead-b', 112)].entries()) {
			expect(db.claimNextWorkflowJob(owner, run.id)?.owner).toEqual(owner)
			expect(
				db.reconcileAbandonedWorkflowJobClaim({
					jobId: bootstrap.id,
					eventKey: `recover-before-attempt:${bootstrap.id}`
				})
			).toMatchObject({ status: 'requeued', job: { state: 'queued', attemptCount: 0 } })
			expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_job_claim_recovered')).toHaveLength(
				index + 1
			)
		}
		const live = relay('live-c', 113)
		expect(db.claimNextWorkflowJob(live, run.id)?.owner).toEqual(live)
		expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_job_claimed')).toHaveLength(3)
		db.close()
	})

	test('persists the delivered root transcript cursor while activating the bootstrap job', () => {
		const file = databaseFile()
		const db = new OrchestrationDb(file)
		const run = startExisting(db).run
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		const transcriptCursor = { rowid: 44, turnId: 'root-turn', outboxIds: ['accepted-root'] }

		expect(db.activateWorkflowJob(bootstrap.id, 0, 'activate-with-root-cursor', transcriptCursor)).toMatchObject({
			state: 'queued',
			transcriptCursor
		})
		db.close()

		const reopened = new OrchestrationDb(file)
		expect(reopened.getWorkflowJob(bootstrap.id)).toMatchObject({ state: 'queued', transcriptCursor })
		reopened.close()
	})

	test('records durable effect attempts and permits replay only after a pre-dispatch failure', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 201)
		const claimed = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(claimed?.attempt).toMatchObject({ attemptNumber: 1, state: 'prepared', mayExecute: false })

		db.markWorkflowEffectFailed({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 1,
			errorCode: 'window_missing',
			errorMessage: 'No window before dispatch'
		})
		expect(db.getWorkflowEffect(run.id, 'send-root')?.state).toBe('failed')
		db.retryWorkflowEffect(run.id, 'send-root', 'retry-root')

		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(second?.attempt.attemptNumber).toBe(2)
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			launchNonce: 'launch-2'
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			launchNonce: 'launch-2',
			externalProcess: { pid: 301, processStartedAt: 'external-start', processGroup: 301 }
		})
		const committed = db.markWorkflowEffectCommitted({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: 2,
			receipt: { kind: 'message', rowid: 44, turnId: 'turn-1' }
		})
		expect(committed).toMatchObject({
			state: 'committed',
			mayExecute: true,
			attemptCount: 2,
			receipt: { kind: 'message', rowid: 44, turnId: 'turn-1' }
		})
		expect(() => db.retryWorkflowEffect(run.id, 'send-root', 'unsafe-retry')).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('commits a positively matched configuration without claiming or dispatching it', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const configured = db.prepareWorkflowEffect({
			runId: run.id,
			actionId: 'configure-root',
			kind: 'configure_root',
			target: { sessionId: 'root-1' },
			inputs: { model: 'GPT-5.6 Sol', effort: 'high' },
			expectedCancellationGeneration: 0,
			eventKey: 'prepare-configure-root'
		}).effect
		const receipt = { kind: 'settings_match', provider: 'codex', model: 'GPT-5.6 Sol', effort: 'high' }

		expect(
			db.markWorkflowEffectSatisfiedWithoutDispatch({
				runId: run.id,
				actionId: configured.actionId,
				expectedCancellationGeneration: 0,
				receipt,
				eventKey: 'configure-root-already-matched'
			})
		).toMatchObject({ state: 'committed', mayExecute: false, attemptCount: 0, receipt })
		expect(db.listWorkflowEffectAttempts(configured.id)).toEqual([])
		expect(db.listWorkflowEvents(run.id).at(-1)).toMatchObject({
			eventKey: 'configure-root-already-matched',
			type: 'workflow_effect_satisfied_without_dispatch',
			data: { actionId: 'configure-root', receipt }
		})
		expect(() =>
			db.markWorkflowEffectSatisfiedWithoutDispatch({
				runId: run.id,
				actionId: 'send-root',
				expectedCancellationGeneration: 0,
				receipt: { kind: 'message', id: 'not-allowed' }
			})
		).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('audits sequential gated process identities once per distinct wrapper', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('sequential-gates', 320)
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch'
		})
		const first = { pid: 321, processStartedAt: 'first-wrapper', processGroup: 321 }
		const second = { pid: 322, processStartedAt: 'second-wrapper', processGroup: 322 }

		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch',
			externalProcess: first
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'sequential-launch',
			externalProcess: first
		})
		expect(db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_effect_may_execute')).toHaveLength(1)

		expect(
			db.markWorkflowEffectMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claim.attempt.attemptNumber,
				launchNonce: 'sequential-launch',
				externalProcess: second
			})
		).toMatchObject({ externalProcess: second, mayExecute: true })
		expect(db.listWorkflowEffectAttempts(claim.effect.id).at(-1)).toMatchObject({ externalProcess: second })
		const executionEvents = db.listWorkflowEvents(run.id).filter(event => event.type === 'workflow_effect_may_execute')
		expect(executionEvents).toHaveLength(2)
		expect(executionEvents.map(event => event.eventKey)).toEqual([
			expect.stringContaining('effect_may_execute:send-root:1:321:'),
			expect.stringContaining('effect_may_execute:send-root:1:322:')
		])
		db.close()
	})

	test('does not dispatch a claimed effect after its run becomes blocked', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('blocked-before-dispatch', 325)
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		db.transitionWorkflowRun({
			runId: run.id,
			expectedPhase: 'pending_root',
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'send-root',
				errorCode: 'compatibility_changed',
				message: 'A conflicting relay appeared.',
				resumePhase: 'pending_root',
				retryClass: 'terminal'
			},
			eventKey: 'blocked-before-effect-dispatch',
			eventType: 'workflow_blocked'
		})

		expect(() =>
			db.markWorkflowEffectDispatched({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claim.attempt.attemptNumber,
				launchNonce: 'must-not-dispatch'
			})
		).toThrow(WorkflowTransitionError)
		expect(db.getWorkflowEffect(run.id, 'send-root')).toMatchObject({ state: 'prepared', mayExecute: false })
		db.close()
	})

	test('restarts effect recovery when a newer external identity appears during probing', () => {
		const file = databaseFile()
		const owner = relay('effect-recovery-owner', 330)
		const ownerDb = new OrchestrationDb(file)
		const run = startExisting(ownerDb).run
		const claim = ownerDb.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claim) throw new Error('expected effect claim')
		ownerDb.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'identity-race'
		})
		ownerDb.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim.attempt.attemptNumber,
			launchNonce: 'identity-race',
			externalProcess: { pid: 331, processStartedAt: 'old-wrapper', processGroup: 331 }
		})

		let injected = false
		const recoveryDb = new OrchestrationDb(file, {
			processProbe: identity => {
				if (identity.pid === 331 && !injected) {
					injected = true
					ownerDb.markWorkflowEffectMayExecute({
						runId: run.id,
						actionId: 'send-root',
						owner,
						attemptNumber: claim.attempt.attemptNumber,
						launchNonce: 'identity-race',
						externalProcess: { pid: 332, processStartedAt: 'new-wrapper', processGroup: 332 }
					})
					return false
				}
				return identity.pid === 332
			}
		})
		expect(
			recoveryDb.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-identity-race'
			})
		).toMatchObject({ status: 'changed', effect: { externalProcess: { pid: 332 } } })
		expect(
			recoveryDb.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-new-identity'
			})
		).toMatchObject({ status: 'external_process_alive' })
		ownerDb.close()
		recoveryDb.close()
	})

	test('recovers dead effect owners only before execution and requires explicit replay after ambiguity', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const owner = relay('dead-owner', 350)
		const first = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		expect(first?.attempt.attemptNumber).toBe(1)
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-before-dispatch'
			})
		).toMatchObject({ status: 'safely_prepared', effect: { state: 'prepared' } })
		expect(db.listWorkflowEffectAttempts(first?.effect.id ?? '')[0]).toMatchObject({
			state: 'cancelled',
			evidence: { reason: 'owner_died_before_may_execute' }
		})

		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!second) throw new Error('expected second attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'second-launch'
		})
		db.markWorkflowEffectMayExecute({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'second-launch'
		})
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'recover-after-dispatch'
			})
		).toMatchObject({ status: 'ambiguous', effect: { state: 'ambiguous' } })
		expect(() => db.retryWorkflowEffect(run.id, 'send-root', 'ordinary-retry')).toThrow(WorkflowTransitionError)
		expect(db.replayAmbiguousWorkflowEffect(run.id, 'send-root', 'phone-confirmed-replay').state).toBe('prepared')
		db.close()
	})

	test('cancellation tombstones pending work and lets a late positive receipt settle dispatched evidence', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 401)
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-before-cancel')
		db.claimNextWorkflowJob(owner, run.id)
		db.createWorkflowJobAttempt({ jobId: bootstrap.id, owner, state: 'opening' })
		db.prepareWorkflowEffect({
			runId: run.id,
			actionId: 'safe-prepared',
			kind: 'configure_child',
			expectedCancellationGeneration: 0,
			eventKey: 'prepare-safe-before-cancel'
		})
		const claim = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claim?.attempt.attemptNumber ?? 0,
			launchNonce: 'may-land'
		})

		const cancelled = db.cancelWorkflowRun(run.id, 'cancel-1')
		expect(cancelled).toMatchObject({ phase: 'cancelled', cancellationGeneration: 1 })
		expect(db.getWorkflowJob(bootstrap.id)).toMatchObject({ state: 'cancelled', cancellationGeneration: 1 })
		expect(db.listWorkflowJobAttempts(bootstrap.id)[0].state).toBe('cancelled')
		expect(db.getWorkflowEffect(run.id, 'safe-prepared')?.state).toBe('cancelled')
		expect(db.getWorkflowEffect(run.id, 'send-root')?.state).toBe('dispatched')
		expect(db.listWorkflowEvents(run.id).at(-1)?.type).toBe('workflow_cancelled')
		db.activateUiQuarantine({
			actionId: 'send-root',
			effectId: 'another-run:send-root',
			reason: 'A newer run owns this hold.'
		})
		expect(() =>
			db.updateWorkflowJobAttempt({
				jobId: bootstrap.id,
				attemptNumber: 1,
				expectedState: 'cancelled',
				state: 'returned',
				eventKey: 'must-not-reopen',
				eventType: 'wrong'
			})
		).toThrow(WorkflowTransitionError)

		db.recordLateWorkflowChildResult({
			runId: run.id,
			jobId: bootstrap.id,
			outcome: { kind: 'success', text: 'finished after cancellation' },
			eventKey: 'late-child-1'
		})
		db.recordLateWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			receipt: { kind: 'message', id: 'late-message', rowid: 99, turnId: 'late-turn' },
			eventKey: 'late-effect-1'
		})
		db.recordLateWorkflowChildResult({
			runId: run.id,
			jobId: bootstrap.id,
			outcome: { kind: 'success', text: 'finished after cancellation' },
			eventKey: 'late-child-1'
		})
		db.recordLateWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			receipt: { kind: 'message', id: 'late-message', rowid: 99, turnId: 'late-turn' },
			eventKey: 'late-effect-1'
		})
		expect(db.getWorkflowJob(bootstrap.id)).toMatchObject({
			state: 'cancelled',
			outcome: { kind: 'success', text: 'finished after cancellation' }
		})
		expect(db.getWorkflowEffect(run.id, 'send-root')).toMatchObject({
			state: 'committed',
			receipt: { kind: 'message', id: 'late-message' }
		})
		expect(db.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'send-root',
			effectId: 'another-run:send-root'
		})
		expect(
			db
				.listWorkflowEvents(run.id)
				.slice(-2)
				.map(event => event.type)
		).toEqual(['late_child_result', 'late_effect'])
		db.close()
	})

	test('keeps terminal cancellation closed across run, job, and gated-effect races', () => {
		const db = new OrchestrationDb(databaseFile(), { processProbe: () => false })
		const run = startExisting(db).run
		const owner = relay('cancel-race-owner', 420)
		const bootstrap = db.listWorkflowJobs(run.id)[0]
		db.activateWorkflowJob(bootstrap.id, 0, 'activate-cancel-race')
		db.claimNextWorkflowJob(owner, run.id)
		const claimed = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!claimed) throw new Error('expected claimed effect')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: claimed.attempt.attemptNumber,
			launchNonce: 'cancelled-gate'
		})
		db.cancelWorkflowRun(run.id, 'cancel-race')

		expect(() =>
			db.markWorkflowEffectMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: claimed.attempt.attemptNumber,
				launchNonce: 'cancelled-gate',
				externalProcess: { pid: 421, processStartedAt: 'must-stay-gated', processGroup: 421 }
			})
		).toThrow(WorkflowTransitionError)
		expect(() =>
			db.updateWorkflowJob({
				jobId: bootstrap.id,
				expectedStates: ['cancelled'],
				expectedCancellationGeneration: 1,
				state: 'queued',
				eventKey: 'reopen-cancelled-job',
				eventType: 'invalid_reopen'
			})
		).toThrow(WorkflowTransitionError)
		expect(() =>
			db.transitionWorkflowRun({
				runId: run.id,
				expectedPhase: 'cancelled',
				expectedCancellationGeneration: 1,
				phase: 'exploring',
				eventKey: 'reopen-cancelled-run',
				eventType: 'invalid_reopen'
			})
		).toThrow(WorkflowTransitionError)
		expect(
			db.reconcileAbandonedWorkflowEffect({
				runId: run.id,
				actionId: 'send-root',
				eventKey: 'cancel-safe-gated-effect'
			})
		).toMatchObject({ status: 'terminal', effect: { state: 'cancelled', mayExecute: false } })
		db.close()
	})

	test('distinguishes wrapper failure before mayExecute from a lost accepted receipt', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const owner = relay('effect-owner', 450)
		const first = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!first) throw new Error('expected first effect attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: first.attempt.attemptNumber,
			launchNonce: 'gated-wrapper',
			mayExecute: false
		})
		expect(
			db.markWorkflowEffectFailedBeforeMayExecute({
				runId: run.id,
				actionId: 'send-root',
				owner,
				attemptNumber: first.attempt.attemptNumber,
				errorCode: 'wrapper_spawn_failed',
				errorMessage: 'Wrapper never received permission.'
			})
		).toMatchObject({ state: 'failed', mayExecute: false })

		db.retryWorkflowEffect(run.id, 'send-root', 'retry-after-wrapper')
		const second = db.claimPreparedWorkflowEffect({
			runId: run.id,
			actionId: 'send-root',
			owner,
			expectedCancellationGeneration: 0
		})
		if (!second) throw new Error('expected second effect attempt')
		db.markWorkflowEffectDispatched({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			launchNonce: 'accepted-send',
			mayExecute: true
		})
		const accepted = { kind: 'outbox', id: 'outbox-1' }
		db.markWorkflowEffectCommitted({
			runId: run.id,
			actionId: 'send-root',
			owner,
			attemptNumber: second.attempt.attemptNumber,
			receipt: accepted
		})
		expect(() =>
			db.markWorkflowEffectReceiptLost({
				runId: run.id,
				actionId: 'send-root',
				expectedReceipt: { kind: 'outbox', id: 'different' },
				errorCode: 'accepted_receipt_lost',
				errorMessage: 'Accepted row disappeared.'
			})
		).toThrow(WorkflowTransitionError)
		expect(
			db.markWorkflowEffectReceiptLost({
				runId: run.id,
				actionId: 'send-root',
				expectedReceipt: accepted,
				errorCode: 'accepted_receipt_lost',
				errorMessage: 'Accepted row disappeared.',
				evidence: { checkedAt: 123 }
			})
		).toMatchObject({ state: 'ambiguous', receipt: accepted })
		expect(db.listWorkflowEffectAttempts(second.effect.id).at(-1)).toMatchObject({
			state: 'ambiguous',
			evidence: { checkedAt: 123 }
		})
		db.close()
	})
})

describe('OrchestrationDb capabilities and public projection', () => {
	test('stores only capability hashes and consumes a capability once at exact coordinates', () => {
		const file = databaseFile()
		const db = new OrchestrationDb(file)
		const run = startExisting(db).run
		const token = `wfcap_${'secret-value-'.repeat(5)}`
		const tokenHash = hashCapabilityToken(token)
		const capabilityId = db.issueWorkflowCapability({
			tokenHash,
			runId: run.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			issuedWith: { rowid: 44, turnId: 'turn-1' },
			eventKey: 'capability-initial'
		})

		expect(readFileSync(file).includes(Buffer.from(token))).toBe(false)
		expect(
			db.consumeWorkflowCapability({
				tokenHash,
				runId: run.id,
				rootSessionId: 'root-1',
				role: 'exploration',
				expectedPhase: 'pending_root',
				expectedCycle: 0,
				expectedRevision: 0,
				eventKey: 'consume-initial'
			})
		).toBe(capabilityId)
		expect(() =>
			db.consumeWorkflowCapability({
				tokenHash,
				runId: run.id,
				rootSessionId: 'root-1',
				role: 'exploration',
				expectedPhase: 'pending_root',
				expectedCycle: 0,
				expectedRevision: 0,
				eventKey: 'consume-again'
			})
		).toThrow(WorkflowTransitionError)
		db.close()
	})

	test('composes capability consumption, transition, and job creation in one idempotent transaction', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		const tokenHash = hashCapabilityToken(`wfcap_${'a'.repeat(32)}`)
		db.issueWorkflowCapability({
			tokenHash,
			runId: run.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			eventKey: 'issue-compose-capability'
		})
		const mutate = () =>
			db.idempotentMutation('delegate', 'delegate-client', { role: 'exploration', prompt: 'Investigate.' }, () => {
				db.consumeWorkflowCapability({
					tokenHash,
					runId: run.id,
					rootSessionId: 'root-1',
					role: 'exploration',
					expectedPhase: 'pending_root',
					expectedCycle: 0,
					expectedRevision: 0,
					eventKey: 'consume-compose-capability'
				})
				db.transitionWorkflowRun({
					runId: run.id,
					expectedPhase: 'pending_root',
					expectedCancellationGeneration: 0,
					phase: 'exploring',
					revision: 1,
					eventKey: 'compose-transition',
					eventType: 'exploration_requested'
				})
				const job = db.createWorkflowJob({
					runId: run.id,
					logicalKey: 'explore:1',
					role: 'exploration',
					resolvedRole: roles.exploration,
					prompt: 'Investigate.',
					expectedCancellationGeneration: 0,
					eventKey: 'compose-job'
				}).job
				return { runId: run.id, jobId: job.id }
			})

		const first = mutate()
		const repeated = mutate()
		expect(first.replayed).toBe(false)
		expect(repeated).toEqual({ replayed: true, result: first.result })
		expect(db.getWorkflowRun(run.id)).toMatchObject({ phase: 'exploring', revision: 1 })
		expect(db.listWorkflowJobs(run.id).filter(job => job.logicalKey === 'explore:1')).toHaveLength(1)
		expect(db.getWorkflowCapability(tokenHash)?.consumedAt).toBeTypeOf('number')
		db.close()
	})

	test('projects bounded, scrubbed public data without private roles or execution evidence', () => {
		const db = new OrchestrationDb(databaseFile())
		const capability = workflowCapabilityToken('x'.repeat(43))
		const envelope = workflowPrivateEnvelope({
			workflowId: 'private-workflow',
			phaseCapability: capability,
			cycle: 1,
			revision: 0,
			allowedRoles: ['exploration']
		})
		const run = startExisting(db, {
			objective: `Visible objective ${envelope} tail ${capability}`
		}).run
		const candidates = Array.from({ length: 25 }, (_, index) => ({
			id: `candidate-${index}`,
			title: index === 0 ? `Possible ${capability}` : `Possible ${index}`,
			repo: 'conductor-remote',
			createdAt: 1_000 + index,
			kind: 'workspace' as const
		}))
		db.transitionWorkflowRun({
			runId: run.id,
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'create-workspace',
				errorCode: 'ambiguous_effect',
				message: `Could have landed ${capability} [window server: 6; screen: locked] [processes: conductor=0]`,
				resumePhase: 'creating_workspace',
				retryClass: 'ambiguous',
				candidates
			},
			eventKey: 'blocked-create',
			eventType: 'workflow_blocked'
		})

		const projection = db.getWorkflowProjection(run.id)
		expect(projection).toMatchObject({
			phase: 'blocked',
			jobs: { exploration: { requested: 1 }, implementation: { requested: 0 } },
			actions: { canRetry: false, canAdopt: true, canReplayAmbiguous: true, canCancel: true },
			adoption: { actionId: 'create-workspace', kind: 'workspace' }
		})
		expect(projection?.adoption?.candidates).toHaveLength(20)
		const rendered = JSON.stringify(projection)
		expect(rendered).not.toContain(capability)
		expect(rendered).not.toContain('phase_capability')
		expect(rendered).not.toContain('PRIVATE PLANNING PREAMBLE')
		expect(rendered).not.toContain('deliveryBaseline')
		expect(rendered).not.toContain('cancellationGeneration')
		expect(rendered).not.toContain('window server')
		expect(projection?.error?.message).toBe('Could have landed [Workflow capability hidden]')
		db.close()
	})

	test('keeps an ambiguous action id public when reconciliation found no adoption candidate', () => {
		const db = new OrchestrationDb(databaseFile())
		const run = startExisting(db).run
		db.transitionWorkflowRun({
			runId: run.id,
			expectedCancellationGeneration: 0,
			phase: 'blocked',
			blocked: {
				actionId: 'send-root',
				errorCode: 'ambiguous_effect',
				message: 'The root send may have landed.',
				resumePhase: 'pending_root',
				retryClass: 'ambiguous',
				candidates: []
			},
			eventKey: 'blocked-send',
			eventType: 'workflow_blocked'
		})

		expect(db.getWorkflowProjection(run.id)).toMatchObject({
			actions: { canAdopt: false, canReplayAmbiguous: true },
			adoption: { actionId: 'send-root', kind: 'session', candidates: [] }
		})
		db.close()
	})
})

describe('OrchestrationDb relay ownership and global UI mutex', () => {
	test('keeps a shared lease gated until its caller persists the external process identity', async () => {
		const owner = relay('shared-provider', 490)
		let externalAlive = true
		const db = new OrchestrationDb(databaseFile(), {
			processProbe: identity => (identity.pid === 492 ? externalAlive : true)
		})
		db.registerRelayInstance(owner)
		const provider = db.createSharedUiLeaseProvider(owner, { leaseMs: 5_000 })

		const lease = await provider.acquire({ priority: 'background', actionId: 'gated-wrapper' })
		expect(db.getUiLeaseOwner()).toMatchObject({ actionId: 'gated-wrapper', mayExecute: false })
		await lease.markMayExecute({ pid: 491, processStartedAt: 'wrapper-start', processGroup: 491 })
		expect(db.getUiLeaseOwner()).toMatchObject({
			actionId: 'gated-wrapper',
			mayExecute: true,
			externalProcess: { pid: 491, processStartedAt: 'wrapper-start', processGroup: 491 }
		})
		await lease.markMayExecute({ pid: 492, processStartedAt: 'wrapper-without-group' })
		expect(db.getUiLeaseOwner()?.externalProcess).toEqual({
			pid: 492,
			processStartedAt: 'wrapper-without-group'
		})
		expect(() => lease.release()).toThrow('external process is still live')
		expect(db.getUiLeaseOwner()).toMatchObject({ actionId: 'gated-wrapper', mayExecute: true })
		externalAlive = false
		await lease.release()
		expect(db.getUiLeaseOwner()).toBeUndefined()
		db.close()
	})

	test('does not steal a live paused owner and checks nonce plus process-start identity on release', () => {
		const file = databaseFile()
		const alive = new Set(['501:start-501', '502:start-502'])
		const processProbe = ({ pid, processStartedAt }: { pid: number; processStartedAt: string }) =>
			alive.has(`${pid}:${processStartedAt}`)
		const db1 = new OrchestrationDb(file, { processProbe })
		const db2 = new OrchestrationDb(file, { processProbe })
		const owner = relay('relay-owner', 501)
		const contender = relay('relay-contender', 502)
		expect(() =>
			db1.acquireUiLease({
				owner,
				actionId: 'unregistered',
				deadlineAt: 1,
				priority: 'background'
			})
		).toThrow('not registered')
		db1.registerRelayInstance(owner)
		db2.registerRelayInstance(contender)

		const acquired = db1.acquireUiLease({
			owner,
			actionId: 'ordinary-send:1',
			deadlineAt: 1,
			priority: 'background',
			nonce: 'owner-nonce'
		})
		expect(acquired.status).toBe('acquired')
		const busy = db2.acquireUiLease({
			owner: contender,
			actionId: 'ordinary-send:2',
			deadlineAt: 2,
			priority: 'interactive'
		})
		expect(busy).toMatchObject({ status: 'busy', reason: 'owner_alive' })

		if (acquired.status !== 'acquired') throw new Error('expected lease')
		expect(db1.releaseUiLease({ ...acquired.lease, nonce: 'wrong-nonce' })).toBe(false)
		expect(db1.getUiLeaseOwner()?.nonce).toBe('owner-nonce')

		// A reused PID with a different start identity does not keep the old lease alive.
		alive.delete('501:start-501')
		alive.add('501:reused-start')
		const reclaimed = db2.acquireUiLease({
			owner: contender,
			actionId: 'ordinary-send:2',
			deadlineAt: 3,
			priority: 'interactive',
			nonce: 'contender-nonce'
		})
		expect(reclaimed).toMatchObject({
			status: 'acquired',
			reclaimed: { instanceId: 'relay-owner', processStartedAt: 'start-501', nonce: 'owner-nonce' }
		})
		if (reclaimed.status !== 'acquired') throw new Error('expected reclaimed lease')
		expect(db1.releaseUiLease(acquired.lease)).toBe(false)
		expect(db2.releaseUiLease(reclaimed.lease)).toBe(true)
		db1.close()
		db2.close()
	})

	test('waits for a live external process, then persistently quarantines potentially emitted work', () => {
		const file = databaseFile()
		const alive = new Set(['601:start-601', '602:start-602', '701:external-701'])
		let groupChildAlive = true
		const processProbe = ({
			pid,
			processStartedAt,
			processGroup
		}: {
			pid: number
			processStartedAt: string
			processGroup?: number
		}) => alive.has(`${pid}:${processStartedAt}`) || (processGroup === 701 && groupChildAlive)
		const owner = relay('relay-owner', 601)
		const contender = relay('relay-contender', 602)
		const db1 = new OrchestrationDb(file, { processProbe })
		const db2 = new OrchestrationDb(file, { processProbe })
		const run = startExisting(db1).run
		db1.registerRelayInstance(owner)
		db2.registerRelayInstance(contender)
		const acquired = db1.acquireUiLease({
			owner,
			actionId: 'open-child',
			effectId: 'effect-1',
			deadlineAt: 10,
			priority: 'background'
		})
		if (acquired.status !== 'acquired') throw new Error('expected lease')
		expect(
			db1.markUiLeaseMayExecute(acquired.lease, {
				pid: 701,
				processStartedAt: 'external-701',
				processGroup: 701
			})
		).toBe(true)
		alive.delete('601:start-601')

		expect(
			db2.acquireUiLease({
				owner: contender,
				actionId: 'next-effect',
				deadlineAt: 20,
				priority: 'background'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })

		alive.delete('701:external-701')
		expect(
			db2.acquireUiLease({
				owner: contender,
				actionId: 'next-effect',
				deadlineAt: 20,
				priority: 'background'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })
		groupChildAlive = false
		const held = db2.acquireUiLease({
			owner: contender,
			actionId: 'next-effect',
			deadlineAt: 20,
			priority: 'background'
		})
		expect(held).toMatchObject({
			status: 'quarantined',
			quarantine: { active: true, actionId: 'open-child', effectId: 'effect-1' }
		})
		db2.cancelWorkflowRun(run.id, 'cancel-does-not-clear-quarantine')
		expect(db2.getUiQuarantine()).toMatchObject({ active: true, actionId: 'open-child' })
		db1.close()
		db2.close()

		const restarted = new OrchestrationDb(file, { processProbe })
		expect(restarted.getUiQuarantine()).toMatchObject({ active: true, actionId: 'open-child' })
		const interactive = restarted.acquireUiLease({
			owner: contender,
			actionId: 'phone-recovery',
			deadlineAt: 30,
			priority: 'interactive'
		})
		expect(interactive.status).toBe('acquired')
		if (interactive.status !== 'acquired') throw new Error('expected phone recovery lease')
		expect(restarted.releaseUiLease(interactive.lease)).toBe(true)
		expect(restarted.clearUiQuarantine('phone-client-id')).toBe(true)
		expect(restarted.getUiQuarantine().active).toBe(false)
		restarted.close()
	})

	test('restarts acquisition when the owner persists an external process during the liveness probe', () => {
		const file = databaseFile()
		const owner = relay('lease-race-owner', 750)
		const contender = relay('lease-race-contender', 751)
		let externalAlive = true
		const ownerDb = new OrchestrationDb(file, {
			processProbe: identity => identity.pid !== 752 || externalAlive
		})
		ownerDb.registerRelayInstance(owner)
		ownerDb.registerRelayInstance(contender)
		const acquired = ownerDb.acquireUiLease({
			owner,
			actionId: 'race-effect',
			effectId: 'race-effect-id',
			deadlineAt: 1,
			priority: 'background',
			nonce: 'race-owner-nonce'
		})
		if (acquired.status !== 'acquired') throw new Error('expected owner lease')

		let injected = false
		const contenderDb = new OrchestrationDb(file, {
			processProbe: identity => {
				if (identity.pid === owner.pid && !injected) {
					injected = true
					expect(
						ownerDb.markUiLeaseMayExecute(acquired.lease, {
							pid: 752,
							processStartedAt: 'external-during-probe',
							processGroup: 752
						})
					).toBe(true)
					return false
				}
				return identity.pid === 752
			}
		})
		expect(
			contenderDb.acquireUiLease({
				owner: contender,
				actionId: 'interactive-recovery',
				deadlineAt: 2,
				priority: 'interactive'
			})
		).toMatchObject({ status: 'busy', reason: 'changed' })
		expect(
			contenderDb.acquireUiLease({
				owner: contender,
				actionId: 'interactive-recovery',
				deadlineAt: 3,
				priority: 'interactive'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })
		externalAlive = false
		expect(ownerDb.releaseUiLease(acquired.lease)).toBe(true)
		ownerDb.close()
		contenderDb.close()
	})

	test('reports only live, UI-capable registrations on another protocol as incompatible', () => {
		const alive = new Set(['801:start-801', '802:start-802', '803:start-803'])
		const db = new OrchestrationDb(databaseFile(), {
			processProbe: process => alive.has(`${process.pid}:${process.processStartedAt}`)
		})
		const current = relay('current', 801)
		db.registerRelayInstance(current)
		db.registerRelayInstance({ ...relay('old-live', 802), protocolVersion: 0 })
		db.registerRelayInstance({ ...relay('old-read-only', 803), protocolVersion: 0, canDriveUi: false })
		db.registerRelayInstance(relay('same-protocol', 804))

		expect(db.findIncompatibleRelayInstances(current).map(instance => instance.instanceId)).toEqual(['old-live'])
		alive.delete('802:start-802')
		expect(db.findIncompatibleRelayInstances(current)).toEqual([])
		db.close()
	})
})

describe('OrchestrationDb bounded retention', () => {
	test('compacts only old terminal detail and retains its stable idempotency mapping plus summary', () => {
		let clock = 1_000
		const file = databaseFile()
		const db = new OrchestrationDb(file, { now: () => clock++ })
		const terminal = startExisting(db).run
		const capabilityHash = hashCapabilityToken(`wfcap_${'c'.repeat(32)}`)
		db.issueWorkflowCapability({
			tokenHash: capabilityHash,
			runId: terminal.id,
			rootSessionId: 'root-1',
			cycle: 0,
			phase: 'pending_root',
			revision: 0,
			allowedRoles: ['exploration'],
			eventKey: 'cap-before-compaction'
		})
		db.transitionWorkflowRun({
			runId: terminal.id,
			expectedCancellationGeneration: 0,
			phase: 'completed',
			eventKey: 'complete-before-compaction',
			eventType: 'workflow_completed'
		})
		const active = startExisting(db, {
			clientId: 'active-client',
			target: { kind: 'existing_session', workspaceId: 'workspace-2', sessionId: 'root-2' }
		}).run

		expect(db.compactTerminalRuns({ olderThan: 10_000, limit: 1 })).toBe(1)
		expect(db.listWorkflowJobs(terminal.id)).toEqual([])
		expect(db.listWorkflowEffects(terminal.id)).toEqual([])
		expect(db.listWorkflowEvents(terminal.id)).toMatchObject([
			{
				eventKey: 'terminal_compacted',
				type: 'terminal_compacted',
				data: {
					jobs: { exploration: { cancelled: 0, failed: 0, returned: 0 } },
					effects: { prepared: 1 }
				}
			}
		])
		expect(db.getWorkflowRun(active.id)?.phase).toBe('pending_root')
		expect(db.listWorkflowJobs(active.id)).toHaveLength(1)
		expect(
			db.getIdempotentMutation<{ runId: string }>('start_workflow', 'start-client', {
				objective: 'Build a deterministic pipeline',
				target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' }
			})?.result.runId
		).toBe(terminal.id)
		expect(db.compactTerminalRuns({ olderThan: 10_000, limit: 1 })).toBe(0)

		const raw = new DatabaseSync(file, { readOnly: true })
		expect(
			(
				raw.prepare('SELECT COUNT(*) count FROM workflow_capabilities WHERE run_id = ?').get(terminal.id) as {
					count: number
				}
			).count
		).toBe(0)
		expect(
			(
				raw.prepare('SELECT COUNT(*) count FROM workflow_idempotency WHERE run_id = ?').get(terminal.id) as {
					count: number
				}
			).count
		).toBe(1)
		raw.close()
		db.close()
	})
})
