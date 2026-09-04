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

	test('shows Workflow instead of one model only from the explicit run projection', () => {
		const workspace = {
			...ordinary,
			workflow
		}
		const html = renderToStaticMarkup(<WorkspaceRunLabel workspace={workspace} modelGroups={modelGroups} />)

		expect(html).toContain('Workflow')
		expect(html).toContain('Managed Workflow')
		expect(html).toContain('Accepted')
		expect(html).not.toContain('Fable 5.1')
	})

	test('does not infer Workflow ownership from legacy role or prompt artifacts', () => {
		const legacyArtifacts = {
			...ordinary,
			delegations: [{ id: 'legacy-job' }],
			session_roles: { 'chat-1': { role: 'planning' } },
			pending_prompt: { sessionRole: 'planning' }
		}

		expect(workspaceHasWorkflow(legacyArtifacts)).toBe(false)
	})
})
