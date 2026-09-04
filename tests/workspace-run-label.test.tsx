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

describe('workspace sidebar run label', () => {
	test('keeps the active model for an ordinary workspace', () => {
		const html = renderToStaticMarkup(<WorkspaceRunLabel workspace={ordinary} modelGroups={modelGroups} />)

		expect(html).toContain('Fable 5.1')
		expect(html).not.toContain('Workflow')
	})

	test('shows Workflow instead of one model once the workspace has a role assignment', () => {
		const workspace = {
			...ordinary,
			session_roles: {
				'chat-1': { role: 'planning', assignedAt: 1 }
			}
		}
		const html = renderToStaticMarkup(<WorkspaceRunLabel workspace={workspace} modelGroups={modelGroups} />)

		expect(html).toContain('Workflow')
		expect(html).toContain('Delegated workflow')
		expect(html).not.toContain('Fable 5.1')
	})

	test('recognizes a workflow while its first planning prompt is still pending', () => {
		expect(
			workspaceHasWorkflow({
				...ordinary,
				pending_prompt: {
					workspaceId: 'workspace-1',
					text: 'Run the workflow.',
					sessionRole: 'planning',
					status: 'waiting',
					attempts: 0,
					createdAt: 1
				}
			})
		).toBe(true)
	})
})
