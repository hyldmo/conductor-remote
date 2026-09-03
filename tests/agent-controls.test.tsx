import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { AgentControls } from '../web/src/components/AgentControls.tsx'
import { WorkflowModePill } from '../web/src/components/WorkflowModePill.tsx'
import { supportsPlanMode } from '../web/src/lib/agent.ts'

function controls(agentType: string | null, model: string | null): string {
	return renderToStaticMarkup(
		<AgentControls
			model={model ?? 'Model'}
			providerModel={model}
			agentType={agentType}
			models={[]}
			onModelChange={vi.fn()}
			onFastChange={vi.fn()}
			onEffortChange={vi.fn()}
			onPlanChange={vi.fn()}
		/>
	)
}

describe('agent controls', () => {
	test.each([
		['claude', 'opus-5-1m'],
		[null, 'Opus 5'],
		['anthropic', 'unknown']
	])('shows Plan for a Claude-backed agent (%s, %s)', (agentType, model) => {
		expect(supportsPlanMode(agentType, model)).toBe(true)
		expect(controls(agentType, model)).toContain('aria-label="Plan mode default"')
	})

	test.each([
		['codex', 'gpt-5.6-sol'],
		[null, '5.6 Sol'],
		['cursor', 'composer-2.5'],
		['acp', 'opencode:opencode/x-preview-f-free'],
		[null, null]
	])('hides Plan outside Claude (%s, %s)', (agentType, model) => {
		expect(supportsPlanMode(agentType, model)).toBe(false)
		expect(controls(agentType, model)).not.toContain('aria-label="Plan mode')
	})

	test('puts Workflow before the disabled agent settings and leaves it reversible', () => {
		const html = renderToStaticMarkup(
			<AgentControls
				model="Fable 5.1"
				providerModel="Fable 5.1"
				agentType="claude"
				models={['Fable 5.1']}
				fast={false}
				effort="max"
				disabled
				hidePlan
				beforeModel={<WorkflowModePill active onChange={vi.fn()} />}
				onModelChange={vi.fn()}
				onFastChange={vi.fn()}
				onEffortChange={vi.fn()}
				onPlanChange={vi.fn()}
			/>
		)
		const buttons = html.match(/<button[^>]*>/g) ?? []
		expect(buttons.find(button => button.includes('Change model'))).toContain('disabled')
		expect(buttons.find(button => button.includes('Fast mode'))).toContain('disabled')
		expect(buttons.find(button => button.includes('Reasoning effort'))).toContain('disabled')
		expect(buttons.find(button => button.includes('Workflow mode'))).not.toContain('disabled')
		expect(html).not.toContain('aria-label="Plan mode')
		expect(html.indexOf('aria-label="Workflow mode')).toBeLessThan(html.indexOf('aria-label="Change model'))
		expect(html.indexOf('aria-label="Workflow mode')).toBeLessThan(html.indexOf('aria-label="Fast mode'))
	})
})
