import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { DelegationProjection, Session, WorkflowRunWire } from '../../../src/wire.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const [
	{ DelegationPipeline },
	{ AgentSubtabStrip },
	{ UiQuarantineBanner, WorkflowWarningBanner },
	{ QueueBubble },
	{ RoleChip, RoleEditorCard, roleAgentType, roleDraftCanSave, roleModelProblem, roleWithModel }
] = await Promise.all([
	import('../../../web/src/components/orchestration/DelegationPipeline.tsx'),
	import('../../../web/src/components/orchestration/AgentSubtabs.tsx'),
	import('../../../web/src/components/orchestration/WorkflowWarnings.tsx'),
	import('../../../web/src/components/transcript/QueueBubble.tsx'),
	import('../../../web/src/components/orchestration/RolesSettings.tsx')
])

const running: DelegationProjection = {
	id: 'job-1',
	workspaceId: 'workspace-1',
	parentSessionId: 'parent-1',
	childSessionId: 'child-1',
	role: 'exploration',
	resolvedRole: { model: '5.6 Terra', agentType: 'codex', effort: 'high', fast: false },
	prompt: 'Inspect the picker behavior.',
	returnMode: 'queue',
	status: 'running',
	attempts: 0,
	createdAt: 1,
	updatedAt: 2
}

const completedChild: Session = {
	id: 'child-1',
	status: 'idle',
	title: 'Explorer',
	model: 'Muse Spark',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'acp',
	context_used_percent: 38,
	unread_count: 0,
	created_at: '2026-09-03 10:00:00',
	updated_at: '2026-09-03 10:05:00',
	last_user_message_at: '2026-09-03 10:01:00',
	prompt_cache_ttl_ms: null,
	turn_started_at: '2026-09-03 10:01:00',
	background_tasks: []
}

const blockedWorkflow: WorkflowRunWire = {
	id: 'workflow-1',
	workspaceId: 'workspace-1',
	rootSessionId: 'parent-1',
	phase: 'blocked',
	objectiveExcerpt: 'Fix deterministic orchestration.',
	roles: {
		planning: { model: 'Fable 5.1', agentType: 'claude', effort: 'max' },
		exploration: { model: '5.6 Terra', agentType: 'codex', effort: 'high', fast: false },
		implementation: { model: 'Composer 2.5', agentType: 'cursor' }
	},
	jobs: {
		exploration: { requested: 3, running: 1, returned: 1, failed: 1 },
		implementation: { requested: 0, running: 0, returned: 0, failed: 0 }
	},
	error: { code: 'ambiguous_effect', message: 'The child tab may already exist.', retryable: false },
	adoption: {
		actionId: 'open:explore:0',
		kind: 'session',
		candidates: [{ id: 'candidate-1', title: 'Explorer', repo: 'conductor-remote', createdAt: 3 }]
	},
	actions: {
		canRetry: false,
		canAdopt: true,
		canReplayAmbiguous: true,
		canCancel: true,
		canComplete: false
	},
	createdAt: 1,
	updatedAt: 2
}

describe('delegation phone surfaces', () => {
	test('QueueBubble keeps pending and failed actions presentational and distinct', () => {
		const pending = renderToStaticMarkup(
			<QueueBubble state="pending" label="Delegated · exploration" meta="Opening child chat">
				Inspect this.
			</QueueBubble>
		)
		expect(pending).toContain('Delegated · exploration')
		expect(pending).toContain('Opening child chat')

		const failed = renderToStaticMarkup(
			<QueueBubble
				state="failed"
				label="Delegated · exploration"
				meta="Model missing"
				actions={[
					{ label: 'Edit roles', onClick: vi.fn(), primary: true },
					{ label: 'Dismiss delegation', onClick: vi.fn() }
				]}
			>
				Inspect this.
			</QueueBubble>
		)
		expect(failed).toContain('Edit roles')
		expect(failed).toContain('Dismiss delegation')
	})

	test('pipeline renders nothing for zero jobs and stage/model for active jobs', () => {
		expect(renderToStaticMarkup(<DelegationPipeline jobs={[]} onSelectSession={vi.fn()} />)).toBe('')
		const html = renderToStaticMarkup(<DelegationPipeline jobs={[running]} onSelectSession={vi.fn()} />)
		expect(html).toContain('exploration')
		expect(html).toContain('5.6 Terra')
		expect(html).toContain('Running')
	})

	test('retains completed children as subtabs after their active job is gone', () => {
		const html = renderToStaticMarkup(
			<DelegationPipeline
				jobs={[]}
				sessions={[completedChild]}
				roles={{
					[completedChild.id]: { role: 'exploration', delegationId: 'job-1', assignedAt: 2 }
				}}
				activeSessionId={completedChild.id}
				onSelectSession={vi.fn()}
			/>
		)

		expect(html).toContain('exploration')
		expect(html).toContain('Muse Spark')
		expect(html).toContain('bg-text text-bg')
	})

	test('renders managed state only from WorkflowRunWire and keeps ad hoc tabs distinct', () => {
		const managedJob = { ...running, workflowId: blockedWorkflow.id, bootstrap: true }
		const withoutProjection = renderToStaticMarkup(<DelegationPipeline jobs={[managedJob]} onSelectSession={vi.fn()} />)
		expect(withoutProjection).toBe('')

		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<DelegationPipeline workflow={blockedWorkflow} jobs={[managedJob, running]} onSelectSession={vi.fn()} />
			</QueryClientProvider>
		)
		expect(html).toContain('Workflow coordination paused')
		expect(html).toContain('Chats already running can continue.')
		expect(html).toMatch(/<details[^>]*><summary[^>]*>Recovery options<\/summary>/)
		expect(html).toContain('Guaranteed explorer')
		expect(html).toContain('2 extra explorers')
		expect(html).toContain('Fable 5.1')
		expect(html).toContain('The child tab may already exist.')
		expect(html).toContain('Review risky replay')
		expect(html).toContain('Cancel workflow')
		expect(html).toContain('Delegated agents')
		expect(html).not.toContain('Legacy')
	})

	test.each(['working', 'idle'])('shows the main chat activity separately from a blocked workflow when %s', status => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<DelegationPipeline
					workflow={blockedWorkflow}
					jobs={[{ ...running, workflowId: blockedWorkflow.id }]}
					sessions={[{ ...completedChild, id: blockedWorkflow.rootSessionId!, status }]}
					onSelectSession={vi.fn()}
				/>
			</QueryClientProvider>
		)

		expect(html).toContain('Workflow coordination paused')
		expect(html.includes('The main chat is still running.')).toBe(status === 'working')
		expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*><summary[^>]*>Recovery options<\/summary>/)
	})

	test('keeps review stable until the phone explicitly marks it complete', () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<DelegationPipeline
					workflow={{
						...blockedWorkflow,
						phase: 'reviewing',
						error: undefined,
						adoption: undefined,
						actions: {
							canRetry: false,
							canAdopt: false,
							canReplayAmbiguous: false,
							canCancel: true,
							canComplete: true
						}
					}}
					jobs={[]}
					onSelectSession={vi.fn()}
				/>
			</QueryClientProvider>
		)
		expect(html).toContain('Reviewing')
		expect(html).toContain('Mark complete')
		expect(html).toMatch(/<details[^>]*\bopen=""[^>]*><summary[^>]*>Workflow actions<\/summary>/)
	})

	test('shows the global UI stability acknowledgement independently of a cancelled Workflow', () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<UiQuarantineBanner
					quarantine={{
						active: true,
						reason: 'A dispatched child-open action lost its owner.',
						createdAt: 1,
						actionId: 'open-child',
						effectId: 'effect-1'
					}}
				/>
				<DelegationPipeline
					workflow={{
						...blockedWorkflow,
						phase: 'cancelled',
						error: undefined,
						adoption: undefined,
						actions: {
							canRetry: false,
							canAdopt: false,
							canReplayAmbiguous: false,
							canCancel: false,
							canComplete: false
						}
					}}
					jobs={[]}
					onSelectSession={vi.fn()}
				/>
			</QueryClientProvider>
		)
		expect(html).toContain('Remote controls are paused')
		expect(html).toContain('Chats already running can continue. New remote actions are on hold.')
		expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*><summary[^>]*>Technical details<\/summary>/)
		expect(html).toContain('A dispatched child-open action lost its owner.')
		expect(html).toContain('Action · open-child')
		expect(html).toContain('Effect · effect-1')
		expect(html).toContain('I checked — Conductor is stable')
		expect(html).toContain('Cancelled')
	})

	test('shows a blocking Workflow warning even when no run can be projected', () => {
		const html = renderToStaticMarkup(
			<WorkflowWarningBanner warning="The orchestration database uses an unsupported future schema." />
		)
		expect(html).toContain('Workflow is unavailable')
		expect(html).toContain('unsupported future schema')
	})

	test.each([0, 1])('keeps both native subtabs visible with only child %s selected', selectedIndex => {
		const tabs = [
			{
				key: 'tool-call-1',
				label: 'Inspect parser',
				model: '5.6 Sol',
				agentType: 'codex',
				selected: selectedIndex === 0,
				onSelect: vi.fn()
			},
			{
				key: 'tool-call-2',
				label: 'Inspect rendering',
				model: '5.6 Terra',
				agentType: 'codex',
				selected: selectedIndex === 1,
				onSelect: vi.fn()
			}
		]
		const html = renderToStaticMarkup(<AgentSubtabStrip label="Subagents" tabs={tabs} />)

		expect(html).toContain('aria-label="Subagents"')
		expect(html).toContain('aria-current="page"')
		expect(html).toContain('Inspect parser')
		expect(html).toContain('5.6 Sol')
		expect(html).toContain('Inspect rendering')
		expect(html).toContain('5.6 Terra')
		expect(html.match(/<button/g)).toHaveLength(2)
		const selectedButtons = html.match(/<button\b[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/g) ?? []
		expect(selectedButtons).toHaveLength(1)
		expect(selectedButtons[0]).toContain(tabs[selectedIndex].label)
		expect(selectedButtons[0]).toContain('bg-text text-bg')
		// Provider icons and metadata need contrasting ink on the inverted surface too.
		expect(selectedButtons[0]).not.toContain('color:var(--color-provider-openai)')
		expect(selectedButtons[0]).toContain('text-bg/75')
	})

	test('role identity survives independently of an active job', () => {
		const html = renderToStaticMarkup(<RoleChip name="planning" />)
		expect(html).toContain('planning')
	})

	test('role editor leaves an unavailable model visibly invalid and offers no Plan control', () => {
		const html = renderToStaticMarkup(
			<RoleEditorCard
				name="exploration"
				role={{ model: 'Muse Spark', effort: 'high', fast: false }}
				models={['Fable 5', '5.6 Terra']}
				invalid="Choose an exact model from Conductor’s picker."
				onChange={vi.fn()}
				onRemove={vi.fn()}
				canRemove
			/>
		)
		expect(html).toContain('Muse Spark')
		expect(html).toContain('Choose an exact model')
		expect(html).not.toContain('Plan mode')
	})

	test('role drafts cannot save until the picker catalog has loaded', () => {
		expect(roleDraftCanSave(true, false, undefined, 0)).toBe(false)
		expect(roleDraftCanSave(true, false, [], 0)).toBe(true)
		expect(roleDraftCanSave(true, false, [], 1)).toBe(false)
	})

	test('uses every saved picker label for role editing and validation', () => {
		const currentModels = ['5.6 Sol', 'opencode-go/muse-spark-1.3-contributor']
		const groups = [
			{ agentType: 'claude', models: ['Fable 5'], snapshotAt: 0, updatedAt: 0 },
			{ agentType: 'codex', models: ['Fable 5.1'], snapshotAt: 1, updatedAt: 1 },
			{ agentType: 'codex', models: currentModels, snapshotAt: 2, updatedAt: 2 }
		]

		expect(roleAgentType({ model: 'Fable 5.1' }, groups)).toBe('claude')
		expect(roleAgentType({ model: '5.6 Sol' }, groups)).toBe('codex')
		expect(roleAgentType({ model: 'opencode-go/muse-spark-1.3-contributor' }, groups)).toBe('acp')
		expect(roleModelProblem({ model: 'Fable 5.1' }, groups)).toBeNull()
		expect(roleModelProblem({ model: 'Fable 5' }, groups)).toBeNull()
		expect(roleModelProblem({ model: 'unknown-model' }, groups)).toContain('exact model')
	})

	test('hides unsupported OpenCode controls and drops them when its model is selected', () => {
		const model = 'opencode-go/muse-spark-1.3-contributor'
		const role = { model, effort: 'high' as const, fast: false }
		const html = renderToStaticMarkup(
			<RoleEditorCard
				name="exploration"
				role={role}
				models={[model]}
				agentType="acp"
				onChange={vi.fn()}
				onRemove={vi.fn()}
				canRemove
			/>
		)

		expect(html).not.toContain('Reasoning effort for exploration')
		expect(html).not.toContain('Fast mode for exploration')
		expect(roleModelProblem(role, [{ agentType: 'acp', models: [model], updatedAt: 1 }])).toContain(
			'does not expose a reasoning control'
		)
		expect(roleWithModel(role, model)).toEqual({ model })
	})
})
