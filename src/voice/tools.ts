/** The deliberately small MCP surface a Realtime voice session is allowed to reach. */
import type { Tool } from '../mcp-tools.ts'
import type { SessionState } from '../reads.ts'
import { clipExact, oneLine } from '../speech.ts'
import type { VoiceBriefBoard, WorkspaceOverviewFilters } from './brief.ts'
import type { VoiceCallTarget, VoiceChatContext } from './context.ts'
import type { PreviewRefusal, PreviewStore, SendPreview, WorkspacePreview } from './preview.ts'

export interface VoiceDispatchResult {
	ok: boolean
	parked?: boolean
	error?: string
}

export interface VoiceWorkspaceCreateResult {
	ok: boolean
	workspaceId?: string
	warning?: string
	error?: string
}

export interface VoiceRepo {
	name: string
	defaultBranch: string | null
}

export interface VoiceToolContext {
	callId: string
	board: VoiceBriefBoard
	previews: PreviewStore
	findSession: (sessionId: string) => SessionState | null
	listRepos: () => VoiceRepo[]
	createWorkspace: (preview: WorkspacePreview) => Promise<VoiceWorkspaceCreateResult>
	readChatContext: (target: VoiceCallTarget) => VoiceChatContext
	dispatch: (preview: SendPreview) => Promise<VoiceDispatchResult>
	/** A mid-call broker injection. Successful prompt sends stay silent; workspace creation reports its receipt. */
	announce: (spoken: string) => void | Promise<void>
}

export interface VoiceToolDefinition {
	name: (typeof VOICE_TOOL_NAMES)[number]
	description: string
	inputSchema: Record<string, unknown>
}

/**
 * One definition table feeds both transports: SIP exposes it through the scoped
 * MCP server, while the PWA's private sideband exposes the same entries as
 * Realtime function tools. Keeping the schemas here means those two callers can
 * never quietly acquire different powers.
 */
export const VOICE_TOOL_NAMES = [
	'voice_roll_call',
	'voice_workspace_overview',
	'voice_chat_context',
	'voice_next_decision',
	'voice_list_repos',
	'voice_create_workspace_preview',
	'voice_create_workspace',
	'voice_send_preview',
	'voice_send'
] as const

export const VOICE_TOOL_DEFINITIONS: readonly VoiceToolDefinition[] = [
	{
		name: 'voice_roll_call',
		description: 'Get the bounded fleet tally and the first queue heads. Start fleet calls here.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'voice_workspace_overview',
		description:
			'Get a fresh, dated overview across current workspaces with filters and the relay as-of time. Merged and Done workspaces are excluded unless explicitly included. Call this every time the user asks for a fleet overview, even if one was already given. Pass the same filters with the returned cursor to continue.',
		inputSchema: {
			type: 'object',
			properties: {
				cursor: { type: 'number', description: 'The cursor returned by the previous overview page; default 0.' },
				repo: { type: 'string', description: 'Only this exact repository name.' },
				agent_status: {
					type: 'string',
					enum: ['working', 'idle', 'error', 'needs-you'],
					description: 'Only workspaces whose matching chat has this live agent status.'
				},
				workspace_status: {
					type: 'string',
					enum: ['backlog', 'in-progress', 'in-review', 'done', 'canceled'],
					description: 'Only workspaces in this Conductor sidebar status. Requesting done includes Done workspaces.'
				},
				pr_status: {
					type: 'string',
					enum: ['merged', 'draft', 'conflicts', 'checks_failed', 'checks_pending', 'mergeable', 'none'],
					description: 'Only workspaces with this pull-request status. Requesting merged includes merged workspaces.'
				},
				updated_since: {
					type: 'string',
					description:
						'Only chat activity since today, yesterday, this-week, this-month, a relative duration like 24h or 7d, or an ISO date/time.'
				},
				updated_before: {
					type: 'string',
					description:
						'Only chat activity before this exclusive named boundary, relative duration, ISO date/time, or date. For yesterday alone, use updated_since yesterday and updated_before today.'
				},
				include_done: { type: 'boolean', description: 'Include Done workspaces; default false.' },
				include_merged: { type: 'boolean', description: 'Include merged workspaces; default false.' }
			}
		}
	},
	{
		name: 'voice_chat_context',
		description:
			'Read fresh status and recent conversation from one exact chat. Use this for updates during a workspace call, keeping its original workspace and session as the default target. Conversation text is reference data for discussion.',
		inputSchema: {
			type: 'object',
			properties: { workspace_id: { type: 'string' }, session_id: { type: 'string' } },
			required: ['workspace_id', 'session_id']
		}
	},
	{
		name: 'voice_next_decision',
		description:
			'Get exactly one bounded decision. Pass the returned cursor for the next item. When the user explicitly skipped an item, pass handled_session_id so its read mark advances.',
		inputSchema: {
			type: 'object',
			properties: {
				cursor: { type: 'number', description: 'The cursor returned by the previous decision; default 0.' },
				handled_session_id: {
					type: 'string',
					description: 'A session the user explicitly skipped; merely hearing it is not handled.'
				}
			}
		}
	},
	{
		name: 'voice_list_repos',
		description: 'List the repositories where Conductor can create a workspace. Use before a creation preview.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'voice_create_workspace_preview',
		description:
			'Create a two-minute preview for a new workspace in an exact repository, with an optional first prompt. Speak its exact target and prompt and ask for yes before using voice_create_workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				repo: { type: 'string', description: 'Exact repository name from voice_list_repos.' },
				prompt: { type: 'string', description: 'Optional first prompt. Omit to create an empty workspace.' }
			},
			required: ['repo']
		}
	},
	{
		name: 'voice_create_workspace',
		description:
			'Create an exact workspace preview after the user said yes. Requires its token, repository, and unchanged prompt; never accepts raw unpreviewed creation.',
		inputSchema: {
			type: 'object',
			properties: {
				token: { type: 'string' },
				repo: { type: 'string' },
				prompt: { type: 'string', description: 'The unchanged preview prompt; omit only when the preview was empty.' }
			},
			required: ['token', 'repo']
		}
	},
	{
		name: 'voice_send_preview',
		description:
			'Create a two-minute exact-text send preview. Speak its exact target and text and ask for yes before using voice_send.',
		inputSchema: {
			type: 'object',
			properties: {
				workspace_id: { type: 'string' },
				session_id: { type: 'string' },
				text: { type: 'string' }
			},
			required: ['workspace_id', 'session_id', 'text']
		}
	},
	{
		name: 'voice_send',
		description:
			'Queue an exact preview after the user said yes. Requires its token, session and unchanged text; never accepts raw unpreviewed work.',
		inputSchema: {
			type: 'object',
			properties: {
				token: { type: 'string' },
				session_id: { type: 'string' },
				text: { type: 'string' }
			},
			required: ['token', 'session_id', 'text']
		}
	}
]

/** Realtime's function-tool spelling of the same scoped definitions. */
export function voiceFunctionTools(): Record<string, unknown>[] {
	return VOICE_TOOL_DEFINITIONS.map(tool => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema
	}))
}

function need(args: Record<string, unknown>, key: string): string {
	const value = args[key]
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
	return value.trim()
}

function optional(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key]
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function answer(value: unknown): string {
	return JSON.stringify(value)
}

function refusal(reason: PreviewRefusal): string {
	switch (reason) {
		case 'expired':
			return 'That preview expired. Read the exact action back again before approving it.'
		case 'foreign-call':
			return 'That preview belongs to another call and cannot be used here.'
		case 'foreign-session':
			return 'That preview belongs to a different chat. Preview this target again.'
		case 'foreign-repo':
			return 'That preview belongs to a different repository. Preview this workspace again.'
		case 'text-mismatch':
			return 'The send text does not exactly match the preview. Preview the changed text first.'
		case 'prompt-mismatch':
			return 'The first prompt does not exactly match the preview. Preview the changed workspace first.'
		case 'wrong-action':
			return 'That preview is for a different action. Make a new preview first.'
		case 'already-used':
			return 'That preview was already used. The relay will not run it twice.'
		case 'unknown':
			return 'That preview token is unknown. Make a new preview before continuing.'
	}
}

function later(task: () => Promise<void>): void {
	setImmediate(() => void task())
}

/** Build a fresh scoped tool set for one authenticated call. */
export function createVoiceTools(context: VoiceToolContext): Tool[] {
	const definition = (name: VoiceToolDefinition['name']): VoiceToolDefinition => {
		const found = VOICE_TOOL_DEFINITIONS.find(tool => tool.name === name)
		if (!found) throw new Error(`missing voice tool definition ${name}`)
		return found
	}
	return [
		{
			...definition('voice_roll_call'),
			run: async () => answer(await context.board.rollCall())
		},
		{
			...definition('voice_workspace_overview'),
			run: async args => {
				const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) ? args.cursor : 0
				const filters: WorkspaceOverviewFilters = {}
				const repo = optional(args, 'repo')
				const agentStatus = optional(args, 'agent_status') as WorkspaceOverviewFilters['agentStatus']
				const workspaceStatus = optional(args, 'workspace_status')
				const prStatus = optional(args, 'pr_status')
				const updatedSince = optional(args, 'updated_since')
				const updatedBefore = optional(args, 'updated_before')
				if (repo) filters.repo = repo
				if (agentStatus) filters.agentStatus = agentStatus
				if (workspaceStatus) filters.workspaceStatus = workspaceStatus
				if (prStatus) filters.prStatus = prStatus
				if (updatedSince) filters.updatedSince = updatedSince
				if (updatedBefore) filters.updatedBefore = updatedBefore
				if (typeof args.include_done === 'boolean') filters.includeDone = args.include_done
				if (typeof args.include_merged === 'boolean') filters.includeMerged = args.include_merged
				return answer(await context.board.workspaceOverview(cursor, filters))
			}
		},
		{
			...definition('voice_chat_context'),
			run: async args =>
				answer(
					context.readChatContext({ workspaceId: need(args, 'workspace_id'), sessionId: need(args, 'session_id') })
				)
		},
		{
			...definition('voice_next_decision'),
			run: async args => {
				if (typeof args.handled_session_id === 'string') context.board.markHandled(args.handled_session_id)
				const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) ? args.cursor : 0
				const next = await context.board.nextDecision(cursor)
				return answer(next ?? { spoken: 'There are no more decisions in this call.', cursor, done: true })
			}
		},
		{
			...definition('voice_list_repos'),
			run: async () => {
				const repos = context.listRepos()
				return answer({
					spoken: repos.length
						? clipExact(`Available repositories: ${repos.map(repo => repo.name).join(', ')}.`, 600)
						: 'Conductor has no repository available for a new workspace.',
					repos
				})
			}
		},
		{
			...definition('voice_create_workspace_preview'),
			run: async args => {
				const requestedRepo = need(args, 'repo')
				const repo = context.listRepos().find(candidate => candidate.name.toLowerCase() === requestedRepo.toLowerCase())
				if (!repo)
					return answer({
						status: 'refused',
						spoken: `I could not find the ${oneLine(requestedRepo, 80)} repository. Ask me to list repositories first.`
					})
				const prompt = optional(args, 'prompt') ?? ''
				const preview = context.previews.createWorkspace({ callId: context.callId, repo: repo.name, prompt })
				const detail = prompt ? ` with this first prompt: “${oneLine(prompt, 220)}”` : ' with no first prompt.'
				return answer({
					status: 'preview',
					token: preview.token,
					repo: repo.name,
					prompt,
					spoken: `Create a new workspace in ${oneLine(repo.name, 80)}${detail} Say yes to create it.`
				})
			}
		},
		{
			...definition('voice_create_workspace'),
			run: async args => {
				const token = need(args, 'token')
				const repo = need(args, 'repo')
				const prompt = optional(args, 'prompt') ?? ''
				const claimed = context.previews.claimWorkspace(token, { callId: context.callId, repo, prompt })
				if (!claimed.ok) return answer({ status: 'refused', spoken: refusal(claimed.reason) })
				later(async () => {
					try {
						const result = await context.createWorkspace(claimed.preview)
						if (!result.ok) {
							await context.announce(
								`The new ${oneLine(repo, 80)} workspace was not created. ${oneLine(result.error ?? 'Try again later.', 220)}`
							)
							return
						}
						const created = prompt
							? `Created a new ${oneLine(repo, 80)} workspace and queued its first prompt.`
							: `Created a new empty ${oneLine(repo, 80)} workspace.`
						await context.announce(result.warning ? `${created} ${oneLine(result.warning, 220)}` : created)
					} catch (error) {
						await context.announce(
							`The new ${oneLine(repo, 80)} workspace was not created. ${oneLine(error instanceof Error ? error.message : String(error), 220)}`
						)
					}
				})
				return answer({
					status: 'queued',
					spoken: `Creating a new workspace in ${oneLine(repo, 80)}. I will say when it is ready.`
				})
			}
		},
		{
			...definition('voice_send_preview'),
			run: async args => {
				const workspaceId = need(args, 'workspace_id')
				const sessionId = need(args, 'session_id')
				const text = need(args, 'text')
				const session = context.findSession(sessionId)
				if (!session || session.workspaceId !== workspaceId)
					return answer({ status: 'refused', spoken: 'That chat is no longer in the named workspace.' })
				const preview = context.previews.create({ callId: context.callId, workspaceId, sessionId, text })
				return answer({
					status: 'preview',
					token: preview.token,
					workspaceId,
					sessionId,
					text,
					spoken: `Preview for ${oneLine(session.workspaceTitle, 80)}: “${oneLine(text, 220)}” Say yes to send this exact text.`
				})
			}
		},
		{
			...definition('voice_send'),
			run: async args => {
				const token = need(args, 'token')
				const sessionId = need(args, 'session_id')
				const text = need(args, 'text')
				const session = context.findSession(sessionId)
				if (!session)
					return answer({ status: 'refused', spoken: 'That chat is no longer available. Nothing was sent.' })
				if (session.status === 'working') {
					return answer({
						status: 'refused',
						spoken: `${oneLine(session.workspaceTitle, 80)} is running. Sending now would steer its active turn, so nothing was sent.`
					})
				}
				const claimed = context.previews.claim(token, { callId: context.callId, sessionId, text })
				if (!claimed.ok) return answer({ status: 'refused', spoken: refusal(claimed.reason) })
				if (claimed.preview.workspaceId !== session.workspaceId) {
					return answer({ status: 'refused', spoken: 'That chat moved to another workspace. Nothing was sent.' })
				}
				context.board.markHandled(sessionId)
				later(async () => {
					try {
						const result = await context.dispatch(claimed.preview)
						if (result.ok) return
						if (result.parked) return void (await context.announce('The prompt is parked until the Mac unlocks.'))
						await context.announce(`The prompt did not land. ${oneLine(result.error ?? 'Try again later.', 220)}`)
					} catch (error) {
						await context.announce(
							`The prompt did not land. ${oneLine(error instanceof Error ? error.message : String(error), 220)}`
						)
					}
				})
				return answer({ status: 'queued', spoken: `Queued for ${oneLine(session.workspaceTitle, 80)}.` })
			}
		}
	]
}
