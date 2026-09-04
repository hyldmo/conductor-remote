import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { WorkspaceRunLabel, workspaceHasWorkflow } from '../web/src/components/WorkspaceRunLabel.tsx'

const modelGroups = [
	{
		agentType: 'claude',
		models: ['Fable 5.1'],
		updatedAt: 1
	}
]

const ordinary = {
	agent_type: 'claude',
	model: 'fable-5-1'
}

const configuredRoles = {
	planning: { model: 'Configured planner' },
	exploration: { model: 'Configured explorer' },
	implementation: { model: 'Configured implementer' }
}

const workflow = {
	id: 'workflow-1',
	workspaceId: 'workspace-1',
	rootSessionId: 'chat-1',
	phase: 'pending_root' as const,
	objectiveExcerpt: 'Run the workflow.',
	roles: {
		planning: { model: 'Fable 5.1', agentType: 'claude' },
		exploration: { model: '5.6 Terra', agentType: 'codex' },
		implementation: { model: 'Composer 2.5', agentType: 'cursor' }
	},
	jobs: {
		exploration: { requested: 1, running: 0, returned: 0, failed: 0 },
		implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
	},
	actions: { canRetry: false, canAdopt: false, canReplayAmbiguous: false, canCancel: true, canComplete: false },
	createdAt: 1,
	updatedAt: 2
}

describe('workspace sidebar run label', () => {
	test('keeps the active model for an ordinary workspace', () => {
		const html = renderToStaticMarkup(<WorkspaceRunLabel workspace={ordinary} modelGroups={modelGroups} />)

		expect(html).toContain('Fable 5.1')
		expect(html).not.toContain('Workflow')
	})

	test('shows the Workflow and frozen role icons in execution order instead of one model name', () => {
		const workspace = {
			...ordinary,
			workflow
		}
		const html = renderToStaticMarkup(
			<WorkspaceRunLabel workspace={workspace} modelGroups={modelGroups} configuredRoles={configuredRoles} />
		)

		const markers = [
			'data-workflow-icon',
			'data-workflow-role="planning"',
			'data-workflow-role="exploration"',
			'data-workflow-role="implementation"'
		]
		let prior = -1
		for (const marker of markers) {
			const index = html.indexOf(marker)
			expect(index).toBeGreaterThan(prior)
			prior = index
		}
		expect(html).toContain('Workflow · Accepted')
		expect(html).toContain('Planning: Fable 5.1')
		expect(html).not.toContain('Configured planner')
		expect(html).not.toContain('class="truncate">Workflow')
	})

	test('keeps the pre-coordinator planning-root signature and uses configured role icons', () => {
		const legacyWorkflow = {
			...ordinary,
			session_roles: { 'chat-1': { role: 'planning' } }
		}
		const html = renderToStaticMarkup(
			<WorkspaceRunLabel workspace={legacyWorkflow} modelGroups={modelGroups} configuredRoles={configuredRoles} />
		)

		expect(workspaceHasWorkflow(legacyWorkflow)).toBe(true)
		expect(html).toContain('Planning: Configured planner')
		expect(html).toContain('data-workflow-role="implementation"')
	})

	test('recognizes a pending Workflow but not arbitrary delegated role artifacts', () => {
		expect(workspaceHasWorkflow({ ...ordinary, pending_prompt: { sessionRole: 'planning' } })).toBe(true)
		expect(
			workspaceHasWorkflow({
				...ordinary,
				session_roles: {
					'chat-1': { role: 'exploration', delegationId: 'explore-1' },
					'chat-2': { role: 'planning', delegationId: 'planning-child' }
				}
			})
		).toBe(false)
	})

	test('keeps a completed durable Workflow as the workspace run identity', () => {
		const html = renderToStaticMarkup(
			<WorkspaceRunLabel
				workspace={{
					...ordinary,
					workflow_identity: { id: workflow.id, phase: 'completed', roles: workflow.roles }
				}}
				modelGroups={modelGroups}
			/>
		)

		expect(html).toContain('Workflow · Completed')
		expect(html).toContain('data-workflow-role="planning"')
	})
})
