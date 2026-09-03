import type { ParkedAgentPatch } from './parked.ts'
import { resolveRole } from './roles.ts'
import { WORKFLOW_OBJECTIVE_HEADING } from './shared.ts'
import type { CachedModelGroup, DelegationError, ResolvedDelegatedRole, RolesConfig } from './wire.ts'

export const WORKFLOW_ROOT_ROLE = 'planning'

export type WorkflowRootResult =
	| {
			ok: true
			role: typeof WORKFLOW_ROOT_ROLE
			resolvedRole: ResolvedDelegatedRole
			agent: ParkedAgentPatch
			prompt: string
	  }
	| { ok: false; error: DelegationError }

function invalid(message: string): WorkflowRootResult {
	return { ok: false, error: { code: 'invalid_request', message, retryable: false } }
}

/** Freeze the configured planning role and turn one first-message objective into a workflow-root prompt. */
export function prepareWorkflowRoot(
	config: RolesConfig,
	groups: CachedModelGroup[],
	objective: string
): WorkflowRootResult {
	const task = objective.trim()
	if (!task) return invalid('Workflow mode needs a first message or attachment.')
	const resolved = resolveRole(config, WORKFLOW_ROOT_ROLE, groups)
	if (!resolved.ok) return resolved

	const role = resolved.role
	const agent: ParkedAgentPatch = {
		model: role.model,
		...(role.effort ? { effort: role.effort } : {}),
		...(role.fast === undefined ? {} : { fast: role.fast })
	}
	const instructions = [
		'Workflow mode is enabled. You are the root planning agent for this objective.',
		'The user explicitly authorized you to create cross-provider sibling chats with the conductor-remote `delegate_task` tool for this workflow. Begin by calling `list_roles`, then route the applicable exploration and implementation work through valid configured roles. Do not merely describe delegation or stop after planning: start the delegated work, integrate every returned Baton, and deliver the finished result from this root chat.',
		'Do not use provider-native Agent, Task, or subagent functionality as a substitute for these tracked sibling chats.',
		'Never enable or use Conductor Plan mode.',
		role.preamble?.trim(),
		WORKFLOW_OBJECTIVE_HEADING,
		task
	]
		.filter(Boolean)
		.join('\n\n')

	return { ok: true, role: WORKFLOW_ROOT_ROLE, resolvedRole: role, agent, prompt: instructions }
}
