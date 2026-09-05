import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { DelegationProjection, Session, WorkflowRunWire } from '../../src/wire.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { delegationPipelineForParentSession, delegationPipelinesForSession, workflowForActiveSession } = await import(
	'../../web/src/components/session/selection.ts'
)
const { DiffButton, DiffFileScopeToggle, DiffFolderToggle } = await import(
	'../../web/src/components/session/DiffPanel.tsx'
)
const { SessionTabs } = await import('../../web/src/components/session/SessionTabs.tsx')
const { SubagentReplyNotice } = await import('../../web/src/components/session/SessionNotices.tsx')
const { ClosedTabsList } = await import('../../web/src/components/session/ClosedTabsSheet.tsx')
const { DelegationPipeline } = await import('../../web/src/components/orchestration/DelegationPipeline.tsx')

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

	test('scopes delegation subtabs to their owning parent', () => {
		const workflow: WorkflowRunWire = {
			id: 'workflow-1',
			workspaceId: 'workspace-1',
			rootSessionId: 'parent-1',
			phase: 'exploring',
			objectiveExcerpt: 'Inspect it.',
			roles: {
				planning: { model: 'Fable 5.1', agentType: 'claude' },
				exploration: { model: '5.6 Terra', agentType: 'codex' },
				implementation: { model: '5.6 Sol', agentType: 'codex' }
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
		}
		const childJob = {
			id: 'job-1',
			workspaceId: 'workspace-1',
			parentSessionId: 'parent-1',
			childSessionId: 'child-1',
			workflowId: workflow.id,
			role: 'exploration',
			resolvedRole: workflow.roles.exploration,
			prompt: 'Inspect it.',
			returnMode: 'queue',
			status: 'running',
			attempts: 0,
			createdAt: 1,
			updatedAt: 2
		} satisfies DelegationProjection
		const roles = {
			'parent-1': { role: 'planning', workflowId: workflow.id, assignedAt: 1 },
			'child-1': { role: 'exploration', workflowId: workflow.id, delegationId: childJob.id, assignedAt: 2 }
		}

		const selected = delegationPipelineForParentSession([workflow], [childJob], roles, 'parent-1')
		expect(selected?.workflow?.id).toBe(workflow.id)
		expect(selected?.jobs).toEqual([childJob])
		expect(selected?.roles).toEqual(roles)
		expect(delegationPipelineForParentSession([workflow], [childJob], roles, 'child-1')).toBeUndefined()
		expect(delegationPipelineForParentSession([workflow], [childJob], roles, 'ordinary-chat')).toBeUndefined()
		// Opening a child retains its parent's row even before its role snapshot arrives.
		expect(delegationPipelinesForSession([workflow], [childJob], roles, 'child-1')).toEqual([selected])
		expect(delegationPipelinesForSession([workflow], [childJob], {}, 'child-1')[0]?.jobs).toEqual([childJob])
		// Returned jobs can disappear, leaving only the durable Workflow assignment.
		expect(delegationPipelinesForSession([workflow], [], roles, 'child-1')[0]?.workflow).toBe(workflow)
		expect(delegationPipelinesForSession([workflow], [childJob], roles, 'ordinary-chat')).toEqual([])
	})

	test.each(['parent', 'child-1', 'child-2'])('keeps completed sibling subtabs visible with %s selected', activeId => {
		const roles = {
			'child-1': { role: 'exploration', delegationId: 'job-1', parentSessionId: 'parent', assignedAt: 1 },
			'child-2': { role: 'review', delegationId: 'job-2', parentSessionId: 'parent', assignedAt: 2 },
			unrelated: { role: 'implementation', delegationId: 'job-3', parentSessionId: 'other-parent', assignedAt: 3 }
		}
		const sessions = Object.keys(roles).map(id => ({ ...session, id }))
		const pipelines = delegationPipelinesForSession([], [], roles, activeId)
		const html = renderToStaticMarkup(
			pipelines.map(pipeline => (
				<DelegationPipeline
					key={pipeline.parentSessionId}
					{...pipeline}
					sessions={sessions}
					activeSessionId={activeId}
					onSelectSession={vi.fn()}
				/>
			))
		)
		expect(html).toContain('exploration')
		expect(html).toContain('review')
		expect(html).not.toContain('implementation')
		expect(html.match(/<button/g)).toHaveLength(2)
		const selectedButtons = html.match(/<button\b[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/g) ?? []
		expect(selectedButtons).toHaveLength(activeId === 'parent' ? 0 : 1)
		if (activeId !== 'parent') expect(selectedButtons[0]).toContain(activeId === 'child-1' ? 'exploration' : 'review')
	})

	test('a delegated parent does not appear as its own child when it has a nested delegation', () => {
		const roles = {
			parent: { role: 'exploration', delegationId: 'first-job', parentSessionId: 'root', assignedAt: 1 },
			child: { role: 'review', delegationId: 'nested-job', parentSessionId: 'parent', assignedAt: 2 }
		}
		expect(delegationPipelineForParentSession([], [], roles, 'parent')?.roles).toEqual({ child: roles.child })
		expect(delegationPipelineForParentSession([], [], roles, 'root')?.roles).toEqual({ parent: roles.parent })
		for (const activeId of ['parent', 'child']) {
			expect(delegationPipelinesForSession([], [], roles, activeId).map(pipeline => pipeline.parentSessionId)).toEqual([
				'root',
				'parent'
			])
		}
	})

	test('keeps completed ad hoc children under their exact parent without a planning role', () => {
		const roles = {
			'child-1': { role: 'exploration', delegationId: 'job-1', parentSessionId: 'ordinary-1', assignedAt: 1 },
			'child-2': { role: 'exploration', delegationId: 'job-2', parentSessionId: 'ordinary-2', assignedAt: 2 },
			'old-planner': { role: 'planning', assignedAt: 0 },
			'old-child': { role: 'exploration', delegationId: 'old-job', assignedAt: 0 }
		}
		expect(delegationPipelineForParentSession([], [], roles, 'ordinary-1')?.roles).toEqual({
			'child-1': roles['child-1']
		})
		expect(delegationPipelineForParentSession([], [], roles, 'ordinary-2')?.roles).toEqual({
			'child-2': roles['child-2']
		})
		expect(delegationPipelineForParentSession([], [], roles, 'unrelated')).toBeUndefined()
		expect(delegationPipelineForParentSession([], [], roles, 'child-1')).toBeUndefined()
		expect(delegationPipelineForParentSession([], [], roles, 'old-planner')?.roles).toEqual({
			'old-planner': roles['old-planner'],
			'old-child': roles['old-child']
		})
		expect(delegationPipelinesForSession([], [], roles, 'old-child').map(pipeline => pipeline.parentSessionId)).toEqual(
			['old-planner']
		)
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
				onClosedTabs={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain('Alpha')
		expect(html).not.toContain('aria-label="Close Alpha chat"')
		expect(html).toContain('aria-label="Context for Alpha: 42% used"')
		expect(html.match(/<button/g)).toHaveLength(4)
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
				onClosedTabs={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)

		expect(html).toContain('aria-label="Close Alpha chat"')
		expect(html).toContain('aria-label="Close Beta chat"')
		expect(html.match(/<button/g)).toHaveLength(8)
	})

	test.each([true, false])('keeps one selected tab with the file active=%s', active => {
		const html = renderToStaticMarkup(
			<SessionTabs
				sessions={[session]}
				activeId={session.id}
				readMarks={{}}
				promptStates={{}}
				fileTab={{ path: 'web/src/App.tsx', active, onSelect: vi.fn(), onClose: vi.fn() }}
				onSelect={vi.fn()}
				onContext={vi.fn()}
				onNewChat={vi.fn()}
				onClose={vi.fn()}
				onClosedTabs={vi.fn()}
				creating={false}
				closingId={null}
				online={false}
			/>
		)

		const currentButton = html.match(/<button\b[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/g) ?? []
		expect(currentButton).toHaveLength(1)
		expect(currentButton[0]).toContain(active ? 'App.tsx' : 'Alpha')
		// Switching to the chat keeps the local file reachable, with the full path
		// available even though its visible label is only the filename.
		expect(html).toContain('aria-label="Open web/src/App.tsx"')
		expect(html).toContain('title="web/src/App.tsx"')
		expect(html).toContain('<span class="whitespace-nowrap">App.tsx</span>')
		// The preview can close offline and does not count as a second Conductor chat.
		expect(html).toMatch(/<button\b(?![^>]*disabled)[^>]*aria-label="Close web\/src\/App.tsx file tab"/)
		expect(html).not.toContain('aria-label="Close Alpha chat"')
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
				onClosedTabs={vi.fn()}
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
				onClosedTabs={vi.fn()}
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

	test('keeps New chat and Closed tabs reachable after the last tab closes', () => {
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
				onClosedTabs={vi.fn()}
				creating={false}
				closingId={null}
				online
			/>
		)
		expect(html).toContain('aria-label="New chat, same files"')
		expect(html).toContain('aria-label="Closed tabs"')
	})

	test('makes a native child read-only and names the parent reply destination', () => {
		const html = renderToStaticMarkup(<SubagentReplyNotice title="Alpha" onReturn={vi.fn()} />)

		expect(html).toContain('Return to Alpha to reply')
		expect(html).toContain('border-t')
	})
})

describe('closed tab picker', () => {
	test('finds closed chats by title and model and retains a restore action for duplicate titles', () => {
		const sessions = [session, { ...session, id: 'chat-2', model: 'gpt-5.6-sol' }]
		const html = renderToStaticMarkup(
			<ClosedTabsList sessions={sessions} filter="alpha sol" restoringId={null} online onRestore={vi.fn()} />
		)
		expect(html).toContain('aria-label="Restore Alpha chat"')
		expect(html.match(/<button/g)).toHaveLength(1)
		const duplicates = renderToStaticMarkup(
			<ClosedTabsList sessions={sessions} filter="" restoringId={null} online onRestore={vi.fn()} />
		)
		expect(duplicates.match(/aria-label="Restore Alpha chat"/g)).toHaveLength(2)
	})

	test('distinguishes an empty history from an unmatched search', () => {
		const empty = renderToStaticMarkup(
			<ClosedTabsList sessions={[]} filter="" restoringId={null} online onRestore={vi.fn()} />
		)
		const unmatched = renderToStaticMarkup(
			<ClosedTabsList sessions={[session]} filter="missing" restoringId={null} online onRestore={vi.fn()} />
		)
		expect(empty).toContain('No closed tabs in this workspace.')
		expect(unmatched).toContain('No closed tabs match your search.')
	})

	test('disables restores offline and prevents a second restore while one is waiting', () => {
		const offline = renderToStaticMarkup(
			<ClosedTabsList sessions={[session]} filter="" restoringId={null} online={false} onRestore={vi.fn()} />
		)
		const restoring = renderToStaticMarkup(
			<ClosedTabsList
				sessions={[session, { ...session, id: 'chat-2', title: 'Beta' }]}
				filter=""
				restoringId={session.id}
				online
				onRestore={vi.fn()}
			/>
		)
		expect(offline).toContain('disabled=""')
		expect(restoring.match(/disabled=""/g)).toHaveLength(2)
		expect(restoring.match(/Restoring…/g)).toHaveLength(1)
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

	test('makes folder grouping an explicit file-rail preference', () => {
		const folders = renderToStaticMarkup(<DiffFolderToggle showFolders onChange={vi.fn()} />)
		const flat = renderToStaticMarkup(<DiffFolderToggle showFolders={false} onChange={vi.fn()} />)

		expect(folders).toContain('aria-label="Group files into folders"')
		expect(folders).toContain('aria-pressed="true"')
		expect(flat).toContain('aria-pressed="false"')
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
