/** The deliberately small MCP surface a Realtime voice session is allowed to reach. */
import type { Tool } from '../mcp-tools.ts'
import type { SessionState } from '../reads.ts'
import { oneLine } from '../speech.ts'
import type { VoiceBriefBoard } from './brief.ts'
import type { PreviewRefusal, PreviewStore, SendPreview } from './preview.ts'

export interface VoiceDispatchResult {
	ok: boolean
	parked?: boolean
	error?: string
}

export interface VoiceToolContext {
	callId: string
	board: VoiceBriefBoard
	previews: PreviewStore
	findSession: (sessionId: string) => SessionState | null
	dispatch: (preview: SendPreview) => Promise<VoiceDispatchResult>
	/** A mid-call broker injection. Successful sends intentionally do not call it. */
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
	'voice_next_decision',
	'voice_send_preview',
	'voice_send'
] as const

export const VOICE_TOOL_DEFINITIONS: readonly VoiceToolDefinition[] = [
	{
		name: 'voice_roll_call',
		description: 'Get the bounded fleet tally and the first queue heads. Start every call here.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'voice_workspace_overview',
		description:
			'Get a fresh overview of current workspaces with each latest agent update. Call this every time the user asks for an overview or workspace status, even if one was already given. Pass the returned cursor to continue.',
		inputSchema: {
			type: 'object',
			properties: {
				cursor: { type: 'number', description: 'The cursor returned by the previous overview page; default 0.' }
			}
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

function answer(value: unknown): string {
	return JSON.stringify(value)
}

function refusal(reason: PreviewRefusal): string {
	switch (reason) {
		case 'expired':
			return 'That preview expired. Read the exact target and text back again before sending.'
		case 'foreign-call':
			return 'That preview belongs to another call and cannot be used here.'
		case 'foreign-session':
			return 'That preview belongs to a different chat. Preview this target again.'
		case 'text-mismatch':
			return 'The send text does not exactly match the preview. Preview the changed text first.'
		case 'already-used':
			return 'That preview was already used. The relay will not send it twice.'
		case 'unknown':
			return 'That preview token is unknown. Make a new preview before sending.'
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
				return answer(await context.board.workspaceOverview(cursor))
			}
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
