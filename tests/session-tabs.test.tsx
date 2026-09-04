import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { DelegationProjection, Session, WorkflowRunWire } from '../src/wire.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { DiffButton, DiffFileScopeToggle, SessionTabs, workflowForActiveSession } = await import(
	'../web/src/components/SessionView.tsx'
)

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
	test('binds Workflow ownership to the exact root or child when one workspace has multiple runs', () => {
		const workflow = (id: string, rootSessionId: string): WorkflowRunWire => ({
			id,
			workspaceId: 'workspace-1',
			rootSessionId,
			phase: 'exploring',
			objectiveExcerpt: id,
			roles: {
				planning: { model: 'Fable 5.1', agentType: 'claude' },
				exploration: { model: '5.6 Terra', agentType: 'codex' },
				implementation: { model: 'Composer 2.5', agentType: 'cursor' }
			},
			jobs: {
				exploration: { requested: 1, running: 1, returned: 0, failed: 0 },
				implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
			},
			actions: {
				canRetry: false,
				canAdopt: false,
				canReplayAmbiguous: false,
				canCancel: true,
				canComplete: false
			},
			createdAt: 1,
			updatedAt: 2
		})
		const first = workflow('workflow-1', 'root-1')
		const second = workflow('workflow-2', 'root-2')
		const childJob = {
			id: 'job-2',
			workspaceId: 'workspace-1',
			parentSessionId: 'root-2',
			childSessionId: 'child-2',
			workflowId: second.id,
			role: 'exploration',
			resolvedRole: second.roles.exploration,
			prompt: 'Inspect it.',
			returnMode: 'queue',
			status: 'running',
			attempts: 0,
			createdAt: 1,
			updatedAt: 2
		} satisfies DelegationProjection

		expect(workflowForActiveSession([first, second], 'root-2', {}, [childJob])?.id).toBe(second.id)
		expect(
			workflowForActiveSession(
				[first, second],
				'child-2',
				{ 'child-2': { role: 'exploration', workflowId: second.id, delegationId: childJob.id, assignedAt: 2 } },
				[childJob]
			)?.id
		).toBe(second.id)
		expect(workflowForActiveSession([first, second], 'ordinary-chat', {}, [childJob])).toBeUndefined()
	})

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
