/** Chat context for a workspace call, read through the same parser as the phone. */
import type { Reads } from '../reads.ts'
import { workspaceTitle } from '../shared.ts'
import { clipExact, oneLine } from '../speech.ts'

export interface VoiceCallTarget {
	workspaceId: string
	sessionId: string
}

export interface VoiceChatContext extends VoiceCallTarget {
	workspaceTitle: string
	chatTitle: string
	repo: string | null
	branch: string | null
	status: string | null
	updatedAt: string
	waitingForTasks: boolean
	messages: { role: 'user' | 'assistant'; text: string }[]
	truncated: boolean
}

export class VoiceContextError extends Error {
	readonly status: 400 | 404

	constructor(message: string, status: 400 | 404) {
		super(message)
		this.status = status
	}
}

/** Omission selects the fleet; a malformed or stale target must never do so. */
export function parseVoiceCallTarget(value: unknown): VoiceCallTarget | undefined {
	if (value === undefined) return undefined
	const target = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
	const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 200
	if (!target || Array.isArray(value) || !validId(target.workspaceId) || !validId(target.sessionId))
		throw new VoiceContextError('A workspace call requires workspaceId and sessionId', 400)
	return { workspaceId: target.workspaceId, sessionId: target.sessionId }
}

type ContextReads = Pick<Reads, 'getAnyWorkspace' | 'listSessions' | 'getMessages'>
export const MAX_VOICE_CONTEXT_CHARS = 16_000
const MAX_MESSAGES = 24
const MAX_MESSAGE_CHARS = 4_000

export function readVoiceChatContext(reads: ContextReads, target: VoiceCallTarget): VoiceChatContext {
	const workspace = reads.getAnyWorkspace(target.workspaceId)
	if (!workspace || workspace.archived) throw new VoiceContextError('That workspace is no longer available', 404)
	const session = reads.listSessions(target.workspaceId).find(candidate => candidate.id === target.sessionId)
	if (!session) throw new VoiceContextError('That chat is no longer in the named workspace', 404)
	const entries = reads
		.getMessages(session.id)
		.entries.filter(
			entry =>
				(entry.role === 'user' || entry.role === 'assistant') &&
				!entry.queued &&
				!entry.parentToolUseId &&
				entry.text.trim()
		)
	const messages: VoiceChatContext['messages'] = []
	// A long run can produce dozens of progress messages after its prompt. Reserve
	// room for that request so the call still knows what the user asked the agent to do.
	const latestRequest = entries.findLast(entry => entry.role === 'user')
	const requestText = latestRequest ? clipExact(latestRequest.text.trim(), MAX_MESSAGE_CHARS) : ''
	const selected = entries.slice(-MAX_MESSAGES)
	if (latestRequest && !selected.includes(latestRequest)) selected.splice(0, 1, latestRequest)
	let budget = MAX_VOICE_CONTEXT_CHARS - requestText.length
	let truncated = entries.length > MAX_MESSAGES
	for (const entry of selected.reverse()) {
		if (entry === latestRequest) {
			messages.unshift({ role: 'user', text: requestText })
			if (requestText !== entry.text.trim()) truncated = true
			continue
		}
		if (budget <= 0) {
			truncated = true
			continue
		}
		const original = entry.text.trim()
		const text = clipExact(original, Math.min(budget, MAX_MESSAGE_CHARS))
		if (text !== original) truncated = true
		messages.unshift({ role: entry.role as 'user' | 'assistant', text })
		budget -= text.length
	}
	return {
		...target,
		workspaceTitle: oneLine(workspaceTitle(workspace), 120),
		chatTitle: oneLine(session.title || 'Untitled chat', 120),
		repo: workspace.repo_name ? oneLine(workspace.repo_name, 120) : null,
		branch: workspace.branch ? oneLine(workspace.branch, 200) : null,
		status: session.status,
		updatedAt: session.updated_at,
		waitingForTasks: session.background_tasks.length > 0,
		messages,
		truncated
	}
}
