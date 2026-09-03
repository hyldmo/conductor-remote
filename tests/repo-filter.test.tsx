import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { toggleRepoFilter, workspaceFilterSummary } from '../web/src/lib/workspace-filter.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { RepoOptions } = await import('../web/src/components/RepoFilter.tsx')
const repos = ['alpha', 'bravo', 'charlie'].map(name => ({ name, icon: null }))

describe('repo filter bulk selection', () => {
	test('keeps one-tap narrowing and normalises the final repo back to showing all', () => {
		expect(toggleRepoFilter(['alpha', 'bravo', 'charlie'], [], 'alpha')).toEqual(['alpha'])
		expect(toggleRepoFilter(['alpha', 'bravo', 'charlie'], ['alpha', 'bravo'], 'charlie')).toEqual([])
	})

	test('names the unrestricted state without adding a contradictory master checkbox', () => {
		const html = renderToStaticMarkup(<RepoOptions repos={repos} selected={[]} onChange={vi.fn()} />)

		expect(html).toContain('All 3 repos')
		expect(html).toContain('Showing all')
		expect(html.match(/type="checkbox"/g)).toHaveLength(repos.length)
		expect(html).not.toContain('Show all repos')
	})

	test('keeps a full-width show-all action above a narrowed selection', () => {
		const html = renderToStaticMarkup(<RepoOptions repos={repos} selected={['alpha']} onChange={vi.fn()} />)

		expect(html).toContain('1 of 3 repos')
		expect(html).toContain('aria-label="Show all repos"')
		expect(html).toContain('sticky top-0')
	})
})

describe('workspace filter summary', () => {
	test('moves the useful workspace counts into the filter without repeating repo scope', () => {
		expect(workspaceFilterSummary({ total: 58, shown: 31, hidden: 13, repoFiltered: true })).toBe(
			'31 of 58 · 13 hidden'
		)
		expect(workspaceFilterSummary({ total: 58, shown: 58, hidden: 0, repoFiltered: false })).toBe('58 active')
	})
})
