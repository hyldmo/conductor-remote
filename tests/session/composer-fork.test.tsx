import { Children, type ComponentProps, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DraftAttachment, SendResult, Session, SplitChatResult } from '../../src/wire.ts'

// Read the current draft on each SSR pass, just as a mounted composer does on a tab switch.
vi.mock('../../web/src/store.ts', async importOriginal => {
	const original = await importOriginal<typeof import('../../web/src/store.ts')>()
	return {
		...original,
		useApp: Object.assign(
			<T,>(selector: (state: ReturnType<typeof original.useApp.getState>) => T) => selector(original.useApp.getState()),
			original.useApp
		)
	}
})

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

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { Composer } = await import('../../web/src/components/session/Composer.tsx')
const { handoffChat, sendHandoffDraft } = await import('../../web/src/components/session/chat-handoff.ts')
const { useSendPrompt } = await import('../../web/src/hooks/send.ts')
const { client } = await import('../../web/src/lib/api.ts')
const { loadPending } = await import('../../web/src/lib/prompts/pending.ts')
const { DEFAULT_COMPACT, loadCompactDrafts } = await import('../../web/src/lib/prompts/compact-draft.ts')
const { useApp } = await import('../../web/src/store.ts')

const context: DraftAttachment = {
	name: 'Transcript of prior chat.md',
	path: '.context/attachments/abc123/Transcript of prior chat.md',
	bytes: 123,
	token: '@⟦Transcript of prior chat.md⟧(.context%2Fattachments%2Fabc123%2FTranscript%20of%20prior%20chat.md)',
	source: 'fork'
}
const file: DraftAttachment = {
	name: 'diagram.png',
	path: '.context/attachments/def456/diagram.png',
	bytes: 42,
	token: '@⟦diagram.png⟧(.context%2Fattachments%2Fdef456%2Fdiagram.png)'
}
const delivered: SendResult = { ok: true, strategy: 'applescript' }
const copied: SplitChatResult = {
	ok: true,
	destination: 'chat',
	sessionId: 'replacement',
	workspaceId: 'workspace',
	text: `Forked from ${context.token}\n\n`,
	attachment: { ...context, kept: 2, elided: { thinking: 0, tools: 3, earlier: 0, later: 0 } }
}
const completedSession: Session = {
	id: 'fork',
	status: 'idle',
	title: 'Prior chat',
	model: '5.6 Sol',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'codex',
	context_used_percent: null,
	unread_count: 0,
	created_at: '2026-09-01 10:00:00',
	updated_at: '2026-09-01 10:00:00',
	last_user_message_at: '2026-09-01 10:00:00',
	prompt_cache_ttl_ms: null,
	turn_started_at: null,
	background_tasks: []
}

let queryClient: InstanceType<typeof QueryClient>
beforeEach(() => {
	storage.clear()
	useApp.setState({
		online: true,
		pending: [],
		workflowDrafts: {},
		compactDrafts: {},
		agentDrafts: {},
		workingHints: {}
	})
	for (const id of ['fork', 'sibling', 'replacement']) useApp.getState().clearDraftContent(id)
	useApp.getState().setDraftContent('fork', '', [context])
	queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
	queryClient.clear()
	vi.clearAllTimers()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

function findElement(node: ReactNode, type: string, label?: string): ReactElement<Record<string, unknown>> | undefined {
	for (const child of Children.toArray(node)) {
		if (!isValidElement<Record<string, unknown>>(child)) continue
		if (child.type === type && (!label || child.props['aria-label'] === label)) return child
		const found = findElement(child.props.children as ReactNode, type, label)
		if (found) return found
	}
}

function renderComposer(sessionId = 'fork', props: Partial<Parameters<typeof Composer>[0]> = {}) {
	let tree: ReactNode
	let retry: ReturnType<typeof useSendPrompt> | undefined
	function Probe() {
		retry = useSendPrompt()
		tree = Composer({ sessionId, workspaceId: 'workspace', working: false, ...props })
		return tree
	}
	const html = renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<Probe />
		</QueryClientProvider>
	)
	return {
		button: (label: string) => findElement(tree, 'button', label)!.props as ComponentProps<'button'>,
		html,
		retry: retry!,
		textarea: findElement(tree, 'textarea')!.props as ComponentProps<'textarea'>,
		send: findElement(tree, 'button', 'Send')!.props as ComponentProps<'button'>
	}
}

function clickSend(sessionId = 'fork') {
	const composer = renderComposer(sessionId)
	composer.send.onClick?.({} as Parameters<NonNullable<typeof composer.send.onClick>>[0])
}

describe('the first message after a fork', () => {
	test('keeps context out of the composer and waits for the user to write a message', () => {
		const send = vi.spyOn(client, 'sendPrompt')
		const composer = renderComposer()
		expect(composer.textarea.value).toBe('')
		expect(composer.html).not.toContain(context.name)
		expect(composer.html).not.toContain('Forked from')
		expect(composer.send.disabled).toBe(true)
		// Enter also reaches the send guard, even though the button is disabled.
		composer.textarea.onKeyDown?.({
			key: 'Enter',
			shiftKey: false,
			metaKey: false,
			ctrlKey: false,
			nativeEvent: { isComposing: false },
			preventDefault: vi.fn()
		} as unknown as Parameters<NonNullable<typeof composer.textarea.onKeyDown>>[0])
		expect(send).not.toHaveBeenCalled()
		expect(useApp.getState().draftAttachments.fork).toEqual([context])
	})

	test.each([
		delivered,
		{ ...delivered, ok: false, parked: true }
	])('sends context with the user’s text once, including when the Mac parks it: %j', async result => {
		const response = Promise.withResolvers<SendResult>()
		const send = vi.spyOn(client, 'sendPrompt').mockReturnValueOnce(response.promise).mockResolvedValue(delivered)
		useApp.getState().setDraft('fork', 'Explore this idea')
		useApp.getState().addDraftAttachment('fork', file)
		const composer = renderComposer()
		expect(composer.textarea.value).toBe('Explore this idea')
		expect(composer.html).toContain(file.name)
		expect(composer.html).not.toContain(context.name)
		clickSend()
		const payload = `${context.token}\n${file.token}\nExplore this idea`
		expect(send).toHaveBeenCalledExactlyOnceWith(
			'fork',
			payload,
			'workspace',
			undefined,
			expect.any(String),
			false,
			false
		)
		expect(useApp.getState().draftAttachments.fork).toBeUndefined()
		expect(loadPending()).toMatchObject([{ sessionId: 'fork', text: payload }])
		response.resolve(result)
		await response.promise
		useApp.getState().setDraft('fork', 'Next question')
		clickSend()
		expect(send.mock.calls[1][1]).toBe('Next question')
	})

	test('preserves context and the same send id for Retry after an error and reload', async () => {
		const send = vi
			.spyOn(client, 'sendPrompt')
			.mockResolvedValueOnce({ ...delivered, ok: false, error: 'Connection lost' })
		useApp.getState().setDraft('fork', 'Follow up here')
		clickSend()
		await vi.waitFor(() => expect(useApp.getState().pending[0].status).toBe('error'))
		const pending = loadPending()
		useApp.setState({ pending })
		expect(pending[0].text).toBe(`${context.token}\nFollow up here`)
		expect(useApp.getState().draftAttachments.fork).toBeUndefined()
		send.mockResolvedValueOnce(delivered)
		await expect(renderComposer().retry(pending[0])).resolves.toBe(true)
		expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
	})

	test('keeps the context with its own chat and accepts a user attachment as the first message', () => {
		const send = vi.spyOn(client, 'sendPrompt').mockResolvedValue(delivered)
		useApp.getState().setDraft('sibling', 'Separate question')
		clickSend('sibling')
		expect(send.mock.calls[0][1]).toBe('Separate question')
		expect(useApp.getState().draftAttachments.fork).toEqual([context])
		useApp.getState().addDraftAttachment('fork', file)
		expect(renderComposer().send.disabled).toBe(false)
		clickSend()
		expect(send.mock.calls[1][1]).toBe(`${context.token}\n${file.token}`)
	})
})

describe('Compact before sending', () => {
	beforeEach(() => {
		useApp.getState().setDraftContent('fork', 'Continue this work', [file])
		vi.spyOn(client, 'splitChat').mockResolvedValue(copied)
		vi.spyOn(client, 'joinChatHistory').mockResolvedValue({ ok: true })
	})

	test('stages a cancellable banner from the cold-cache warning without creating or sending anything', () => {
		const onCompact = vi.fn(async () => {})
		const send = vi.spyOn(client, 'sendPrompt')
		const props = { session: completedSession, onCompact }
		const first = renderComposer('fork', props)
		first.button('Compact before sending').onClick?.({} as never)
		const staged = renderComposer('fork', props)
		expect(staged.html).toContain('Will compact before sending')
		expect(staged.html).not.toContain('Prompt cache may be cold')
		expect(staged.textarea.value).toBe('Continue this work')
		expect(staged.html).toContain(file.name)
		expect(loadCompactDrafts()).toEqual({ fork: DEFAULT_COMPACT })
		expect(onCompact).not.toHaveBeenCalled()
		expect(client.splitChat).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
		staged.button('Cancel compact before sending').onClick?.({} as never)
		expect(renderComposer('fork', props).html).not.toContain('Will compact before sending')
		expect(loadCompactDrafts()).toEqual({})
		expect(useApp.getState().drafts.fork).toBe('Continue this work')
	})

	test('keeps the selected format per chat through reload, even with an empty draft', () => {
		useApp.getState().setCompactDraft('fork', { thinking: false, tools: false, only: 40 })
		useApp.getState().setCompactDraft('sibling', { thinking: true, tools: true })
		useApp.getState().clearDraftContent('fork')
		useApp.setState({ compactDrafts: loadCompactDrafts() })
		const props = { onCompact: vi.fn(async () => {}) }
		expect(renderComposer('fork', props).html).toContain('Last message only')
		expect(renderComposer('fork', props).send.disabled).toBe(true)
		expect(renderComposer('sibling', props).html).toContain('Full transcript')
	})

	test('checks current eligibility on Send and lets the user cancel a blocked compact', () => {
		useApp.getState().setCompactDraft('fork', DEFAULT_COMPACT)
		const onCompact = vi.fn(async () => {})
		const send = vi.spyOn(client, 'sendPrompt')
		const composer = renderComposer('fork', {
			onCompact,
			compactUnavailable: 'Wait for this turn to finish before compacting'
		})
		expect(composer.send.disabled).toBe(true)
		expect(composer.html).toContain('Wait for this turn to finish before compacting')
		composer.send.onClick?.({} as never)
		expect(onCompact).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
		composer.button('Cancel compact before sending').onClick?.({} as never)
		expect(useApp.getState().compactDrafts.fork).toBeUndefined()
	})

	test('keeps both the text and compact selection when creating the new chat fails', async () => {
		useApp.getState().setCompactDraft('fork', DEFAULT_COMPACT)
		vi.mocked(client.splitChat).mockRejectedValue(new Error('Mac is locked'))
		const send = vi.spyOn(client, 'sendPrompt')
		const onCompact = vi.fn(async () => {
			await handoffChat({ sessionId: 'fork', workspaceId: 'workspace' }, DEFAULT_COMPACT, {
				replace: true,
				onReady: async () => {}
			})
		})
		renderComposer('fork', { onCompact }).send.onClick?.({} as never)
		await vi.waitFor(() => expect(client.splitChat).toHaveBeenCalledOnce())
		expect(useApp.getState().drafts.fork).toBe('Continue this work')
		expect(useApp.getState().draftAttachments.fork).toEqual([file])
		expect(loadCompactDrafts().fork).toEqual(DEFAULT_COMPACT)
		expect(send).not.toHaveBeenCalled()
	})

	test.each([false, true])('delivers to the prepared chat and retries there after reload (queue: %j)', async queue => {
		useApp.getState().setCompactDraft('fork', DEFAULT_COMPACT)
		useApp.getState().stageAgent('fork', { model: 'Chosen model', effort: 'high' })
		const send = vi
			.spyOn(client, 'sendPrompt')
			.mockResolvedValueOnce({ ...delivered, ok: false, error: 'Connection lost' })
		let prepared: string | null = null
		const onReady = vi.fn(async () => {})
		const onCompact = async (queue: boolean) => {
			const result = await handoffChat({ sessionId: 'fork', workspaceId: 'workspace' }, DEFAULT_COMPACT, {
				replace: true,
				onPrepared: split => {
					prepared = split.sessionId
				},
				onReady
			})
			await sendHandoffDraft(result.split, queue, composer.retry)
		}
		const composer = renderComposer('fork', { onCompact })
		if (queue) {
			composer.textarea.onKeyDown?.({
				key: 'Enter',
				shiftKey: false,
				metaKey: true,
				ctrlKey: false,
				nativeEvent: { isComposing: false },
				preventDefault: vi.fn()
			} as unknown as Parameters<NonNullable<typeof composer.textarea.onKeyDown>>[0])
		} else composer.send.onClick?.({} as never)
		await vi.waitFor(() => expect(useApp.getState().pending[0]?.status).toBe('error'))
		const payload = `${file.token}\n${context.token}\nContinue this work`
		expect(prepared).toBe('replacement')
		expect(onReady).toHaveBeenCalledWith(copied)
		expect(send).toHaveBeenCalledExactlyOnceWith(
			'replacement',
			payload,
			'workspace',
			{ model: 'Chosen model', effort: 'high' },
			expect.any(String),
			queue,
			false
		)
		expect(loadCompactDrafts()).toEqual({})
		expect(useApp.getState().draftAttachments.replacement).toBeUndefined()
		const pending = loadPending()
		useApp.setState({ pending })
		send.mockResolvedValueOnce(delivered)
		await expect(composer.retry(pending[0])).resolves.toBe(true)
		expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
		expect(client.splitChat).toHaveBeenCalledOnce()
	})

	test('blocks a second send while the destination draft is still being prepared', () => {
		useApp.getState().setDraftContent('replacement', 'Continue this work', [context])
		const send = vi.spyOn(client, 'sendPrompt')
		const composer = renderComposer('replacement', { preparingCompact: true })
		expect(composer.html).toContain('Compacting and sending…')
		expect(composer.textarea.disabled).toBe(true)
		expect(composer.send.disabled).toBe(true)
		composer.send.onClick?.({} as never)
		expect(send).not.toHaveBeenCalled()
	})
})
