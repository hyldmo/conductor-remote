import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import {
	ALL_REPOS,
	clearRepoFilter,
	parseRepoSelection,
	selectedRepos,
	toggleRepoFilter,
	workspaceFilterSummary
} from '../../web/src/lib/workspace-filter.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { RepoOptions } = await import('../../web/src/components/workspaces/RepoFilter.tsx')
const repos = ['alpha', 'bravo', 'charlie'].map(name => ({ name, icon: null }))

describe('repo filter bulk selection', () => {
	test('deselects one repo from all in one tap', () => {
		expect(toggleRepoFilter(['alpha', 'bravo', 'charlie'], ALL_REPOS, 'alpha')).toEqual({
			mode: 'selected',
			repos: ['bravo', 'charlie']
		})
	})

	test('clears all before selecting only one repo', () => {
		const cleared = clearRepoFilter()
		expect(selectedRepos(cleared)).toEqual([])
		expect(toggleRepoFilter(['alpha', 'bravo', 'charlie'], cleared, 'alpha')).toEqual({
			mode: 'selected',
			repos: ['alpha']
		})
	})

	test('normalises an exact full set back to all', () => {
		expect(
			toggleRepoFilter(['alpha', 'bravo', 'charlie'], { mode: 'selected', repos: ['alpha', 'bravo'] }, 'charlie')
		).toEqual(ALL_REPOS)
	})

	test('migrates the old empty-is-all shape without losing the new cleared state', () => {
		expect(parseRepoSelection(undefined, [])).toEqual(ALL_REPOS)
		expect(parseRepoSelection(undefined, ['alpha'])).toEqual({ mode: 'selected', repos: ['alpha'] })
		expect(parseRepoSelection({ mode: 'selected', repos: [] })).toEqual({ mode: 'selected', repos: [] })
	})

	test('renders one checked master and checked repo rows when all are selected', () => {
		const html = renderToStaticMarkup(<RepoOptions repos={repos} selected={ALL_REPOS} onChange={vi.fn()} />)

		expect(html).toContain('All repos')
		expect(html.match(/type="checkbox"/g)).toHaveLength(repos.length + 1)
		expect(html.match(/checked=""/g)).toHaveLength(repos.length + 1)
	})

	test('renders a mixed master checkbox for a partial selection', () => {
		const html = renderToStaticMarkup(
			<RepoOptions repos={repos} selected={{ mode: 'selected', repos: ['alpha'] }} onChange={vi.fn()} />
		)

		expect(html).toContain('aria-checked="mixed"')
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
