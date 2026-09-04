import type { ParkedAgentPatch } from './parked.ts'
import { type RoleStoreRead, resolveRole } from './roles.ts'
import { scrubWorkflowSecrets, WORKFLOW_OBJECTIVE_HEADING, workflowPrivateEnvelope } from './shared.ts'
import type {
	CachedModelGroup,
	DelegationError,
	ResolvedDelegatedRole,
	RolesConfig,
	WorkflowChildRoleName,
	WorkflowRoleName
} from './wire.ts'

export const WORKFLOW_ROLE_NAMES = [
	'planning',
	'exploration',
	'implementation'
] as const satisfies readonly WorkflowRoleName[]

export type FrozenWorkflowRole = Readonly<ResolvedDelegatedRole>
export type FrozenWorkflowRoles = Readonly<Record<WorkflowRoleName, FrozenWorkflowRole>>

export interface PreparedWorkflowRun {
	/** Preserved exactly as accepted; later planning interpretation is a separate value. */
	objective: string
	roles: FrozenWorkflowRoles
	rootAgent: ParkedAgentPatch
}

export type WorkflowRunPreparationResult =
	| { ok: true; prepared: PreparedWorkflowRun }
	| { ok: false; error: DelegationError }

function issue(code: DelegationError['code'], message: string): WorkflowRunPreparationResult {
	return { ok: false, error: { code, message, retryable: false } }
}

function agentPatch(role: FrozenWorkflowRole): ParkedAgentPatch {
	return {
		model: role.model,
		...(role.effort ? { effort: role.effort } : {}),
		...(role.fast === undefined ? {} : { fast: role.fast })
	}
}

function freezeRole(role: ResolvedDelegatedRole): FrozenWorkflowRole {
	return Object.freeze({ ...role })
}

/**
 * Resolve all roles once, before a Workflow can create a workspace or touch
 * Conductor. The returned snapshot is immutable and is the only role material a
 * coordinator should persist or use for this run.
 */
export function prepareWorkflowRun(
	stored: RolesConfig | RoleStoreRead,
	groups: CachedModelGroup[],
	objective: string
): WorkflowRunPreparationResult {
	if (!objective.trim()) return issue('invalid_request', 'Workflow needs an objective or attachment.')
	const config = 'config' in stored ? stored.config : stored
	if ('config' in stored && stored.warning) {
		return issue(
			'invalid_request',
			`Workflow could not read the role document: ${stored.warning} Fix it in the role editor before starting.`
		)
	}

	const resolved = {} as Record<WorkflowRoleName, FrozenWorkflowRole>
	for (const name of WORKFLOW_ROLE_NAMES) {
		if (!config.roles[name]) {
			return issue('role_not_found', `Workflow requires the ${name} role; configure it in the role editor.`)
		}
		const role = resolveRole(config, name, groups)
		if (!role.ok) return role
		resolved[name] = freezeRole(role.role)
	}

	for (const name of ['exploration', 'implementation'] as const) {
		if (resolved[name].agentType === resolved.planning.agentType) {
			return issue(
				'same_provider',
				`Workflow role ${name} must use a different provider from planning; update it in the role editor.`
			)
		}
	}

	const roles = Object.freeze({ ...resolved }) as FrozenWorkflowRoles
	return {
		ok: true,
		prepared: Object.freeze({
			objective,
			roles,
			rootAgent: Object.freeze(agentPatch(roles.planning))
		})
	}
}

export interface WorkflowRootPromptInput {
	workflowId: string
	objective: string
	roles: FrozenWorkflowRoles
	phaseCapability: string
	cycle: number
	revision: number
}

const WORKFLOW_ROLE_PURPOSES: Record<WorkflowRoleName, string> = {
	planning: 'this root chat; plan and integrate delegated work',
	exploration: 'read-only investigation and evidence',
	implementation: 'code changes and verification'
}

function frozenRoleCatalog(roles: FrozenWorkflowRoles): string {
	return [
		'## Frozen roles for this Workflow',
		...WORKFLOW_ROLE_NAMES.map(
			name => `- ${name} — ${roles[name].model.replace(/\s+/g, ' ').trim()}: ${WORKFLOW_ROLE_PURPOSES[name]}`
		),
		'This catalog is authoritative for this run; do not replace it with mutable role defaults.'
	].join('\n')
}

/** The first root message, issued only after a durable run and capability exist. */
export function workflowRootPrompt(input: WorkflowRootPromptInput): string {
	return [
		input.roles.planning.preamble?.trim(),
		'You are the planning root for a managed Workflow.',
		frozenRoleCatalog(input.roles),
		'The relay has already scheduled one tracked explorer for this objective. It will deliver a Baton here when it finishes; you do not need to create or poll for that guaranteed explorer.',
		'You may search, inspect files, run read-only probes, ask the user questions, synthesize evidence, and verify results. Do not edit files or implement the change in this root chat. Delegate tracked code changes to the implementation role after the exploration evidence arrives.',
		'When there are genuinely independent questions, you may request additional tracked explorers with delegate_task. Use the workflow_id and phase_capability from the private block exactly; the relay owns role settings and rejects stale phases. Do not use provider-native child-agent tools as a substitute for tracked Workflow chats.',
		'Do not repeat, quote, summarize, or place the private orchestration block in prose. It is bearer metadata for the tool call only.',
		workflowPrivateEnvelope({
			workflowId: input.workflowId,
			phaseCapability: input.phaseCapability,
			cycle: input.cycle,
			revision: input.revision,
			allowedRoles: ['exploration']
		}),
		WORKFLOW_OBJECTIVE_HEADING,
		input.objective
	]
		.filter(Boolean)
		.join('\n\n')
}

const BATON_FORMAT = [
	'End the final answer with this exact handoff structure:',
	'## Baton',
	'### Decision',
	'### Evidence',
	'### Files changed',
	'### Risks',
	'### Suggested next role'
].join('\n')

export interface WorkflowChildPromptInput {
	roleName: WorkflowChildRoleName
	objective: string
	role: FrozenWorkflowRole
	/** The planner's focused assignment. It never replaces the immutable objective. */
	task: string
	/** A Conductor attachment token for the scrubbed root transcript, when available. */
	handoffAttachment?: string
}

/** Build any tracked child assignment from the frozen role snapshot. */
export function workflowChildPrompt(input: WorkflowChildPromptInput): string {
	const exploration = input.roleName === 'exploration'
	return [
		input.role.preamble?.trim(),
		`You are the tracked ${input.roleName} agent for a managed Workflow.`,
		exploration
			? 'Investigate the assignment and return concrete evidence. Do not edit files.'
			: 'Implement the focused assignment in this shared worktree, verify the result, and report exactly what changed.',
		'Do not create provider-native child agents for work the root expects this tracked chat to perform.',
		'If the focused assignment materially changes the user-visible meaning of the original objective, stop and name the conflict instead of silently changing scope.',
		input.handoffAttachment
			? `A sanitized root transcript is attached for context: ${scrubWorkflowSecrets(input.handoffAttachment)}`
			: undefined,
		'## Original Workflow objective (immutable)',
		input.objective,
		`## Focused ${input.roleName} assignment`,
		scrubWorkflowSecrets(input.task),
		BATON_FORMAT
	]
		.filter(Boolean)
		.join('\n\n')
}

export interface WorkflowBootstrapPromptInput {
	objective: string
	role: FrozenWorkflowRole
	handoffAttachment?: string
	/** Optional narrower first question; otherwise the explorer surveys the objective. */
	task?: string
}

/** The deterministic `explore:0` assignment created with every accepted run. */
export function workflowBootstrapPrompt(input: WorkflowBootstrapPromptInput): string {
	return workflowChildPrompt({
		roleName: 'exploration',
		objective: input.objective,
		role: input.role,
		task:
			input.task ??
			'Explore the objective before implementation: map the relevant code and constraints, identify likely failure modes, and return evidence the planner can use.',
		handoffAttachment: input.handoffAttachment
	})
}
