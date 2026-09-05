import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ModelPicker } from '../../web/src/components/agents/ModelPicker.tsx'

describe('model picker default', () => {
	test('Auto comes before concrete models and offers its own settings', () => {
		const html = renderToStaticMarkup(
			<ModelPicker
				open
				models={['5.6 Luna']}
				autoSelected
				onSelectAuto={vi.fn()}
				onAutoSettings={vi.fn()}
				onSelect={vi.fn()}
			/>
		)
		expect(html.indexOf('>Auto</span>')).toBeLessThan(html.indexOf('>5.6 Luna</span>'))
		expect(html).toContain('aria-label="Auto model settings"')
		const ordinary = renderToStaticMarkup(<ModelPicker open models={['5.6 Luna']} onSelect={vi.fn()} />)
		expect(ordinary).not.toContain('>Auto</span>')
	})
	test('renders a separate starred action without nesting it in the select button', () => {
		const html = renderToStaticMarkup(
			<ModelPicker
				open
				value="5.6 Terra"
				models={['5.6 Sol', '5.6 Terra']}
				defaultModel="5.6 Sol"
				onSelect={vi.fn()}
				onSetDefault={vi.fn()}
			/>
		)
		expect(html).toContain('5.6 Sol is the default model')
		expect(html).toContain('Set 5.6 Terra as default and select')
	})

	test('uses a wider menu and shortens OpenCode Go labels without changing their values', () => {
		const html = renderToStaticMarkup(
			<ModelPicker open models={['opencode-go/grok-4.6']} onSelect={vi.fn()} onSetDefault={vi.fn()} />
		)
		expect(html).toContain('max-h-64 w-64')
		expect(html).toContain('>go/grok-4.6</span>')
		expect(html).toContain('Set opencode-go/grok-4.6 as default and select')
	})
})
