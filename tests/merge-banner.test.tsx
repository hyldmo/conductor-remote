import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Workspace } from '../web/src/lib/types.ts'

/**
 * What the bar above the diff offers for each PR state — the part of it that fails
 * *silently*. `pickAction` returns null for anything it doesn't name, so a state added
 * to `PrStatus` without a case here draws no bar at all: no label, and no route to the
 * PR, which is exactly how a red-CI branch came to show nothing on the phone.
 *
 * The globals are stubbed rather than pulled in with a DOM package, as in the mention
 * render test: the bar imports the API client, which reads the URL and the token store
 * on load. Static markup, so nothing here needs a document.
 */
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MergeBanner } = await import('../web/src/components/MergeBanner.tsx')

function render(pr_status: Workspace['pr_status']): string {
	const ws = { id: 'w1', pr_status, pr_number: 12, pr_url: 'https://github.com/o/r/pull/12' } as Workspace
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<MergeBanner ws={ws} local={{ dirty: false, unpushed: false }} />
		</QueryClientProvider>
	)
}

function bannerFor(id: string) {
	const ws = { id, pr_status: 'merged', pr_number: 12, pr_url: 'https://github.com/o/r/pull/12' } as Workspace
	return MergeBanner({ ws, local: { dirty: false, unpushed: false } })
}

describe('the merge bar', () => {
	it('offers the merge on a green PR', () => {
		const html = render('mergeable')
		expect(html).toContain('Ready to merge')
		expect(html).toContain('>Merge<')
		expect(html).not.toContain('>Continue<')
	})

	it('says CI is running, and still lets the merge through', () => {
		const html = render('checks_pending')
		expect(html).toContain('Checks running')
		expect(html).toContain('>Merge<')
	})

	it('keeps the bar and the PR link when CI failed', () => {
		const html = render('checks_failed')
		expect(html).toContain('Checks failed')
		expect(html).toContain('#12')
		expect(html).toContain('https://github.com/o/r/pull/12')
		// No merge, and no Resolve either: a failed check is not a conflict.
		expect(html).not.toContain('<button')
	})

	it('offers the same-workspace continuation after merge', () => {
		const html = render('merged')
		expect(html).toContain('Merged')
		expect(html).toContain('>Continue<')
		expect(html).toContain('Continue on a new branch with the same chats')
		expect(html).toContain('https://github.com/o/r/pull/12')
	})

	it('drops local banner state when the sidebar switches workspaces', () => {
		// React remounts a child when its key changes. The receipt, error, busy and
		// confirmation state all live in this keyed child, not in the stable wrapper.
		expect(bannerFor('w1').key).toBe('w1')
		expect(bannerFor('w2').key).toBe('w2')
	})

	it('draws nothing when there is no PR and nothing to push', () => {
		expect(render(null)).toBe('')
	})
})
