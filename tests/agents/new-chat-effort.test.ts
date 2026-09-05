import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { EffortBars } from '../../web/src/components/agents/AgentIcons.tsx'
import { defaultEffortForModel, nextEffortOverride, providerForAgent } from '../../web/src/lib/agent.ts'

describe('new-chat effort', () => {
	const defaults = { claude: 'xhigh', codex: 'max' }

	test("uses the selected model provider's configured default", () => {
		expect(defaultEffortForModel('5.6 Sol', defaults)).toBe('max')
		expect(defaultEffortForModel('Opus 5', defaults)).toBe('xhigh')
		expect(defaultEffortForModel('cursor/composer', defaults)).toBeUndefined()
	})

	test('draws the inherited effort on the meter', () => {
		const effort = defaultEffortForModel('5.6 Sol', defaults)
		const html = renderToStaticMarkup(createElement(EffortBars, { effort: effort ?? '' }))
		expect(html.match(/opacity-100/g)).toHaveLength(5)
		expect(html.match(/opacity-20/g)).toHaveLength(1)
	})

	test('ignores unknown settings instead of drawing an invalid meter', () => {
		expect(defaultEffortForModel('5.6 Sol', { ...defaults, codex: 'invented' })).toBeUndefined()
	})

	test('cycles an override back to the inherited value without staging it', () => {
		expect(nextEffortOverride('max', 'max')).toBe('ultracode')
		expect(nextEffortOverride('high', 'xhigh')).toBeUndefined()
		expect(nextEffortOverride('ultracode', undefined)).toBeUndefined()
	})

	test('keeps session harness fallback for model labels it cannot identify', () => {
		expect(providerForAgent('codex', 'unknown')).toBe('openai')
		expect(providerForAgent('claude', 'unknown')).toBe('claude')
	})
})
