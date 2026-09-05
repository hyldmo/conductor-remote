import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentDefinition, AgentsResponse, CachedModelGroup, RoutingConfig } from '../../src/wire.ts'
import {
	agentRoutingLock,
	copyAgents,
	isRouterModel,
	newAgentProblem,
	normalizeAgentName,
	routerModelProblem,
	routingDraftProblems,
	saveAgentsSettings
} from '../../web/src/lib/agents-settings.ts'

// Keep the existing server-rendered component-test style: no Mac UI, relay or browser process.
vi.mock('react-dom', async original => ({
	...(await original<typeof import('react-dom')>()),
	createPortal: (children: ReactNode) => children
}))
vi.stubGlobal('document', { body: {} })
vi.stubGlobal('location', { hash: '', pathname: '/', search: '' })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('history', { replaceState: () => {} })

const { AgentsSettings } = await import('../../web/src/components/agents/AgentsSettings.tsx')
const clients: QueryClient[] = []
const groups: CachedModelGroup[] = [
	{
		agentType: 'codex',
		models: ['5.6 Sol', '5.6 Luna', 'Fable 5.1', 'opencode-go/muse-spark-1.3-contributor'],
		updatedAt: 1
	}
]

function roster(): AgentsResponse {
	return {
		version: 1,
		agents: [
			{
				name: 'exploration',
				model: '5.6 Sol',
				description: 'Read-only code searches.',
				preamble: 'Inspect the repository.'
			},
			{ name: 'implementation', model: '5.6 Sol', description: '' },
			{ name: 'manual', model: 'Fable 5.1', description: 'Manual delegation only.', routing: false }
		],
		issues: []
	}
}

function routing(): RoutingConfig {
	return {
		version: 1,
		defaultAuto: false,
		router: { model: '5.6 Luna', effort: 'low' },
		fallback: 'exploration',
		rules: 'Choose the suitable agent.',
		timeoutMs: 15000
	}
}

function queryClient(agents = roster(), config = routing(), issues: string[] = []) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
	client.setQueryData(['agents'], agents)
	client.setQueryData(['routing'], { config, issues })
	client.setQueryData(['model-catalog'], { groups })
	client.setQueryData(['roles'], { cached: true })
	client.setQueryData(['auto-model-config'], { cached: true })
	clients.push(client)
	return client
}

function renderSheet(client = queryClient(), initial: 'agents' | 'routing' = 'agents') {
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<AgentsSettings initial={initial} onClose={vi.fn()} />
		</QueryClientProvider>
	)
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.reject(new Error('Unexpected network request')))
	)
})
afterEach(() => {
	for (const client of clients.splice(0)) client.clear()
	vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

describe('unified Agents sheet', () => {
	test.each([
		'',
		'   '
	])('omits Auto participation and fallback eligibility for an empty description (%j)', description => {
		const agents = roster()
		agents.agents[1].description = description
		const html = renderSheet(queryClient(agents))
		expect(html).toContain('Description — Auto routing reads this to pick')
		expect(html).toContain('implementation')
		expect(html).not.toContain('Use implementation in Auto routing')
		expect(html).not.toContain('<option value="implementation"')
		expect(html).not.toContain('<option value="manual"')
		expect(html).toContain('value="exploration"')
		expect(html).toContain('Use manual in Auto routing')
	})

	test('keeps the fallback visible but disables its remove and un-route controls', () => {
		const html = renderSheet()
		const remove = html.match(/<button[^>]*aria-label="Remove exploration agent"[^>]*>/)?.[0]
		const toggle = html.match(/<input[^>]*aria-label="Use exploration in Auto routing"[^>]*>/)?.[0]
		expect(remove).toMatch(/\sdisabled(?:=|\s|>)/)
		expect(toggle).toMatch(/\sdisabled(?:=|\s|>)/)
		expect(html).toContain('Choose and save a different fallback')
		expect(html.match(/<button[^>]*aria-label="Remove implementation agent"[^>]*>/)?.[0]).not.toMatch(
			/\sdisabled(?:=|\s|>)/
		)
	})

	test('renders the routing deep link in the same single-scroll sheet with one Save', () => {
		const html = renderSheet(queryClient(), 'routing')
		expect(html).toContain('aria-label="Agents settings"')
		expect(html).toContain('Beta')
		expect(html).toContain('<section aria-label="Auto routing"')
		expect(html).toContain('Use Auto by default for new workspaces and chats')
		expect(html.indexOf('Remove exploration agent')).toBeLessThan(html.indexOf('aria-label="Auto routing"'))
		expect(html.match(/>Save<\/button>/g)).toHaveLength(1)
		expect(html).not.toContain('role="tab"')
		expect(html).not.toContain('Remove Router')
		expect(html).not.toContain('Router role preamble')
		expect(html).toContain('Applied to delegated chats only.')
		expect(html).toContain('rows="8" maxLength="12000"')
		expect(html).toContain('min="2" max="30"')
		expect(fetch).not.toHaveBeenCalled()
	})

	test('shows preserved-file warnings, routing issues, and invalid picker models', () => {
		const agents = roster()
		agents.warning = 'Could not read broken.md: missing model'
		agents.agents[1].model = 'haiku'
		const html = renderSheet(queryClient(agents, routing(), ['Repair the routing fallback.']))
		expect(html).toContain('Could not read broken.md: missing model')
		expect(html).toContain('Repair the agent files before saving')
		expect(html).toContain('Repair the routing fallback.')
		expect(html).toContain('Choose an exact model from Conductor’s current picker catalog.')
		expect(html.match(/<button[^>]*disabled=""[^>]*>/g)?.length).toBeGreaterThan(0)
	})

	test('does not let the last remaining agent be removed', () => {
		const agents = roster()
		agents.agents = [agents.agents[1]]
		const html = renderSheet(queryClient(agents))
		expect(html.match(/<button[^>]*aria-label="Remove implementation agent"[^>]*>/)?.[0]).toMatch(
			/\sdisabled(?:=|\s|>)/
		)
		expect(html).toContain('Keep at least one agent.')
		expect(html).toContain('Choose a fallback agent with a description and Auto routing enabled.')
	})
})

describe('Agents draft validation', () => {
	test('normalizes new names, checks uniqueness and caps the roster at 32', () => {
		expect(normalizeAgentName('  Code Review  ')).toBe('code-review')
		expect(newAgentProblem('exploration', roster().agents)).toContain('already exists')
		for (const name of ['9agent', 'Uppercase', 'a'.repeat(65), '../agent'])
			expect(newAgentProblem(name, [])).toContain('Start with a letter')
		expect(newAgentProblem('code-review_2', [])).toBeNull()
		expect(
			newAgentProblem(
				'agent',
				Array.from({ length: 32 }, (_, i) => ({ name: `agent-${i}`, model: '5.6 Sol' }))
			)
		).toContain('32')
	})

	test('protects the saved fallback until a changed fallback has actually saved', () => {
		expect(agentRoutingLock('exploration', 'new-agent', 'exploration')).toContain('Save the new fallback')
		expect(agentRoutingLock('new-agent', 'new-agent', 'exploration')).toContain('Choose and save a different fallback')
		expect(agentRoutingLock('exploration', 'new-agent', 'new-agent')).toBeUndefined()
	})

	test('validates routability, selection bounds, rules size, and the router-specific limits', () => {
		const agents = roster().agents
		for (const fallback of ['missing', 'implementation', 'manual'])
			expect(routingDraftProblems({ ...routing(), fallback }, agents)).toContain(
				'Choose a fallback agent with a description and Auto routing enabled.'
			)
		for (const timeoutMs of [0, 1000, 30001, NaN, 2345.5])
			expect(routingDraftProblems({ ...routing(), timeoutMs }, agents)).toContain(
				'Maximum selection time must be between 2 and 30 seconds.'
			)
		for (const timeoutMs of [2000, 2345, 30000])
			expect(routingDraftProblems({ ...routing(), timeoutMs }, agents)).toEqual([])
		expect(routingDraftProblems({ ...routing(), rules: 'a'.repeat(12001) }, agents)).toContain(
			'Keep routing rules within 12,000 characters.'
		)
		expect(routerModelProblem({ model: 'Fable 5.1' }, groups)).toContain('router supports Codex')
		expect(routerModelProblem({ model: '5.6 Luna', effort: 'ultracode' }, groups)).toContain('up to max')
		expect(routerModelProblem({ model: '5.6 Luna', effort: 'low' }, groups)).toBeNull()
		expect(isRouterModel('opencode/muse-spark-1.3-contributor-free')).toBe(true)
		expect(isRouterModel('opencode-go/muse-spark-1.3-contributor')).toBe(true)
		expect(isRouterModel('Muse Spark')).toBe(false)
	})
})

describe('Agents sheet saving', () => {
	test('PATCHes agents before routing, sends only config fields, and invalidates canonical and legacy readers', async () => {
		const client = queryClient()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		let acceptAgents!: (response: Response) => void
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<Response>(resolve => {
						acceptAgents = resolve
					})
			)
			.mockResolvedValueOnce(Response.json({ config: routing(), issues: [] }))
		vi.stubGlobal('fetch', fetchMock)
		const save = saveAgentsSettings(client, roster(), routing())
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0][0]).toBe('/api/agents')
		acceptAgents(Response.json({ ok: true, config: roster() }))
		const result = await save
		expect(result).toEqual({ agents: roster(), routing: { config: routing(), issues: [] } })
		expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/agents', '/api/routing'])
		for (const [, request] of fetchMock.mock.calls) expect(request.method).toBe('PATCH')
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(copyAgents(roster()))
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(routing())
		expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
			['agents'],
			['routing'],
			['roles'],
			['auto-model-config']
		])
		expect(client.getQueryData(['agents'])).toEqual(roster())
		expect(client.getQueryData(['routing'])).toEqual({ config: routing(), issues: [] })
	})

	test.each(['agents', 'routing'] as const)('only PATCHes the dirty %s half', async half => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				Response.json(half === 'agents' ? { ok: true, config: roster() } : { config: routing(), issues: [] })
			)
		vi.stubGlobal('fetch', fetchMock)
		const result = await saveAgentsSettings(
			queryClient(),
			half === 'agents' ? roster() : undefined,
			half === 'routing' ? routing() : undefined
		)
		expect(result.error).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0][0]).toBe(`/api/${half}`)
	})

	test('does not PATCH an unchanged sheet', async () => {
		expect(await saveAgentsSettings(queryClient())).toEqual({})
		expect(fetch).not.toHaveBeenCalled()
	})

	test('retains 409 agent issues and stops before routing when agents are rejected', async () => {
		const issue = {
			agent: 'exploration',
			error: { code: 'model_missing', message: 'The saved catalog changed.', retryable: false }
		}
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(Response.json({ ok: false, error: issue.error, issues: [issue] }, { status: 409 }))
		)
		const client = queryClient()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const result = await saveAgentsSettings(client, roster(), routing())
		expect(result).toEqual({ error: issue.error.message, agentIssues: [issue] })
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(invalidate).not.toHaveBeenCalled()
	})

	test('keeps a successful agents receipt and the unsaved routing half for a routing-only retry', async () => {
		const client = queryClient()
		const issue = 'The fallback model is unavailable.'
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ok: true, config: roster() }))
			.mockResolvedValueOnce(Response.json({ error: issue, issues: [issue] }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ config: routing(), issues: [] }))
		vi.stubGlobal('fetch', fetchMock)
		const result = await saveAgentsSettings(client, roster(), routing())
		expect(result.agents).toEqual(roster())
		expect(result.routing).toBeUndefined()
		expect(result.error).toBe(`Agents saved. Auto routing was not saved: ${issue}`)
		expect(result.routingIssues).toEqual([issue])
		expect(client.getQueryState(['roles'])?.isInvalidated).toBe(true)
		expect(client.getQueryState(['auto-model-config'])?.isInvalidated).toBe(true)
		await saveAgentsSettings(client, undefined, routing())
		expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/agents', '/api/routing', '/api/routing'])
	})

	test('preserves instruction bodies and clears them only when the draft removes them', async () => {
		const agents = roster()
		const body = '# Instructions\n\nKeep this text.\n'
		agents.agents[0].preamble = body
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true, config: agents })))
		vi.stubGlobal('fetch', fetchMock)
		await saveAgentsSettings(queryClient(), agents)
		const first = JSON.parse(fetchMock.mock.calls[0][1].body).agents[0] as AgentDefinition
		expect(first.preamble).toBe(body)
		delete agents.agents[0].preamble
		await saveAgentsSettings(queryClient(), agents)
		expect(JSON.parse(fetchMock.mock.calls[1][1].body).agents[0]).not.toHaveProperty('preamble')
	})
})
