/**
 * The sidebar's Run badge markup (web/src/components/ui.tsx ▸ RunBadge).
 *
 * The badge carries no text — a screen reader has only its `aria-label`, and the sidebar
 * gates it on `run_active`, so the two facts worth pinning are that a live Run renders a
 * labelled glyph and an inactive one renders nothing at all. A relabel or a dropped
 * label would leave every other test green while the marker went silent.
 *
 * The browser globals are stubbed rather than pulled in with a DOM package, exactly as
 * mention-render.test.tsx does: `ui.tsx` imports the app's store and hooks, which read
 * the URL and localStorage at load, and static markup needs nothing more of a browser.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { RunBadge } = await import('../web/src/components/ui.tsx')

const badgeFor = (runActive: boolean) => renderToStaticMarkup(runActive ? <RunBadge /> : null)

describe('RunBadge', () => {
	it('renders an accessibly labelled play glyph when a Run is active', () => {
		const html = badgeFor(true)
		expect(html).toContain('aria-label="Run active"')
		expect(html).toContain('role="img"')
		expect(html).toContain('<svg')
	})

	it('renders nothing when no Run is active', () => {
		expect(badgeFor(false)).toBe('')
	})
})
