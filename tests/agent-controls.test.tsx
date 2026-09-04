import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { AgentControls } from '../web/src/components/AgentControls.tsx'
import { WorkflowModePill } from '../web/src/components/WorkflowModePill.tsx'
import { supportsEffortControl, supportsFastMode, supportsPlanMode } from '../web/src/lib/agent.ts'

function controls(agentType: string | null, model: string | null): string {
	return renderToStaticMarkup(
		<AgentControls
			model={model ?? 'Model'}
			providerModel={model}
			agentType={agentType}
			models={[]}
			fast={false}
			effort="high"
			showEmptyEffort
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

	test.each([
		['cursor', 'composer-2.5'],
		['acp', 'opencode:opencode-go/muse-spark-1.3-contributor']
	])('hides stale effort and Fast values when Conductor renders neither control (%s, %s)', (agentType, model) => {
		expect(supportsEffortControl(agentType, model)).toBe(false)
		expect(supportsFastMode(agentType, model)).toBe(false)
		expect(controls(agentType, model)).not.toContain('aria-label="Reasoning effort')
		expect(controls(agentType, model)).not.toContain('aria-label="Fast mode')
	})

	test.each([
		['claude', 'opus-5-1m'],
		['codex', 'gpt-5.6-sol']
	])('keeps effort and Fast for supported Conductor harnesses (%s, %s)', (agentType, model) => {
		expect(supportsEffortControl(agentType, model)).toBe(true)
		expect(supportsFastMode(agentType, model)).toBe(true)
		expect(controls(agentType, model)).toContain('aria-label="Reasoning effort')
		expect(controls(agentType, model)).toContain('aria-label="Fast mode')
	})

	test('puts Workflow before frozen role settings while leaving generic Plan independent', () => {
		const html = renderToStaticMarkup(
			<AgentControls
				model="5.6 Sol"
				providerModel="5.6 Sol"
				agentType="codex"
				models={['5.6 Sol']}
				fast={false}
				effort="max"
				plan
				planAvailable
				freezeAgent
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
		expect(buttons.find(button => button.includes('Plan mode'))).not.toMatch(/\sdisabled(?:=|\s|>)/)
		expect(html.indexOf('aria-label="Workflow mode')).toBeLessThan(html.indexOf('aria-label="Change model'))
		expect(html.indexOf('aria-label="Workflow mode')).toBeLessThan(html.indexOf('aria-label="Fast mode'))
	})
})
