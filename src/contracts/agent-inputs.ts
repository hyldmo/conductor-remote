import { z } from 'zod'
import { AGENT_EFFORTS } from '../shared.ts'

/** Wire inputs shared by the HTTP handlers and their MCP tools. Browser callers import only their types. */
const optionalText = z
	.string()
	.trim()
	.transform(value => value || undefined)
	.optional()

export const sessionIdSchema = z.string().trim().min(1).describe('The chat id from list_chats / search_chats.')
const workspaceIdSchema = optionalText.describe(
	'Its workspace. Strongly recommended: it is what the relay asserts against before touching the UI.'
)

export const agentPatchSchema = z.object({
	model: optionalText.describe('A picker label from list_models. An unambiguous prefix is enough.'),
	effort: z.enum(AGENT_EFFORTS).optional().describe('Reasoning effort applied before the next prompt.'),
	plan: z.boolean().optional().describe('Conductor’s Plan checkbox.'),
	fast: z
		.boolean()
		.optional()
		.describe('Fast mode. Only some models offer it; a missing button is reported, not ignored.')
})

export const setAgentOptionsSchema = agentPatchSchema.extend({ workspaceId: workspaceIdSchema })

export const sendPromptSchema = z.object({
	text: z.string({ error: 'prompt must be a string' }).trim().min(1, 'empty prompt'),
	workspaceId: workspaceIdSchema,
	agent: agentPatchSchema.optional(),
	clientId: z.string().optional(),
	queue: z.boolean().default(false)
})

export const createWorkspaceSchema = agentPatchSchema.extend({
	repo: z.string().trim().min(1).optional().describe('Exact name from list_repos.'),
	prompt: optionalText.describe('First prompt for the new agent. Omit to open an empty workspace.'),
	send: z
		.boolean()
		.default(false)
		.describe(
			'Block until the first prompt is actually delivered (tens of seconds, and longer behind other queued sends). Default false.'
		),
	sendImmediately: z
		.boolean()
		.default(true)
		.describe(
			"Send the first prompt without waiting for the worktree to finish building, which is how Conductor's own New workspace box behaves. Default true. Pass false only when the agent's first move needs what the repo's setup script installs."
		),
	attachmentIds: z.array(z.string()).default([])
})

export type AgentPatch = z.input<typeof agentPatchSchema>
export type SetAgentOptionsRequest = z.input<typeof setAgentOptionsSchema>
export type SendPromptRequest = z.input<typeof sendPromptSchema>
export type CreateWorkspaceRequest = z.input<typeof createWorkspaceSchema>

/** False is an explicit setting; an empty patch inherits the chat's existing controls. */
export function hasAgentSettings(patch: z.output<typeof agentPatchSchema>): boolean {
	return patch.model !== undefined || patch.effort !== undefined || patch.plan !== undefined || patch.fast !== undefined
}
