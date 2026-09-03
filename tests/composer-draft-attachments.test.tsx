import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Session } from '../src/wire.ts'

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
const { Composer } = await import('../web/src/components/Composer.tsx')

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

function renderComposer(session: Session, workflowStarted = false): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<Composer
				session={session}
				sessionId="chat"
				workspaceId="workspace"
				working={false}
				workflowStarted={workflowStarted}
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
})
