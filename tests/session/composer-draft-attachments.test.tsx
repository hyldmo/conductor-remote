import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ContextBreakdownResponse, Session, WorkflowRunWire } from '../../src/wire.ts'

class MemoryStorage {
	private readonly values = new Map<string, string>()

	get length(): number {
		return this.values.size
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}

	setItem(key: string, value: string): void {
		this.values.set(key, String(value))
	}

	removeItem(key: string): void {
		this.values.delete(key)
	}
}

const storage = new MemoryStorage()
storage.setItem(
	'conductor-remote-prefs-v1',
	JSON.stringify({
		version: 1,
		drafts: {
			chat: {
				text: '',
				agent: {},
				attachments: [
					{
						name: 'diagram.png',
						path: '.context/attachments/abc123/diagram.png',
						bytes: 42,
						token: '@⟦diagram.png⟧(.context%2Fattachments%2Fabc123%2Fdiagram.png)'
					}
				],
				updatedAt: 10,
				deleted: false
			}
		}
	})
)

Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: { hash: '', pathname: '/w/workspace', search: '' }
})
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { Composer } = await import('../../web/src/components/session/Composer.tsx')

const pristineSession: Session = {
	id: 'chat',
	status: 'idle',
	title: null,
	model: '5.6 Sol',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'codex',
	context_used_percent: null,
	unread_count: 0,
	created_at: '2026-09-03 10:00:00',
	updated_at: '2026-09-03 10:00:00',
	last_user_message_at: null,
	prompt_cache_ttl_ms: null,
	turn_started_at: null,
	background_tasks: []
}

const workflow: WorkflowRunWire = {
	id: 'workflow-1',
	workspaceId: 'workspace',
	rootSessionId: 'chat',
	phase: 'exploring',
	objectiveExcerpt: 'Build it',
	roles: {
		planning: { model: 'Fable 5.1', agentType: 'claude' },
		exploration: { model: '5.6 Terra', agentType: 'codex' },
		implementation: { model: '5.6 Sol', agentType: 'codex' }
	},
	jobs: {
		exploration: { requested: 1, running: 1, returned: 0, failed: 0 },
		implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
	},
	actions: { canRetry: false, canAdopt: false, canReplayAmbiguous: false, canCancel: true, canComplete: false },
	createdAt: 1,
	updatedAt: 2
}

function renderComposer(
	session: Session,
	workflowStarted = false,
	onContext?: () => void,
	contextBreakdown?: ContextBreakdownResponse
): string {
	const queryClient = new QueryClient()
	if (contextBreakdown) {
		queryClient.setQueryData(['context-breakdown', session.id, session.updated_at], contextBreakdown)
	}
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<Composer
				session={session}
				sessionId="chat"
				workspaceId="workspace"
				working={false}
				workflowStarted={workflowStarted}
				onCall={() => {}}
				onContext={onContext}
				workflow={workflowStarted ? workflow : undefined}
			/>
		</QueryClientProvider>
	)
}

describe('a restored attachment-only composer draft', () => {
	it('draws the ready file and can send it without caption text', () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<Composer sessionId="chat" workspaceId="workspace" working={false} />
			</QueryClientProvider>
		)

		expect(html).toContain('diagram.png')
		expect(html).toContain('aria-label="Remove diagram.png"')
		const sendButton = html.match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]
		expect(sendButton).toBeDefined()
		expect(sendButton).not.toMatch(/\sdisabled(?:=|\s|>)/)
	})

	it('offers Workflow only on an untouched, unclaimed chat', () => {
		expect(renderComposer(pristineSession)).toContain('aria-label="Workflow mode off"')
		expect(renderComposer({ ...pristineSession, last_user_message_at: '2026-09-03 10:01:00' })).not.toContain(
			'aria-label="Workflow mode'
		)
		expect(renderComposer(pristineSession, true)).not.toContain('aria-label="Workflow mode')
	})

	it('places the chat call beside the context donut and attachments', () => {
		const html = renderComposer({ ...pristineSession, context_used_percent: 42 }, false, () => {})
		const call = html.indexOf('aria-label="Call this chat"')
		const context = html.indexOf('aria-label="Context for Untitled: 42% used"')
		const attachments = html.indexOf('aria-label="Attach files"')

		expect(call).toBeGreaterThan(-1)
		expect(call).toBeLessThan(context)
		expect(context).toBeGreaterThan(-1)
		expect(context).toBeLessThan(attachments)
		expect(html).toContain('stroke-dasharray="42 58"')
		expect(html).toContain('stroke-accent')
	})

	it('turns the context donut amber near compaction pressure', () => {
		const html = renderComposer({ ...pristineSession, context_used_percent: 84.6 }, false, () => {})

		expect(html).toContain('aria-label="Context for Untitled: 85% used"')
		expect(html).toContain('stroke-working')
	})

	it('subdivides the used arc with the same four colors as the context sheet', () => {
		const html = renderComposer({ ...pristineSession, context_used_percent: 50 }, false, () => {}, {
			totalTokens: 100_000,
			usedPercent: 50,
			compacted: false,
			categories: { initial: 20_000, chat: 30_000, thinking: 10_000, tools: 40_000 },
			forkTokens: { concise: 20_000, reasoning: 30_000, full: 80_000 }
		})

		for (const [type, color] of [
			['initial', 'stroke-context-initial'],
			['chat', 'stroke-context-chat'],
			['thinking', 'stroke-working'],
			['tools', 'stroke-context-tools']
		] as const) {
			const segment = html.match(new RegExp(`<circle[^>]*data-context-segment="${type}"[^>]*>`))?.[0]
			expect(segment).toContain(color)
		}
		expect(html).toContain('stroke-dasharray="10 90"')
		expect(html).toContain('stroke-dasharray="15 85"')
		expect(html).toContain('stroke-dasharray="5 95"')
		expect(html).toContain('stroke-dasharray="20 80"')
		expect(html).toContain('stroke-dashoffset="-30"')
	})
})
