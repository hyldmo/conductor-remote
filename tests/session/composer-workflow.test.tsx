import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Session, StartWorkflowResponse } from '../../src/wire.ts'

// SSR normally reads Zustand's immutable initial snapshot. Render each live
// snapshot here so tab changes and completed requests exercise the real store.
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
const { useSendPrompt } = await import('../../web/src/hooks/send.ts')
const { client } = await import('../../web/src/lib/api.ts')
const { loadWorkflowDrafts } = await import('../../web/src/lib/prompts/workflow-draft.ts')
const { useApp } = await import('../../web/src/store.ts')

const session: Session = {
	id: 'chat-a',
	status: 'idle',
	title: null,
	model: '5.6 Sol',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'codex',
	context_used_percent: null,
	unread_count: 0,
	created_at: '2026-09-05 10:00:00',
	updated_at: '2026-09-05 10:00:00',
	last_user_message_at: null,
	prompt_cache_ttl_ms: null,
	turn_started_at: null,
	background_tasks: []
}

const roles = {
	planning: { model: 'Claude Opus 4.6', agentType: 'claude', effort: 'high' as const },
	exploration: { model: '5.6 Terra', agentType: 'codex' },
	implementation: { model: '5.6 Sol', agentType: 'codex' }
}
const response: StartWorkflowResponse = {
	workflow: {
		id: 'workflow-a',
		workspaceId: 'workspace',
		rootSessionId: session.id,
		phase: 'pending_root',
		objectiveExcerpt: 'Build it.',
		roles,
		jobs: {
			exploration: { requested: 1, running: 0, returned: 0, failed: 0 },
			implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
		},
		actions: { canRetry: false, canAdopt: false, canReplayAmbiguous: false, canCancel: true, canComplete: false },
		createdAt: 1,
		updatedAt: 1
	}
}

let queryClient: InstanceType<typeof QueryClient>
beforeEach(() => {
	storage.clear()
	useApp.setState({ pending: [], workflowDrafts: {}, workflowClientAttempts: {}, agentDrafts: {} })
	for (const id of ['chat-a', 'chat-b']) useApp.getState().clearDraftContent(id)
	queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
	queryClient.setQueryData(['roles'], { version: 1, roles, issues: [] })
})
afterEach(() => {
	queryClient.clear()
	vi.restoreAllMocks()
})

function renderComposer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<Composer session={session} sessionId={session.id} workspaceId="workspace" working={false} {...props} />
		</QueryClientProvider>
	)
}

function sendHook(): ReturnType<typeof useSendPrompt> {
	let send: ReturnType<typeof useSendPrompt> | undefined
	function Probe() {
		send = useSendPrompt()
		return null
	}
	renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<Probe />
		</QueryClientProvider>
	)
	if (!send) throw new Error('send hook did not render')
	return send
}

describe('Workflow before a tab’s first message', () => {
	test('keeps separate unsent choices across tab switches and reloads, without starting anything', () => {
		const start = vi.spyOn(client, 'startWorkflow')
		const ordinary = vi.spyOn(client, 'sendPrompt')
		useApp.getState().setDraft(session.id, 'Build it.')
		useApp.getState().stageAgent(session.id, { model: '5.6 Terra', effort: 'medium' })
		expect(renderComposer()).toContain('aria-label="Workflow mode off"')

		useApp.getState().setWorkflowDraft('chat-a', true)
		expect(renderComposer()).toContain('aria-label="Workflow mode on"')
		expect(renderComposer()).toContain('currently Claude Opus 4.6')
		expect(renderComposer().match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]).not.toMatch(/\sdisabled(?:=|\s|>)/)
		expect(renderComposer({ session: { ...session, id: 'chat-b' }, sessionId: 'chat-b' })).toContain(
			'aria-label="Workflow mode off"'
		)
		useApp.getState().setWorkflowDraft('chat-b', true)
		useApp.setState({ workflowDrafts: loadWorkflowDrafts() })
		expect(renderComposer()).toContain('aria-label="Workflow mode on"')
		useApp.getState().setWorkflowDraft('chat-a', false)
		expect(renderComposer()).toContain('currently 5.6 Terra')
		expect(useApp.getState().drafts['chat-a']).toBe('Build it.')
		expect(useApp.getState().workflowDrafts).toEqual({ 'chat-b': true })
		expect(start).not.toHaveBeenCalled()
		expect(ordinary).not.toHaveBeenCalled()
	})

	test('offers the mode only on idle, untouched, unclaimed tabs', () => {
		for (const props of [
			{ session: { ...session, last_user_message_at: '2026-09-05 10:01:00' } },
			{ session: { ...session, status: 'error' } },
			{
				session: {
					...session,
					background_tasks: [
						{
							taskId: 'task',
							toolUseId: null,
							description: 'Waiting',
							taskType: 'local_bash',
							since: session.updated_at
						}
					]
				}
			},
			{ working: true },
			{ workflowStarted: true },
			{ workflow: response.workflow },
			{ hasPendingPrompt: true }
		]) {
			expect(renderComposer(props)).not.toContain('aria-label="Workflow mode')
		}
		useApp.getState().addPending({ id: 'ordinary-send', sessionId: 'chat-a', workspaceId: 'workspace', text: 'First.' })
		expect(renderComposer()).not.toContain('aria-label="Workflow mode')
		useApp.getState().failPending('ordinary-send', 'Response lost')
		expect(renderComposer()).not.toContain('aria-label="Workflow mode')
		expect(renderComposer({ session: { ...session, id: 'chat-b' }, sessionId: 'chat-b' })).toContain(
			'aria-label="Workflow mode off"'
		)
		useApp.getState().removePending('ordinary-send')
		expect(renderComposer()).toContain('aria-label="Workflow mode off"')
	})

	test('blocks Send if a selected tab becomes ineligible instead of silently sending an ordinary prompt', () => {
		useApp.getState().setDraft(session.id, 'Build it.')
		useApp.getState().setWorkflowDraft(session.id, true)
		const html = renderComposer({ hasPendingPrompt: true })
		expect(html).toContain('aria-label="Workflow mode on"')
		expect(html).toContain('Resolve or dismiss the pending prompt')
		expect(html.match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]).toMatch(/\sdisabled(?:=|\s|>)/)
	})

	test('creates the run on Send and clears only its accepted tab’s draft and mode', async () => {
		useApp.getState().setDraft(session.id, 'Build it.')
		useApp.getState().setWorkflowDraft('chat-a', true)
		useApp.getState().setWorkflowDraft('chat-b', true)
		useApp.getState().stageAgent(session.id, { model: '5.6 Terra', effort: 'medium' })
		const ordinary = vi.spyOn(client, 'sendPrompt')
		let accept: (value: StartWorkflowResponse) => void = () => {
			throw new Error('start was not called')
		}
		const start = vi.spyOn(client, 'startWorkflow').mockImplementation(
			() =>
				new Promise(resolve => {
					accept = resolve
				})
		)
		const sending = sendHook()({ sessionId: session.id, workspaceId: 'workspace', text: 'Build it.', workflow: true })

		expect(useApp.getState().drafts['chat-a']).toBe('Build it.')
		expect(loadWorkflowDrafts()).toEqual({ 'chat-a': true, 'chat-b': true })
		expect(start).toHaveBeenCalledWith({
			clientId: expect.any(String),
			objective: 'Build it.',
			target: { kind: 'existing_session', workspaceId: 'workspace', sessionId: 'chat-a' }
		})
		accept(response)
		await expect(sending).resolves.toBe(true)
		expect(useApp.getState().drafts['chat-a'] ?? '').toBe('')
		expect(loadWorkflowDrafts()).toEqual({ 'chat-b': true })
		expect(useApp.getState().agentDrafts['chat-a']).toBeUndefined()
		expect(ordinary).not.toHaveBeenCalled()
	})

	test('keeps the mode and objective after a lost response and retries with the same identity', async () => {
		useApp.getState().setDraft(session.id, 'Build it.')
		useApp.getState().setWorkflowDraft(session.id, true)
		const start = vi
			.spyOn(client, 'startWorkflow')
			.mockRejectedValueOnce(new Error('Response lost'))
			.mockResolvedValueOnce(response)
		const send = sendHook()
		const request = { sessionId: session.id, workspaceId: 'workspace', text: 'Build it.', workflow: true }
		await expect(send(request)).resolves.toBe(false)
		expect(loadWorkflowDrafts()['chat-a']).toBe(true)
		expect(useApp.getState().drafts['chat-a']).toBe('Build it.')
		await expect(send(request)).resolves.toBe(true)
		expect(start.mock.calls[1][0].clientId).toBe(start.mock.calls[0][0].clientId)
		expect(loadWorkflowDrafts()['chat-a']).toBeUndefined()
	})
})
