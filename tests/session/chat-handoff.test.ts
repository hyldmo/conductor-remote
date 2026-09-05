import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SplitChatResult } from '../../src/wire.ts'
import type { SplitFormat } from '../../web/src/components/transcript/types.ts'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key)
	}
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { handoffChat, joinChatHistory } = await import('../../web/src/components/session/chat-handoff.ts')
const { client } = await import('../../web/src/lib/api.ts')
const { useApp } = await import('../../web/src/store.ts')

const source = { sessionId: 'source', workspaceId: 'workspace' }
const copied: SplitChatResult = {
	ok: true,
	destination: 'chat',
	sessionId: 'replacement',
	workspaceId: 'workspace',
	text: 'Forked from @⟦Transcript.md⟧(.context%2Fattachments%2Fabc123%2FTranscript.md)\n\n',
	attachment: {
		name: 'Transcript.md',
		path: '.context/attachments/abc123/Transcript.md',
		bytes: 123,
		kept: 2,
		elided: { thinking: 0, tools: 3, earlier: 0, later: 0 }
	}
}
const withReasoning = { thinking: true, tools: false }
const forkAttachment = {
	name: copied.attachment.name,
	path: copied.attachment.path,
	bytes: copied.attachment.bytes,
	token: '@⟦Transcript.md⟧(.context%2Fattachments%2Fabc123%2FTranscript.md)',
	source: 'fork'
}

beforeEach(() => {
	// Both the live projection and the durable store participate in moving a draft.
	for (const id of ['source', 'replacement', 'workspace-2']) {
		useApp.getState().setDraft(id, '')
		useApp.getState().clearDraftContent(id)
	}
	useApp.setState({ drafts: {}, agentDrafts: {}, draftAttachments: {} })
	vi.spyOn(client, 'splitChat').mockResolvedValue({ ...copied })
	vi.spyOn(client, 'closeChat').mockResolvedValue({ ok: true, activeSessionId: 'replacement' })
	vi.spyOn(client, 'joinChatHistory').mockResolvedValue({ ok: true })
})

afterEach(() => vi.restoreAllMocks())

describe('Fork and Compact handoffs', () => {
	const formats: [string, SplitFormat][] = [
		['Last message only', { thinking: false, tools: false, only: 40 }],
		['Concise', { thinking: false, tools: false, through: 40 }],
		['With reasoning', { thinking: true, tools: false, through: 40 }],
		['Full transcript', { thinking: true, tools: true, through: 40 }]
	]

	test.each(
		formats
	)('Compact uses the same %s fork request and joins history without closing either tab', async (_label, format) => {
		const onReady = vi.fn(async () => {})
		const send = vi.spyOn(client, 'sendPrompt')
		await handoffChat(source, format, { replace: true, onReady })
		expect(client.splitChat).toHaveBeenCalledWith(
			'source',
			'workspace',
			format.thinking,
			format.tools,
			format.through,
			format.only,
			'chat'
		)
		expect(onReady).toHaveBeenCalledWith(copied)
		expect(client.joinChatHistory).toHaveBeenCalledWith('replacement', 'workspace', 'source')
		expect(client.closeChat).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
		expect(useApp.getState().drafts.replacement).toBe('')
		expect(useApp.getState().draftAttachments.replacement).toEqual([forkAttachment])
	})

	test('saves the selected transcript, existing draft, attachments and agent choices before joining history', async () => {
		const attachment = {
			name: 'notes.md',
			path: '.context/attachments/def456/notes.md',
			bytes: 8,
			token: '@⟦notes.md⟧(.context%2Fattachments%2Fdef456%2Fnotes.md)'
		}
		const draft = '\nContinue with the next step\n\n  Keep this formatting\n'
		useApp.getState().setDraft('source', draft)
		useApp.getState().stageAgent('source', { model: 'Chosen model', effort: 'high' })
		useApp.getState().addDraftAttachment('source', attachment)
		vi.mocked(client.joinChatHistory).mockImplementation(async () => {
			expect(useApp.getState().drafts.replacement).toBe(draft)
			expect(useApp.getState().agentDrafts.replacement).toEqual({ model: 'Chosen model', effort: 'high' })
			expect(useApp.getState().draftAttachments.replacement).toEqual([attachment, forkAttachment])
			return { ok: true }
		})
		await handoffChat(source, withReasoning, {
			replace: true,
			onReady: async () => {}
		})
	})

	test('keeps a failed fork from closing or consuming the original draft', async () => {
		useApp.getState().setDraft('source', 'Still needed')
		vi.mocked(client.splitChat).mockRejectedValue(new Error('Mac is locked'))
		await expect(handoffChat(source, withReasoning, { replace: true, onReady: async () => {} })).rejects.toThrow(
			'Mac is locked'
		)
		expect(client.closeChat).not.toHaveBeenCalled()
		expect(useApp.getState().drafts.source).toBe('Still needed')
	})

	test.each([
		{ sessionId: null },
		{ sessionId: 'source' },
		{ workspaceId: 'another-workspace' }
	])('does not close when the replacement identity is unconfirmed: %j', async patch => {
		vi.mocked(client.splitChat).mockResolvedValue({ ...copied, ...patch })
		await expect(handoffChat(source, withReasoning, { replace: true, onReady: async () => {} })).rejects.toThrow(
			/original tab is still open/
		)
		expect(client.closeChat).not.toHaveBeenCalled()
	})

	test('retries only the history link after a failure, preserving the prepared draft and both real chats', async () => {
		vi.mocked(client.joinChatHistory).mockRejectedValueOnce(new Error('Connection lost'))
		const onReady = vi.fn(async () => {})
		const result = await handoffChat(source, withReasoning, { replace: true, onReady })
		expect(result.historyError).toEqual({
			sessionId: 'replacement',
			previousSessionId: 'source',
			workspaceId: 'workspace',
			message: 'Connection lost'
		})
		expect(onReady).toHaveBeenCalledOnce()
		expect(useApp.getState().drafts.replacement).toBe('')
		expect(useApp.getState().draftAttachments.replacement).toEqual([forkAttachment])
		expect(client.splitChat).toHaveBeenCalledOnce()
		await joinChatHistory(result.historyError!)
		expect(client.joinChatHistory).toHaveBeenCalledTimes(2)
		expect(client.splitChat).toHaveBeenCalledOnce()
		expect(client.closeChat).not.toHaveBeenCalled()
	})

	test('preserves an unexpectedly existing destination draft and leaves the source open', async () => {
		useApp.getState().setDraft('replacement', 'Typed in the new tab')
		await expect(handoffChat(source, withReasoning, { replace: true, onReady: async () => {} })).rejects.toThrow(
			'already has a draft'
		)
		expect(client.closeChat).not.toHaveBeenCalled()
		expect(useApp.getState().drafts.replacement).toBe('Typed in the new tab')
	})

	test('an ordinary fork keeps the source open and uses its usual continuation', async () => {
		await handoffChat(source, withReasoning, { continuation: 'A tangent', onReady: async () => {} })
		expect(client.closeChat).not.toHaveBeenCalled()
		expect(client.joinChatHistory).not.toHaveBeenCalled()
		expect(useApp.getState().drafts.replacement).toBe('A tangent')
		expect(useApp.getState().draftAttachments.replacement).toEqual([forkAttachment])
	})

	test('a cut from an earlier context uses that transcript while extending the current conversation', async () => {
		await handoffChat(
			source,
			{ ...withReasoning, sourceSessionId: 'older-context', through: 12 },
			{
				replace: true,
				onReady: async () => {}
			}
		)
		expect(client.splitChat).toHaveBeenCalledWith('older-context', 'workspace', true, false, 12, undefined, 'chat')
		expect(client.joinChatHistory).toHaveBeenCalledWith('replacement', 'workspace', 'source')
	})

	test('an ordinary workspace fork can still stage a draft before its chat id is available', async () => {
		vi.mocked(client.splitChat).mockResolvedValue({
			...copied,
			destination: 'workspace',
			workspaceId: 'workspace-2',
			sessionId: null
		})
		await handoffChat(source, { ...withReasoning, destination: 'workspace' }, { onReady: async () => {} })
		expect(useApp.getState().drafts['workspace-2']).toBe('')
		expect(useApp.getState().draftAttachments['workspace-2']).toEqual([forkAttachment])
		useApp.getState().moveDraft('workspace-2', 'replacement')
		expect(useApp.getState().draftAttachments.replacement).toEqual([forkAttachment])
		expect(useApp.getState().draftAttachments['workspace-2']).toBeUndefined()
		expect(client.closeChat).not.toHaveBeenCalled()
	})
})
