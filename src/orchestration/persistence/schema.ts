import { getTableName, sql } from 'drizzle-orm'
import {
	type AnySQLiteColumn,
	check,
	customType,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
	uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { createSelectSchema, jsonSchema } from 'drizzle-orm/zod'
import { z } from 'zod'
import type { ResolvedDelegatedRole, WorkflowChildRoleName, WorkflowPhase, WorkflowRoleName } from '../../wire.ts'
import type { FrozenWorkflowRoles } from '../workflow/prompts.ts'

export { ORCHESTRATION_BOOTSTRAP_SQL } from './schema.generated.ts'

export const ORCHESTRATION_SCHEMA_VERSION = 1

export const WORKFLOW_PHASES = [
	'creating_workspace',
	'binding_root',
	'pending_root',
	'exploring',
	'planning',
	'implementing',
	'reviewing',
	'blocked',
	'completed',
	'cancelled'
] as const satisfies readonly WorkflowPhase[]

export const RESUMABLE_WORKFLOW_PHASES = [
	'creating_workspace',
	'binding_root',
	'pending_root',
	'exploring',
	'planning',
	'implementing',
	'reviewing'
] as const satisfies readonly WorkflowPhase[]

export const WORKFLOW_JOB_ROLES = ['exploration', 'implementation'] as const satisfies readonly WorkflowChildRoleName[]
export const WORKFLOW_JOB_STATES = [
	'dormant',
	'queued',
	'owned',
	'opening',
	'configuring',
	'sending',
	'running',
	'returning',
	'returned',
	'failed',
	'cancelled'
] as const
export const WORKFLOW_EFFECT_STATES = [
	'prepared',
	'dispatched',
	'committed',
	'failed',
	'ambiguous',
	'cancelled'
] as const
export const WORKFLOW_RETRY_CLASSES = ['deterministic', 'ambiguous', 'terminal'] as const

export type WorkflowJobRole = (typeof WORKFLOW_JOB_ROLES)[number]
export type WorkflowJobState = (typeof WORKFLOW_JOB_STATES)[number]
export type WorkflowEffectState = (typeof WORKFLOW_EFFECT_STATES)[number]
export type WorkflowRetryClass = (typeof WORKFLOW_RETRY_CLASSES)[number]

const agentEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
const workflowRoleNames = ['planning', 'exploration', 'implementation'] as const satisfies readonly WorkflowRoleName[]

export const workflowTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('new_workspace'), repo: z.string(), sendImmediately: z.boolean() }),
	z.object({ kind: z.literal('existing_session'), workspaceId: z.string(), sessionId: z.string() })
])
export type WorkflowTarget = z.infer<typeof workflowTargetSchema>

export const resolvedWorkflowRoleSchema: z.ZodType<ResolvedDelegatedRole> = z.object({
	model: z.string(),
	agentType: z.string(),
	effort: z.enum(agentEfforts).optional(),
	fast: z.boolean().optional(),
	preamble: z.string().optional()
})

export const frozenWorkflowRolesSchema: z.ZodType<FrozenWorkflowRoles> = z.object(
	Object.fromEntries(workflowRoleNames.map(role => [role, resolvedWorkflowRoleSchema])) as Record<
		WorkflowRoleName,
		typeof resolvedWorkflowRoleSchema
	>
)

export const workflowAdoptionCandidateSchema = z.object({
	id: z.string(),
	title: z.string(),
	repo: z.string(),
	createdAt: z.number(),
	kind: z.enum(['workspace', 'session']).optional()
})
export type WorkflowAdoptionCandidate = z.infer<typeof workflowAdoptionCandidateSchema>

const relayOwnerColumns = () => ({
	ownerInstanceId: text('owner_instance_id'),
	ownerPid: integer('owner_pid'),
	ownerProcessStartedAt: text('owner_process_started_at'),
	ownerProtocolVersion: integer('owner_protocol_version')
})

const externalProcessColumns = () => ({
	externalPid: integer('external_pid'),
	externalProcessStartedAt: text('external_process_started_at'),
	externalProcessGroup: integer('external_process_group')
})

const timestamps = () => ({
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	terminalAt: integer('terminal_at')
})

const jsonColumn = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()
export interface StoredJson<T> {
	value: T
}
const optionalJsonColumn = <T>(name: string) =>
	customType<{ data: StoredJson<T>; driverData: string }>({
		dataType: () => 'text',
		fromDriver: value => ({ value: JSON.parse(value) as T }),
		toDriver: stored => JSON.stringify(stored.value)
	})(name)
const requiredJson = (name: string, column: AnySQLiteColumn) => check(name, sql`json_valid(${column})`)
const optionalJson = (name: string, column: AnySQLiteColumn) =>
	check(name, sql`${column} IS NULL OR json_valid(${column})`)
const enumCheck = (column: AnySQLiteColumn, values: readonly string[]) =>
	sql`${column} IN (${sql.raw(values.map(value => `'${value}'`).join(', '))})`

export const orchestrationMeta = sqliteTable('orchestration_meta', {
	key: text().primaryKey(),
	value: text().notNull()
})

export const workflowRuns = sqliteTable(
	'workflow_runs',
	{
		id: text().primaryKey(),
		objective: text().notNull(),
		target: jsonColumn<WorkflowTarget>('target_json').notNull(),
		roles: jsonColumn<FrozenWorkflowRoles>('roles_json').notNull(),
		phase: text({ enum: WORKFLOW_PHASES }).notNull(),
		cycle: integer().notNull().default(0),
		revision: integer().notNull().default(0),
		workspaceId: text('workspace_id'),
		rootSessionId: text('root_session_id'),
		pristineEvidence: optionalJsonColumn<unknown>('pristine_evidence_json'),
		deliveryBaseline: optionalJsonColumn<unknown>('delivery_baseline_json'),
		planningInterpretation: text('planning_interpretation'),
		cancellationGeneration: integer('cancellation_generation').notNull().default(0),
		blockedActionId: text('blocked_action_id'),
		blockedErrorCode: text('blocked_error_code'),
		blockedMessage: text('blocked_message'),
		resumePhase: text('resume_phase', { enum: RESUMABLE_WORKFLOW_PHASES }),
		retryClass: text('retry_class', { enum: WORKFLOW_RETRY_CLASSES }),
		blockedCandidates: optionalJsonColumn<WorkflowAdoptionCandidate[]>('blocked_candidates_json'),
		blockedAt: integer('blocked_at'),
		implementationBatonsDelivered: integer('implementation_batons_delivered').notNull().default(0),
		...timestamps()
	},
	table => [
		requiredJson('workflow_runs_target_json_valid', table.target),
		requiredJson('workflow_runs_roles_json_valid', table.roles),
		check('workflow_runs_phase_valid', enumCheck(table.phase, WORKFLOW_PHASES)),
		check('workflow_runs_cycle_nonnegative', sql`${table.cycle} >= 0`),
		check('workflow_runs_revision_nonnegative', sql`${table.revision} >= 0`),
		optionalJson('workflow_runs_pristine_evidence_json_valid', table.pristineEvidence),
		optionalJson('workflow_runs_delivery_baseline_json_valid', table.deliveryBaseline),
		check('workflow_runs_cancellation_generation_nonnegative', sql`${table.cancellationGeneration} >= 0`),
		check(
			'workflow_runs_resume_phase_valid',
			sql`${table.resumePhase} IS NULL OR ${enumCheck(table.resumePhase, RESUMABLE_WORKFLOW_PHASES)}`
		),
		check(
			'workflow_runs_retry_class_valid',
			sql`${table.retryClass} IS NULL OR ${enumCheck(table.retryClass, WORKFLOW_RETRY_CLASSES)}`
		),
		optionalJson('workflow_runs_blocked_candidates_json_valid', table.blockedCandidates),
		check('workflow_runs_implementation_batons_nonnegative', sql`${table.implementationBatonsDelivered} >= 0`),
		uniqueIndex('workflow_runs_one_active_root')
			.on(table.rootSessionId)
			.where(sql`${table.rootSessionId} IS NOT NULL AND ${table.phase} NOT IN ('completed', 'cancelled')`),
		index('workflow_runs_active_updated')
			.on(table.phase, table.updatedAt)
			.where(sql`${table.phase} NOT IN ('completed', 'cancelled')`),
		index('workflow_runs_workspace_active')
			.on(table.workspaceId, table.phase)
			.where(sql`${table.phase} NOT IN ('completed', 'cancelled')`)
	]
)

export const workflowCapabilities = sqliteTable(
	'workflow_capabilities',
	{
		id: text().primaryKey(),
		tokenHash: text('token_hash').notNull().unique(),
		runId: text('run_id')
			.notNull()
			.references(() => workflowRuns.id, { onDelete: 'cascade' }),
		rootSessionId: text('root_session_id').notNull(),
		cycle: integer().notNull(),
		phase: text({ enum: WORKFLOW_PHASES }).notNull(),
		revision: integer().notNull(),
		allowedRoles: jsonColumn<WorkflowJobRole[]>('allowed_roles_json').notNull(),
		issuedWithRowid: integer('issued_with_rowid'),
		issuedWithTurnId: text('issued_with_turn_id'),
		consumedAt: integer('consumed_at'),
		revokedAt: integer('revoked_at'),
		createdAt: integer('created_at').notNull()
	},
	table => [
		check('workflow_capabilities_token_hash_length', sql`length(${table.tokenHash}) = 64`),
		check('workflow_capabilities_cycle_nonnegative', sql`${table.cycle} >= 0`),
		check('workflow_capabilities_revision_nonnegative', sql`${table.revision} >= 0`),
		requiredJson('workflow_capabilities_allowed_roles_json_valid', table.allowedRoles),
		index('workflow_capabilities_current')
			.on(table.runId, table.phase, table.cycle, table.revision)
			.where(sql`${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`)
	]
)

export const workflowJobs = sqliteTable(
	'workflow_jobs',
	{
		id: text().primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => workflowRuns.id, { onDelete: 'cascade' }),
		logicalKey: text('logical_key').notNull(),
		role: text({ enum: WORKFLOW_JOB_ROLES }).notNull(),
		cycle: integer().notNull(),
		revision: integer().notNull(),
		resolvedRole: jsonColumn<ResolvedDelegatedRole>('resolved_role_json').notNull(),
		prompt: text().notNull(),
		state: text({ enum: WORKFLOW_JOB_STATES }).notNull(),
		cancellationGeneration: integer('cancellation_generation').notNull(),
		...relayOwnerColumns(),
		transcriptCursor: optionalJsonColumn<unknown>('transcript_cursor_json'),
		childSessionId: text('child_session_id'),
		outcome: optionalJsonColumn<unknown>('outcome_json'),
		taskReceipt: optionalJsonColumn<unknown>('task_receipt_json'),
		batonReceipt: optionalJsonColumn<unknown>('baton_receipt_json'),
		attemptCount: integer('attempt_count').notNull().default(0),
		...timestamps()
	},
	table => [
		check('workflow_jobs_role_valid', enumCheck(table.role, WORKFLOW_JOB_ROLES)),
		check('workflow_jobs_cycle_nonnegative', sql`${table.cycle} >= 0`),
		check('workflow_jobs_revision_nonnegative', sql`${table.revision} >= 0`),
		requiredJson('workflow_jobs_resolved_role_json_valid', table.resolvedRole),
		check('workflow_jobs_state_valid', enumCheck(table.state, WORKFLOW_JOB_STATES)),
		check('workflow_jobs_cancellation_generation_nonnegative', sql`${table.cancellationGeneration} >= 0`),
		optionalJson('workflow_jobs_transcript_cursor_json_valid', table.transcriptCursor),
		optionalJson('workflow_jobs_outcome_json_valid', table.outcome),
		optionalJson('workflow_jobs_task_receipt_json_valid', table.taskReceipt),
		optionalJson('workflow_jobs_baton_receipt_json_valid', table.batonReceipt),
		check('workflow_jobs_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
		unique('workflow_jobs_run_logical_key_unique').on(table.runId, table.logicalKey),
		index('workflow_jobs_runnable').on(table.state, table.createdAt).where(sql`${table.state} = 'queued'`),
		index('workflow_jobs_run_state').on(table.runId, table.role, table.state)
	]
)

export const workflowJobAttempts = sqliteTable(
	'workflow_job_attempts',
	{
		id: text().primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => workflowJobs.id, { onDelete: 'cascade' }),
		attemptNumber: integer('attempt_number').notNull(),
		state: text({ enum: WORKFLOW_JOB_STATES }).notNull(),
		childSessionId: text('child_session_id'),
		openEffectId: text('open_effect_id'),
		configureEffectId: text('configure_effect_id'),
		taskEffectId: text('task_effect_id'),
		batonEffectId: text('baton_effect_id'),
		outcome: optionalJsonColumn<unknown>('outcome_json'),
		failureEvidence: optionalJsonColumn<unknown>('failure_evidence_json'),
		...relayOwnerColumns(),
		...timestamps()
	},
	table => [
		check('workflow_job_attempts_attempt_positive', sql`${table.attemptNumber} > 0`),
		check('workflow_job_attempts_state_valid', enumCheck(table.state, WORKFLOW_JOB_STATES)),
		optionalJson('workflow_job_attempts_outcome_json_valid', table.outcome),
		optionalJson('workflow_job_attempts_failure_evidence_json_valid', table.failureEvidence),
		unique('workflow_job_attempts_job_number_unique').on(table.jobId, table.attemptNumber)
	]
)

export const workflowEffects = sqliteTable(
	'workflow_effects',
	{
		id: text().primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => workflowRuns.id, { onDelete: 'cascade' }),
		actionId: text('action_id').notNull(),
		jobId: text('job_id').references(() => workflowJobs.id, { onDelete: 'cascade' }),
		kind: text().notNull(),
		state: text({ enum: WORKFLOW_EFFECT_STATES }).notNull(),
		target: optionalJsonColumn<unknown>('target_json'),
		inputs: optionalJsonColumn<unknown>('inputs_json'),
		baseline: optionalJsonColumn<unknown>('baseline_json'),
		cursor: optionalJsonColumn<unknown>('cursor_json'),
		receipt: optionalJsonColumn<unknown>('receipt_json'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		...relayOwnerColumns(),
		launchNonce: text('launch_nonce'),
		...externalProcessColumns(),
		mayExecute: integer('may_execute', { mode: 'boolean' }).notNull().default(false),
		attemptCount: integer('attempt_count').notNull().default(0),
		...timestamps()
	},
	table => [
		check('workflow_effects_state_valid', enumCheck(table.state, WORKFLOW_EFFECT_STATES)),
		optionalJson('workflow_effects_target_json_valid', table.target),
		optionalJson('workflow_effects_inputs_json_valid', table.inputs),
		optionalJson('workflow_effects_baseline_json_valid', table.baseline),
		optionalJson('workflow_effects_cursor_json_valid', table.cursor),
		optionalJson('workflow_effects_receipt_json_valid', table.receipt),
		check('workflow_effects_may_execute_boolean', sql`${table.mayExecute} IN (0, 1)`),
		check('workflow_effects_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
		unique('workflow_effects_run_action_unique').on(table.runId, table.actionId),
		index('workflow_effects_runnable').on(table.state, table.updatedAt).where(sql`${table.state} = 'prepared'`),
		index('workflow_effects_run_state').on(table.runId, table.state)
	]
)

export const workflowEffectAttempts = sqliteTable(
	'workflow_effect_attempts',
	{
		id: text().primaryKey(),
		effectId: text('effect_id')
			.notNull()
			.references(() => workflowEffects.id, { onDelete: 'cascade' }),
		attemptNumber: integer('attempt_number').notNull(),
		state: text({ enum: WORKFLOW_EFFECT_STATES }).notNull(),
		ownerInstanceId: text('owner_instance_id').notNull(),
		ownerPid: integer('owner_pid').notNull(),
		ownerProcessStartedAt: text('owner_process_started_at').notNull(),
		ownerProtocolVersion: integer('owner_protocol_version').notNull(),
		launchNonce: text('launch_nonce'),
		...externalProcessColumns(),
		mayExecute: integer('may_execute', { mode: 'boolean' }).notNull().default(false),
		receipt: optionalJsonColumn<unknown>('receipt_json'),
		evidence: optionalJsonColumn<unknown>('evidence_json'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		...timestamps()
	},
	table => [
		check('workflow_effect_attempts_attempt_positive', sql`${table.attemptNumber} > 0`),
		check('workflow_effect_attempts_state_valid', enumCheck(table.state, WORKFLOW_EFFECT_STATES)),
		check('workflow_effect_attempts_may_execute_boolean', sql`${table.mayExecute} IN (0, 1)`),
		optionalJson('workflow_effect_attempts_receipt_json_valid', table.receipt),
		optionalJson('workflow_effect_attempts_evidence_json_valid', table.evidence),
		unique('workflow_effect_attempts_effect_number_unique').on(table.effectId, table.attemptNumber)
	]
)

export const workflowEvents = sqliteTable(
	'workflow_events',
	{
		id: integer().primaryKey({ autoIncrement: true }),
		runId: text('run_id')
			.notNull()
			.references(() => workflowRuns.id, { onDelete: 'cascade' }),
		eventKey: text('event_key').notNull(),
		type: text().notNull(),
		data: optionalJsonColumn<unknown>('data_json'),
		createdAt: integer('created_at').notNull()
	},
	table => [
		optionalJson('workflow_events_data_json_valid', table.data),
		unique('workflow_events_run_event_key_unique').on(table.runId, table.eventKey),
		index('workflow_events_run').on(table.runId, table.id)
	]
)

export const workflowIdempotency = sqliteTable(
	'workflow_idempotency',
	{
		operation: text().notNull(),
		clientId: text('client_id').notNull(),
		requestHash: text('request_hash').notNull(),
		result: jsonColumn<unknown>('result_json').notNull(),
		runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
		actionId: text('action_id'),
		createdAt: integer('created_at').notNull()
	},
	table => [
		primaryKey({ columns: [table.operation, table.clientId] }),
		check('workflow_idempotency_request_hash_length', sql`length(${table.requestHash}) = 64`),
		requiredJson('workflow_idempotency_result_json_valid', table.result)
	]
)

export const relayInstances = sqliteTable(
	'relay_instances',
	{
		instanceId: text('instance_id').primaryKey(),
		pid: integer().notNull(),
		processStartedAt: text('process_started_at').notNull(),
		protocolVersion: integer('protocol_version').notNull(),
		canDriveUi: integer('can_drive_ui', { mode: 'boolean' }).notNull().default(true),
		heartbeatAt: integer('heartbeat_at').notNull(),
		registeredAt: integer('registered_at').notNull(),
		metadata: optionalJsonColumn<unknown>('metadata_json')
	},
	table => [
		check('relay_instances_can_drive_ui_boolean', sql`${table.canDriveUi} IN (0, 1)`),
		optionalJson('relay_instances_metadata_json_valid', table.metadata),
		index('relay_instances_protocol').on(table.canDriveUi, table.protocolVersion, table.heartbeatAt)
	]
)

export const uiMutex = sqliteTable(
	'ui_mutex',
	{
		id: integer().primaryKey(),
		...relayOwnerColumns(),
		nonce: text(),
		actionId: text('action_id'),
		effectId: text('effect_id'),
		...externalProcessColumns(),
		mayExecute: integer('may_execute', { mode: 'boolean' }).notNull().default(false),
		deadlineAt: integer('deadline_at'),
		acquiredAt: integer('acquired_at'),
		updatedAt: integer('updated_at')
	},
	table => [
		check('ui_mutex_singleton', sql`${table.id} = 1`),
		check('ui_mutex_may_execute_boolean', sql`${table.mayExecute} IN (0, 1)`)
	]
)

export const uiQuarantine = sqliteTable(
	'ui_quarantine',
	{
		id: integer().primaryKey(),
		active: integer({ mode: 'boolean' }).notNull().default(false),
		actionId: text('action_id'),
		effectId: text('effect_id'),
		reason: text(),
		...relayOwnerColumns(),
		...externalProcessColumns(),
		createdAt: integer('created_at'),
		clearedAt: integer('cleared_at'),
		clearedBy: text('cleared_by')
	},
	table => [
		check('ui_quarantine_singleton', sql`${table.id} = 1`),
		check('ui_quarantine_active_boolean', sql`${table.active} IN (0, 1)`)
	]
)

export const orchestrationSchema = {
	orchestrationMeta,
	workflowRuns,
	workflowCapabilities,
	workflowJobs,
	workflowJobAttempts,
	workflowEffects,
	workflowEffectAttempts,
	workflowEvents,
	workflowIdempotency,
	relayInstances,
	uiMutex,
	uiQuarantine
}

export const ORCHESTRATION_TABLE_NAMES = Object.values(orchestrationSchema).map(getTableName)

const optionalStoredJsonSchema = <T>(value: z.ZodType<T>) => z.object({ value }).nullable()
const optionalUnknownJsonSchema = optionalStoredJsonSchema(jsonSchema)

export const workflowRunSelectSchema = createSelectSchema(workflowRuns, {
	target: workflowTargetSchema,
	roles: frozenWorkflowRolesSchema,
	pristineEvidence: optionalUnknownJsonSchema,
	deliveryBaseline: optionalUnknownJsonSchema,
	blockedCandidates: optionalStoredJsonSchema(z.array(workflowAdoptionCandidateSchema))
})
export const workflowCapabilitySelectSchema = createSelectSchema(workflowCapabilities, {
	allowedRoles: z.array(z.enum(WORKFLOW_JOB_ROLES))
})
export const workflowJobSelectSchema = createSelectSchema(workflowJobs, {
	resolvedRole: resolvedWorkflowRoleSchema,
	transcriptCursor: optionalUnknownJsonSchema,
	outcome: optionalUnknownJsonSchema,
	taskReceipt: optionalUnknownJsonSchema,
	batonReceipt: optionalUnknownJsonSchema
})
export const workflowJobAttemptSelectSchema = createSelectSchema(workflowJobAttempts, {
	outcome: optionalUnknownJsonSchema,
	failureEvidence: optionalUnknownJsonSchema
})
export const workflowEffectSelectSchema = createSelectSchema(workflowEffects, {
	target: optionalUnknownJsonSchema,
	inputs: optionalUnknownJsonSchema,
	baseline: optionalUnknownJsonSchema,
	cursor: optionalUnknownJsonSchema,
	receipt: optionalUnknownJsonSchema
})
export const workflowEffectAttemptSelectSchema = createSelectSchema(workflowEffectAttempts, {
	receipt: optionalUnknownJsonSchema,
	evidence: optionalUnknownJsonSchema
})
export const workflowEventSelectSchema = createSelectSchema(workflowEvents, { data: optionalUnknownJsonSchema })
export const relayInstanceSelectSchema = createSelectSchema(relayInstances, { metadata: optionalUnknownJsonSchema })
export const uiMutexSelectSchema = createSelectSchema(uiMutex)
export const uiQuarantineSelectSchema = createSelectSchema(uiQuarantine)

export type WorkflowRunRow = typeof workflowRuns.$inferSelect
export type WorkflowCapabilityRow = typeof workflowCapabilities.$inferSelect
export type WorkflowJobRow = typeof workflowJobs.$inferSelect
export type WorkflowJobAttemptRow = typeof workflowJobAttempts.$inferSelect
export type WorkflowEffectRow = typeof workflowEffects.$inferSelect
export type WorkflowEffectAttemptRow = typeof workflowEffectAttempts.$inferSelect
export type WorkflowEventRow = typeof workflowEvents.$inferSelect
export type WorkflowIdempotencyRow = typeof workflowIdempotency.$inferSelect
export type RelayInstanceRow = typeof relayInstances.$inferSelect
export type UiMutexRow = typeof uiMutex.$inferSelect
export type UiQuarantineRow = typeof uiQuarantine.$inferSelect
