import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { Session } from '../src/wire.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { DiffButton, DiffFileScopeToggle, SessionTabs } = await import('../web/src/components/SessionView.tsx')

const session: Session = {
	id: 'chat-1',
	status: 'idle',
	title: 'Alpha',
	model: 'Sonnet',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'claude',
	context_used_percent: 42,
	unread_count: 0,
	created_at: '2026-09-03 10:00:00',
	updated_at: '2026-09-03 10:00:00',
	last_user_message_at: null,
	prompt_cache_ttl_ms: null,
	turn_started_at: null,
	background_tasks: []
}

describe('phone chat tabs', () => {
	test('hides the close control when there is only one tab', () => {
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[session]}
				activeId={session.id}
				readMarks={{}}
				promptStates={{}}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain('Alpha')
		expect(html).not.toContain('aria-label="Close Alpha chat"')
		expect(html).toContain('aria-label="Context for Alpha: 42% used"')
		expect(html.match(/<button/g)).toHaveLength(3)
	})

	test('keeps selection and close as separate controls with multiple tabs', () => {
		const secondSession: Session = { ...session, id: 'chat-2', title: 'Beta' }
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[session, secondSession]}
				activeId={session.id}
				readMarks={{}}
				promptStates={{}}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain('aria-label="Close Alpha chat"')
		expect(html).toContain('aria-label="Close Beta chat"')
		expect(html.match(/<button/g)).toHaveLength(7)
	})

	test('shows the full tab title without a width cap', () => {
		const longTitle = 'Auk brain memory retrieval improvements'
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[{ ...session, title: longTitle }]}
				activeId={session.id}
				readMarks={{}}
				promptStates={{}}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain(`<span class="whitespace-nowrap">${longTitle}</span>`)
		expect(html).not.toContain('truncate')
		expect(html).not.toContain('max-w-36')
	})

	test('keeps durable workflow children out of the parent tab row', () => {
		const childSession: Session = { ...session, id: 'chat-2', title: 'Explorer' }
		const manualSession: Session = { ...session, id: 'chat-3', title: 'Manual' }
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[session, childSession, manualSession]}
				activeId={childSession.id}
				readMarks={{}}
				promptStates={{}}
				roles={{
					[session.id]: { role: 'planning', assignedAt: 1 },
					[childSession.id]: { role: 'exploration', delegationId: 'job-1', assignedAt: 2 }
				}}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain('Alpha')
		expect(html).toContain('Manual')
		expect(html).not.toContain('Explorer')
		expect(html).toContain('aria-label="Close Alpha chat"')
		expect(html).toContain('aria-label="Close Manual chat"')
		expect(html).not.toContain('aria-label="Close Explorer chat"')
	})

	test('keeps New chat reachable after the last tab closes', () => {
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[]}
				activeId={null}
				readMarks={{}}
				promptStates={{}}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)
		expect(html).toContain('aria-label="New chat, same files"')
	})
})

describe('workspace diff shortcut', () => {
	test('offers changed and all file scopes', () => {
		const changed = renderToStaticMarkup(<DiffFileScopeToggle scope="changed" onChange={vi.fn()} />)
		const all = renderToStaticMarkup(<DiffFileScopeToggle scope="all" onChange={vi.fn()} />)

		expect(changed).toContain('aria-label="Changed files" aria-pressed="true"')
		expect(changed).toContain('aria-label="All files" aria-pressed="false"')
		expect(all).toContain('aria-label="Changed files" aria-pressed="false"')
		expect(all).toContain('aria-label="All files" aria-pressed="true"')
	})

	test('shows a dot only when the workspace has changes', () => {
		const changed = renderToStaticMarkup(
			<DiffButton stats={{ added: 12, removed: 0 }} open={false} onToggle={vi.fn()} />
		)
		const clean = renderToStaticMarkup(<DiffButton stats={{ added: 0, removed: 0 }} open={false} onToggle={vi.fn()} />)

		expect(changed).toContain('Toggle diff panel, changes available')
		expect(changed).toContain('bg-accent')
		expect(clean).toContain('aria-label="Toggle diff panel"')
		expect(clean).not.toContain('bg-accent')
	})
})
