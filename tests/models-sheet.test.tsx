import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { ProviderPlanUsage } from '../src/plan-usage.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { ProviderCard } = await import('../web/src/components/PlanUsageSheet.tsx')

function usage(overrides: Partial<ProviderPlanUsage>): ProviderPlanUsage {
	return {
		provider: 'codex',
		label: 'Codex',
		status: 'available',
		plan: 'pro',
		buckets: [],
		...overrides
	}
}

describe('Models provider cards', () => {
	test('shows a new-chat default effort control for Codex and Claude', () => {
		const html = renderToStaticMarkup(
			<ProviderCard usage={usage({})} defaultEffort="xhigh" onDefaultEffortChange={vi.fn()} />
		)
		expect(html).toContain('Codex default effort')
		expect(html).toContain('Default effort')
		expect(html).toContain('New chats')
		expect(html).toContain('Extra high')
	})

	test('renders Cursor and OpenCode as clean provider cards without unsupported-usage copy', () => {
		for (const provider of [
			usage({
				provider: 'cursor',
				label: 'Cursor Agent',
				status: 'unavailable',
				message: 'Cursor Agent does not expose plan limits through its CLI.'
			}),
			usage({
				provider: 'opencode',
				label: 'OpenCode',
				status: 'unavailable',
				message: 'OpenCode reports local token and cost totals, not provider plan limits.'
			})
		]) {
			const html = renderToStaticMarkup(<ProviderCard usage={provider} />)
			expect(html).toContain(provider.label)
			expect(html).not.toContain('does not expose')
			expect(html).not.toContain('local token and cost totals')
			expect(html).not.toContain('Default effort')
		}
	})
})
