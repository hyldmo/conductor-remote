import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentImportScanResponse, AgentsConfig, ImportAgentsResult } from '../../src/wire.ts'
import { importAgentDefinitions, mergeImportedAgents } from '../../web/src/lib/agent-import.ts'
import { roleModelProblem } from '../../web/src/lib/role-editor.ts'

vi.stubGlobal('location', { hash: '', pathname: '/', search: '' })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('history', { replaceState: () => {} })

const { AgentEditorCard } = await import('../../web/src/components/agents/AgentEditorCard.tsx')
const { AgentImportChoices, AgentsImport } = await import('../../web/src/components/agents/AgentsImport.tsx')

const clients: QueryClient[] = []
function queryClient() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
	clients.push(client)
	return client
}
beforeEach(() =>
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.reject(new Error('Unexpected request')))
	)
)
afterEach(() => {
	for (const client of clients.splice(0)) client.clear()
	vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

const scan: AgentImportScanResponse = {
	candidates: [
		{ name: 'helper', model: 'haiku', description: 'Fast file searches.', hasBody: true, collision: true },
		{ name: 'new-agent', model: 'sonnet', description: 'Imported instructions.', hasBody: false, collision: false }
	],
	skipped: [{ name: 'broken', reason: 'description must be a flat scalar' }],
	truncated: true,
	limit: 64
}
const before: AgentsConfig = {
	version: 1,
	agents: [
		{
			name: 'helper',
			model: '5.6 Sol',
			description: 'Original description.',
			preamble: 'Original body.',
			effort: 'high'
		},
		{ name: 'removed', model: '5.6 Sol' }
	]
}
function receipt(): ImportAgentsResult {
	return {
		results: [
			{ name: 'helper', ok: true, overwritten: true },
			{ name: 'new-agent', ok: true, overwritten: false },
			{ name: 'broken', ok: false, error: 'description must be a flat scalar' }
		],
		config: {
			version: 1,
			agents: [
				{
					name: 'helper',
					model: 'haiku',
					description: 'Imported description.',
					preamble: 'Imported body.',
					effort: 'low'
				},
				before.agents[1],
				{ name: 'new-agent', model: 'sonnet', preamble: 'New body.' }
			],
			issues: [
				{ agent: 'new-agent', error: { code: 'model_missing', message: 'Choose a picker model.', retryable: false } }
			]
		}
	}
}

describe('inline agent import flow', () => {
	test('keeps discovery closed until opened and renders previews, skipped reasons and explicit overwrite controls', () => {
		const closed = renderToStaticMarkup(
			<QueryClientProvider client={queryClient()}>
				<AgentsImport onImport={vi.fn()} />
			</QueryClientProvider>
		)
		expect(closed).toContain('aria-expanded="false"')
		expect(closed).toContain('Import from ~/.claude/agents')
		expect(closed).not.toContain('Import agent definitions')
		expect(fetch).not.toHaveBeenCalled()
		const renderChoices = (overwrite: boolean) =>
			renderToStaticMarkup(
				<AgentImportChoices
					scan={scan}
					selected={['new-agent']}
					overwrite={overwrite}
					onSelect={vi.fn()}
					onOverwrite={vi.fn()}
				/>
			)
		const html = renderChoices(false)
		expect(html).toContain('Fast file searches.')
		expect(html).toContain('haiku')
		expect(html).toContain('Already exists')
		expect(html).toContain('Has instructions')
		expect(html).toContain('No instructions')
		expect(html).toContain('broken: skipped — description must be a flat scalar')
		expect(html).toContain('Only the first 64 Markdown files were scanned.')
		expect(html.match(/<input[^>]*aria-label="Import helper"[^>]*>/)?.[0]).toContain('disabled')
		expect(renderChoices(true).match(/<input[^>]*aria-label="Import helper"[^>]*>/)?.[0]).not.toContain('disabled')
		expect(html.match(/<input[^>]*aria-label="Import new-agent"[^>]*>/)?.[0]).toContain('checked')
	})

	test('POSTs selected names, refreshes readers, and merges imported cards without losing dirty drafts', async () => {
		const result = receipt()
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)))
		const client = queryClient()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const imported = await importAgentDefinitions(client, { names: ['helper', 'new-agent', 'broken'], overwrite: true })
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/agents/import')
		const request = vi.mocked(fetch).mock.calls[0][1]!
		expect(request.method).toBe('POST')
		expect(JSON.parse(request.body as string)).toEqual({ names: ['helper', 'new-agent', 'broken'], overwrite: true })
		expect(client.getQueryData(['agents'])).toEqual(result.config)
		expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
			['agents'],
			['routing'],
			['roles'],
			['auto-model-config'],
			['agent-import-candidates']
		])
		const draft: AgentsConfig = {
			version: 1,
			agents: [
				{ ...before.agents[0], description: 'Unsaved description.', preamble: 'Unsaved body.', effort: undefined },
				{ name: 'local-only', model: '5.6 Sol', preamble: 'Unsaved new agent.' }
			]
		}
		const merged = mergeImportedAgents(draft, before, imported)
		expect(merged.agents.map(agent => agent.name)).toEqual(['helper', 'local-only', 'new-agent'])
		expect(merged.agents[0]).toEqual({
			name: 'helper',
			model: 'haiku',
			description: 'Unsaved description.',
			preamble: 'Unsaved body.',
			effort: undefined
		})
		expect(merged.agents[1]).toEqual(draft.agents[1])
		expect(draft.agents).toHaveLength(2)
		const agent = merged.agents[2]
		const groups = [{ agentType: 'codex', models: ['5.6 Sol'], updatedAt: 1 }]
		const card = renderToStaticMarkup(
			<AgentEditorCard
				agent={agent}
				models={['5.6 Sol']}
				agentType={null}
				invalid={roleModelProblem(agent, groups) ?? undefined}
				canRemove
				onChange={vi.fn()}
				onRemove={vi.fn()}
			/>
		)
		expect(card).toContain('new-agent')
		expect(card).toContain('Choose an exact model from Conductor’s current picker catalog.')
	})

	test('retains local additions with the same imported name and intentional local removals on overwrite', () => {
		const result = receipt()
		result.results.push({ name: 'removed', ok: true, overwritten: true })
		const local = { name: 'new-agent', model: '5.6 Sol', preamble: 'Local new definition.' }
		const draft: AgentsConfig = { version: 1, agents: [before.agents[0], local] }
		const merged = mergeImportedAgents(draft, before, result)
		expect(merged.agents).toEqual([result.config.agents[0], local])
		const refused = { ...result, results: [{ name: 'helper', ok: false as const, error: 'Collision' }] }
		expect(mergeImportedAgents(draft, before, refused)).toEqual(draft)
	})
})
