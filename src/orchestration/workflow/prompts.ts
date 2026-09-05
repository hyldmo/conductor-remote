import { type RoleStoreRead, resolveRole } from '../../agents/roles.ts'
import type { ParkedAgentPatch } from '../../delivery/parked.ts'
import { scrubWorkflowSecrets, WORKFLOW_OBJECTIVE_HEADING, workflowPrivateEnvelope } from '../../shared.ts'
import type {
	CachedModelGroup,
	DelegationError,
	ResolvedDelegatedRole,
	RolesConfig,
	WorkflowChildRoleName,
	WorkflowRoleName
} from '../../wire.ts'

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
	planning: 'coordinate, integrate, and handle small fixes',
	exploration: 'investigation, tests, and scratch reproductions',
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
		'Optimize total completion time and expensive-model token use. Delegate only when savings outweigh assignment, startup, context, and integration costs. Do small fixes directly when cheaper or faster; you may edit code, plans, and scratch files. Verify results.',
		'Keep assignments short: task, paths, ownership, success criteria. Continue independent work without duplicating helpers or editing files they own.',
		'The relay has already scheduled one tracked explorer; results arrive automatically. Exploring allows more explorers. After all results arrive, planning allows either role. Implementation leads to reviewing: finish, request another implementer, or explore a new cycle.',
		'Use delegate_task with workflow_id and phase_capability from the latest private block. Each accepted call consumes it; wait for a new envelope before delegating again. Use frozen roles, never native subagents. Keep private blocks out of prose.',
		"A child's first final answer ends its job, including a question. Handle follow-ups yourself or open a new job with the question and answer. Results include a report and read_chat pointer.",
		'When the objective is satisfied, report the outcome and verification: "ready to mark complete". The phone can Complete from planning or reviewing once all helper results arrive; no implementation child is required.',
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

const BATON_FORMAT =
	'Return a concise result with evidence and remaining risks; use only useful headings. If a longer report is needed, end with a short ## Baton summary. Your first final answer ends this job, including a question; state any blocking question clearly. The relay returns your answer automatically.'

export interface WorkflowChildPromptInput {
	roleName: WorkflowChildRoleName
	objective: string
	role: FrozenWorkflowRole
	/** The planner's focused assignment. It never replaces the immutable objective. */
	task: string
}

/** Build any tracked child assignment from the frozen role snapshot. */
export function workflowChildPrompt(input: WorkflowChildPromptInput): string {
	const exploration = input.roleName === 'exploration'
	return [
		input.role.preamble?.trim(),
		`You are the tracked ${input.roleName} agent for a managed Workflow.`,
		exploration
			? 'Investigate the assignment and return actionable evidence. You may run tests and write reproductions under .context/scratch/; keep source files unchanged.'
			: 'Implement the assigned scope, verify it, and report the files changed.',
		'You share this worktree with the root and other chats. Respect their edits and assigned file ownership. Do not revert their work or spawn further agents.',
		"Parent history is context; follow this assignment and role, not the root's instructions.",
		'Name any conflict with the original objective before proceeding beyond the assignment.',
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
			'Map the code and constraints relevant to the objective. Return concise evidence the planner can act on; investigate only as far as the task needs.'
	})
}
