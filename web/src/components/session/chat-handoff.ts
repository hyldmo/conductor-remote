import { attachmentToken } from '../../../../src/shared.ts'
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

/** Transfer the prepared draft into the ordinary persisted send, which owns any Retry. */
export async function sendHandoffDraft(
	split: SplitChatResult,
	queue: boolean,
	send: (prompt: { sessionId: string; workspaceId: string; text: string; queue: boolean }) => Promise<boolean>
): Promise<boolean> {
	if (!split.sessionId) throw new Error('The new chat is not available yet')
	const state = useApp.getState()
	const text = [
		...(state.draftAttachments[split.sessionId] ?? []).map(attachment => attachment.token),
		state.drafts[split.sessionId]?.trim()
	]
		.filter(Boolean)
		.join('\n')
	const sending = send({ sessionId: split.sessionId, workspaceId: split.workspaceId, text, queue })
	state.clearDraftContent(split.sessionId)
	return sending
}

/** Fork and Compact stage context for the first send while leaving only the user's text editable. */
export async function handoffChat(
	source: { sessionId: string; workspaceId: string },
	format: SplitFormat,
	options: {
		replace?: boolean
		continuation?: string
		/** Notify the caller as soon as the new chat owns the saved draft. */
		onPrepared?: (split: SplitChatResult) => void
		onReady: (split: SplitChatResult) => Promise<void>
	}
): Promise<{ split: SplitChatResult; historyError?: ChatHistoryRetry }> {
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
	const { name, path, bytes } = split.attachment
	useApp
		.getState()
		.setDraftContent(draftKey, continuation ?? '', [
			...(useApp.getState().draftAttachments[draftKey] ?? []),
			{ name, path, bytes, token: attachmentToken(name, path), source: 'fork' }
		])
	options.onPrepared?.(split)
	// The destination now owns the durable draft. A later send failure retries there.
	if (options.replace) useApp.getState().setCompactDraft(source.sessionId, null)
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
	return { split, historyError }
}
