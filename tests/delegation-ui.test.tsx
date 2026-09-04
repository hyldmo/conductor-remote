import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { DelegationProjection, Session } from '../src/wire.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const [
	{ DelegationPipeline },
	{ QueueBubble },
	{ RoleChip, RoleEditorCard, roleAgentType, roleDraftCanSave, roleModelProblem }
] = await Promise.all([
	import('../web/src/components/DelegationPipeline.tsx'),
	import('../web/src/components/QueueBubble.tsx'),
	import('../web/src/components/RolesSettings.tsx')
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
		expect(html).toContain('bg-surface-2')
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

	test('takes a role provider from the model after deduplicating whole-picker caches', () => {
		const models = ['Fable 5.1', '5.6 Sol', 'opencode-go/muse-spark-1.3-contributor']
		const groups = [
			{ agentType: 'claude', models, updatedAt: 1 },
			{ agentType: 'codex', models, updatedAt: 2 }
		]

		expect(roleAgentType({ model: 'Fable 5.1' }, groups)).toBe('claude')
		expect(roleAgentType({ model: '5.6 Sol' }, groups)).toBe('codex')
		expect(roleAgentType({ model: 'opencode-go/muse-spark-1.3-contributor' }, groups)).toBe('acp')
		expect(roleModelProblem({ model: 'Fable 5.1' }, groups)).toBeNull()
		expect(roleModelProblem({ model: 'unknown-model' }, groups)).toContain('exact model')
	})
})
