import { client } from '../../lib/api.ts'
import type { SplitChatResult } from '../../lib/types.ts'
import { useApp } from '../../store.ts'
import type { SplitFormat } from '../transcript/types.ts'

export interface ChatHistoryRetry {
	sessionId: string
	previousSessionId: string
	workspaceId: string
	message: string
}

export async function joinChatHistory(target: Omit<ChatHistoryRetry, 'message'>): Promise<void> {
	const result = await client.joinChatHistory(target.sessionId, target.workspaceId, target.previousSessionId)
	if (!result.ok) throw new Error(result.error ?? 'Could not join conversation history')
}

/** Fork and Compact share the exact transcript request and editable handoff. */
export async function handoffChat(
	source: { sessionId: string; workspaceId: string },
	format: SplitFormat,
	options: {
		replace?: boolean
		continuation?: string
		onReady: (split: SplitChatResult) => Promise<void>
	}
): Promise<{ historyError?: ChatHistoryRetry }> {
	const destination = options.replace ? 'chat' : (format.destination ?? 'chat')
	const split = await client.splitChat(
		format.sourceSessionId ?? source.sessionId,
		source.workspaceId,
		format.thinking,
		format.tools,
		format.through,
		format.only,
		destination
	)
	if (!split.ok) throw new Error(split.error ?? 'Could not copy this chat')
	const draftKey = split.sessionId ?? (destination === 'workspace' ? split.workspaceId : null)
	if (!draftKey) throw new Error('The new chat opened, but its id was not available. The original tab is still open.')
	if (options.replace && (draftKey === source.sessionId || split.workspaceId !== source.workspaceId)) {
		throw new Error('Could not verify the replacement chat. The original tab is still open.')
	}

	if (options.replace) {
		const state = useApp.getState()
		if (
			state.drafts[draftKey] !== undefined ||
			state.agentDrafts[draftKey] !== undefined ||
			state.draftAttachments[draftKey] !== undefined
		) {
			throw new Error('The new chat already has a draft. Both tabs were kept so nothing is overwritten.')
		}
		// Save the handoff before joining the tabs. Unsent text, attachments and agent
		// choices follow the replacement through the ordinary durable draft store.
		state.moveDraft(source.sessionId, draftKey)
	}
	const continuation = options.replace ? useApp.getState().drafts[draftKey] : options.continuation
	useApp.getState().setDraft(draftKey, [split.text, continuation?.trim()].filter(Boolean).join('\n'))
	let historyError: ChatHistoryRetry | undefined
	if (options.replace) {
		const target = { sessionId: draftKey, previousSessionId: source.sessionId, workspaceId: source.workspaceId }
		try {
			await joinChatHistory(target)
		} catch (error) {
			// Both real chats and the prepared draft survive. Retry only this metadata
			// write, never the fork, if the phone lost the answer or persistence failed.
			historyError = {
				...target,
				message: error instanceof Error ? error.message : 'Could not join conversation history'
			}
		}
	}
	await options.onReady(split)
	return { historyError }
}
