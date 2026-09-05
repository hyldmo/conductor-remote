import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { Workspace } from '../../web/src/lib/types.ts'

// ui.tsx reaches the app store and API module on import; static rendering needs only
// their boot-time browser globals, not a DOM.
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { PromptStatusDot, StatusDot } = await import('../../web/src/components/ui.tsx')

const workspace = (session_status: string | null): Workspace =>
	({ state: 'ready', session_status, pr_status: null }) as Workspace

describe('prompt status ring', () => {
	test('spins while the send is queued', () => {
		const html = renderToStaticMarkup(<PromptStatusDot state="sending" />)
		expect(html).toContain('data-prompt-state="sending"')
		expect(html).toContain('dot-spinner')
		expect(html).toContain('aria-label="Prompt pending"')
	})

	test('keeps the ring and puts an X in it when the send fails', () => {
		const html = renderToStaticMarkup(<PromptStatusDot state="failed" />)
		expect(html).toContain('data-prompt-state="failed"')
		expect(html).toContain('dot-error')
		expect(html).toContain('aria-label="Send failed"')
		expect(html).toContain('lucide-x')
		expect(html).not.toContain('dot-spinner')
	})

	test('overrides the workspace state from enqueue through failure', () => {
		const queued = renderToStaticMarkup(<StatusDot w={workspace('idle')} promptState="sending" />)
		expect(queued).toContain('data-prompt-state="sending"')

		// The undismissed send error is the actionable state, even if an earlier turn
		// is still working underneath it.
		const failed = renderToStaticMarkup(<StatusDot w={workspace('working')} promptState="failed" />)
		expect(failed).toContain('data-prompt-state="failed"')
		expect(failed).not.toContain('dot-spinner')
	})
})
