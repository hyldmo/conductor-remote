import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Config } from '../../src/config.ts'
import { SendOnce } from '../../src/delivery/sendonce.ts'
import { createRelayServer } from '../../src/http/router.ts'
import { createMcpServices } from '../../src/http/services/mcp.ts'
import { createResponsesServices } from '../../src/http/services/responses.ts'
import { createWorkflowStateServices } from '../../src/http/services/workflow-state.ts'
import type { RelayServices } from '../../src/http/services.ts'
import { WorkflowRequestError } from '../../src/orchestration/workflow/http.ts'
import { MAC_LOCKED } from '../../src/shared.ts'
import { UiBusyError, uiQueueDepth, uiTurn } from '../../src/writes/ui-lock.ts'

const servers: Server[] = []
const temporaryDirectories: string[] = []
const token = 'router-test-token'

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		servers.splice(0).map(server => {
			server.closeAllConnections()
			return new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		})
	)
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Exercise the real HTTP boundary without constructing databases, queues or GUI services. */
function fixture() {
	const cfg: Config = {
		token,
		dbPath: '/unused/conductor.db',
		workspacesRoot: '/unused/workspaces',
		publicDir: '/unused/public',
		port: 0,
		host: '127.0.0.1',
		writeStrategy: 'applescript',
		preventScreenLock: false
	}
	const responses = createResponsesServices({ cfg })
	const workspace = { id: 'workspace-1', active_session_id: 'chat-1', branch: 'test-branch', worktree: null }
	const reads = {
		listRepos: vi.fn(() => [{ id: 'repo-1', name: 'example', root_path: '/unused/repo' }]),
		getWorkspace: vi.fn((id: string) => (id === workspace.id ? workspace : null)),
		listWorkspaces: vi.fn(() => [workspace]),
		listSessions: vi.fn(() => [{ id: 'chat-1', model: 'Fable 5' }]),
		getMessages: vi.fn((_sessionId: string, _after: number): unknown => ({ entries: [], queued: [], cursor: 0 })),
		resolveRepoIcon: vi.fn((_repo: string): { path: string; contentType: string } | null => null),
		toolImage: vi.fn((_reference: string) => ({
			data: Buffer.from('image bytes').toString('base64'),
			mediaType: 'image/png'
		}))
	}
	const firstPrompts = {
		get: vi.fn(() => undefined),
		forget: vi.fn(() => true),
		enqueue: vi.fn(async (..._args: unknown[]) => null)
	}
	const parkedPrompts = {
		forgetDelivered: vi.fn(),
		forgetSession: vi.fn(() => true),
		park: vi.fn((workspaceId: string, sessionId: string, text: string, agent: unknown, queue: boolean) => ({
			workspaceId,
			sessionId,
			text,
			agent,
			queue,
			createdAt: 123
		}))
	}
	const deliverPrompt = vi.fn(
		async (_workspace: unknown, _session: string, _text: string, _budget: number, _queue: boolean) => ({
			ok: true,
			strategy: 'fake',
			error: undefined as string | undefined
		})
	)
	const planUsage = { read: vi.fn(async (_refresh: boolean) => ({})) }
	const workflowState = createWorkflowStateServices({
		orchestration: {} as RelayServices['orchestration'],
		readBody: responses.readBody
	})
	const dependencies = {
		cfg,
		...responses,
		...createMcpServices({ cfg, ...responses }),
		workflowHttpError: workflowState.workflowHttpError,
		serveStatic: vi.fn((_req: IncomingMessage, res: ServerResponse, pathname: string) => {
			res.writeHead(200, { 'content-type': 'text/plain' }).end(`static:${pathname}`)
		}),
		reads,
		firstPrompts,
		parkedPrompts,
		deliverPrompt,
		planUsage,
		actuator: { name: 'fake' },
		STAGED_ATTACHMENTS_DIR: '/unused/attachments',
		createWorkspaceAndRead: vi.fn(async (..._args: unknown[]) => ({ result: { ok: true }, created: workspace })),
		applyAgentPatch: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
		sendBudget: () => 5_000,
		sendOnce: new SendOnce<{ status: number; body: unknown }>({
			keep: answer => answer.status === 200 || answer.status === 202
		}),
		workflowFrozenError: vi.fn((): { error: string } | null => null),
		PARKED_ERROR: 'Prompt parked until the Mac unlocks.'
	}
	return { ...dependencies, services: dependencies as unknown as RelayServices }
}

async function listen(services: RelayServices) {
	const server = createRelayServer(services)
	servers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return (pathname: string, init: RequestInit = {}, authenticated = true) =>
		fetch(`${base}${pathname}`, {
			...init,
			signal: AbortSignal.timeout(5_000),
			headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...init.headers }
		})
}

describe('relay HTTP routing', () => {
	test('authenticates before reads and 404s, while static paths stay outside the API gate', async () => {
		const f = fixture()
		const request = await listen(f.services)
		for (const pathname of ['/api/repos', '/api/unknown']) {
			const response = await request(pathname, {}, false)
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ error: 'unauthorized' })
		}
		expect(f.reads.listRepos).not.toHaveBeenCalled()
		const queryToken = await request(`/api/repos?token=${token}`, {}, false)
		expect(queryToken.status).toBe(200)
		const wrongBearer = await request(`/api/repos?token=${token}`, { headers: { authorization: 'Bearer wrong' } })
		expect(wrongBearer.status).toBe(401)
		const missing = await request('/api/unknown?detail=ignored')
		expect(missing.status).toBe(404)
		expect(await missing.json()).toEqual({ error: 'no route', pathname: '/api/unknown' })
		const wrongMethod = await request('/api/repos', { method: 'POST' })
		expect(wrongMethod.status).toBe(404)
		const asset = await request('/assets/app.js', {}, false)
		expect(await asset.text()).toBe('static:/assets/app.js')
		expect(f.serveStatic).toHaveBeenCalledOnce()
	})

	test('returns read data and treats an empty conditional 304 as handled', async () => {
		const f = fixture()
		const request = await listen(f.services)
		const first = await request('/api/repos')
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ repos: f.reads.listRepos() })
		const etag = first.headers.get('etag')!
		const unchanged = await request('/api/repos', { headers: { 'if-none-match': etag } })
		expect(unchanged.status).toBe(304)
		expect(await unchanged.text()).toBe('')
		expect(unchanged.headers.get('etag')).toBe(etag)
		const unauthorized = await request('/api/repos', { headers: { 'if-none-match': etag } }, false)
		expect(unauthorized.status).toBe(401)
	})

	test('keeps async icon and binary response handlers from falling through to 404', async () => {
		const f = fixture()
		const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-http-'))
		temporaryDirectories.push(directory)
		const icon = path.join(directory, 'icon.svg')
		await writeFile(icon, '<svg>temporary icon</svg>')
		f.reads.resolveRepoIcon.mockReturnValue({ path: icon, contentType: 'image/svg+xml' })
		const request = await listen(f.services)
		const streamed = await request('/api/repos/example/icon')
		expect(streamed.status).toBe(200)
		expect(streamed.headers.get('content-type')).toBe('image/svg+xml')
		expect(await streamed.text()).toBe('<svg>temporary icon</svg>')
		const binary = await request('/api/tool-images/123.0')
		expect(binary.status).toBe(200)
		expect(binary.headers.get('cache-control')).toBe('private, max-age=86400, immutable')
		expect(await binary.text()).toBe('image bytes')
	})

	test('routes through preceding unmatched groups to transcript reads and queue dismissals', async () => {
		const f = fixture()
		const snapshot = {
			entries: [{ rowid: 12, text: 'delivered' }],
			queued: [{ id: 'queued', text: 'next' }],
			cursor: 12
		}
		f.reads.getMessages.mockReturnValue(snapshot)
		const request = await listen(f.services)
		const messages = await request('/api/sessions/chat%20one/messages?after=11')
		expect(messages.status).toBe(200)
		expect(await messages.json()).toEqual(snapshot)
		expect(f.reads.getMessages).toHaveBeenCalledWith('chat one', 11)
		await request('/api/sessions/chat/messages?after=invalid')
		expect(f.reads.getMessages).toHaveBeenLastCalledWith('chat', 0)
		const dismissed = await request('/api/sessions/chat-1/prompt', { method: 'DELETE' })
		expect(dismissed.status).toBe(200)
		expect(await dismissed.json()).toEqual({ ok: true })
		expect(f.parkedPrompts.forgetSession).toHaveBeenCalledWith('chat-1')
		f.parkedPrompts.forgetSession.mockReturnValue(false)
		const gone = await request('/api/sessions/chat-1/prompt', { method: 'DELETE' })
		expect(gone.status).toBe(404)
		expect(await gone.json()).toEqual({ error: 'no parked prompt' })
	})

	test('keeps queue mode and one shared send receipt across retries', async () => {
		const f = fixture()
		const request = await listen(f.services)
		const options = {
			method: 'POST',
			body: JSON.stringify({ workspaceId: 'workspace-1', text: '  next task  ', queue: true, clientId: 'intent-1' })
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await request('/api/sessions/chat-1/prompt', options)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ ok: true, strategy: 'fake' })
		}
		expect(f.deliverPrompt).toHaveBeenCalledOnce()
		expect(f.deliverPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'workspace-1' }),
			'chat-1',
			'next task',
			expect.any(Number),
			true
		)
		expect(f.firstPrompts.forget).toHaveBeenCalledOnce()
		expect(f.parkedPrompts.forgetDelivered).toHaveBeenCalledWith('chat-1', 'next task')
	})

	test('validates staged settings before delivery and preserves explicit false values', async () => {
		const f = fixture()
		const request = await listen(f.services)
		const agent = { model: 'Fable 5', effort: 'high', plan: false, fast: false }
		const response = await request('/api/sessions/chat-1/prompt', {
			method: 'POST',
			body: JSON.stringify({ text: ' hello ', agent, futureClientField: true })
		})
		expect(response.status).toBe(200)
		expect(f.applyAgentPatch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'chat-1', agent)
		expect(f.deliverPrompt).toHaveBeenCalledWith(expect.anything(), 'chat-1', 'hello', expect.any(Number), false)
		expect(f.applyAgentPatch.mock.invocationCallOrder[0]).toBeLessThan(f.deliverPrompt.mock.invocationCallOrder[0])
	})

	test('validates standalone settings with the same fields and preserves empty HTTP patches', async () => {
		const f = fixture()
		const request = await listen(f.services)
		const patch = { workspaceId: 'workspace-1', model: ' Fable 5 ', plan: false, fast: false }
		const response = await request('/api/sessions/chat-1/agent', { method: 'POST', body: JSON.stringify(patch) })
		expect(response.status).toBe(200)
		expect(f.applyAgentPatch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'chat-1', {
			...patch,
			model: 'Fable 5'
		})
		const empty = await request('/api/sessions/chat-1/agent', { method: 'POST', body: '{}' })
		expect(empty.status).toBe(200)
	})

	test('keeps creation prompt-only, immediate-send and explicit wait choices at the HTTP boundary', async () => {
		const f = fixture()
		const request = await listen(f.services)
		const first = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ prompt: ' hello ' }) })
		expect(first.status).toBe(200)
		expect(f.createWorkspaceAndRead).toHaveBeenLastCalledWith('hello', null, undefined)
		expect(f.firstPrompts.enqueue).toHaveBeenLastCalledWith('workspace-1', 'hello', true, [], undefined)
		const configured = await request('/api/workspaces', {
			method: 'POST',
			body: JSON.stringify({
				repo: 'example',
				model: ' Fable 5 ',
				fast: false,
				plan: false,
				send: true,
				sendImmediately: false
			})
		})
		expect(configured.status).toBe(200)
		expect(await configured.json()).toMatchObject({ configured: true, sent: false })
		expect(f.firstPrompts.enqueue).toHaveBeenLastCalledWith('workspace-1', '', false, [], {
			model: 'Fable 5',
			fast: false,
			plan: false
		})
	})

	test.each([
		['/api/sessions/chat-1/prompt', { text: 'hello', agent: { fast: 'false' } }, 'agent.fast'],
		['/api/sessions/chat-1/prompt', { text: 'hello', agent: { effort: 'extreme' } }, 'agent.effort'],
		['/api/sessions/chat-1/prompt', { text: 'hello', agent: [] }, 'agent'],
		['/api/sessions/chat-1/prompt', { text: 'hello', agent: null }, 'agent'],
		['/api/sessions/chat-1/prompt', { text: 'hello', queue: 'false' }, 'queue'],
		['/api/sessions/chat-1/prompt', { text: 'hello', clientId: 123 }, 'clientId'],
		['/api/sessions/chat-1/prompt', { text: 'hello', workspaceId: 123 }, 'workspaceId'],
		['/api/sessions/chat-1/prompt', { text: '  ' }, 'empty prompt'],
		['/api/sessions/chat-1/agent', { plan: 'false' }, 'plan'],
		['/api/sessions/chat-1/agent', { effort: 'extreme' }, 'effort'],
		['/api/workspaces', { repo: 'example', fast: 'false' }, 'fast'],
		['/api/workspaces', { repo: 'example', send: 'false' }, 'send'],
		['/api/workspaces', { repo: 'example', sendImmediately: 0 }, 'sendImmediately'],
		['/api/workspaces', { repo: 'example', attachmentIds: [123] }, 'attachmentIds.0'],
		['/api/workspaces', { repo: 123 }, 'repo'],
		['/api/workspaces', { prompt: 123 }, 'prompt']
	])('rejects invalid fields before any side effects: %s (%#)', async (pathname, body, message) => {
		const f = fixture()
		const request = await listen(f.services)
		const response = await request(pathname, { method: 'POST', body: JSON.stringify(body) })
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: expect.stringContaining(message) })
		expect(f.deliverPrompt).not.toHaveBeenCalled()
		expect(f.applyAgentPatch).not.toHaveBeenCalled()
		expect(f.createWorkspaceAndRead).not.toHaveBeenCalled()
		expect(f.firstPrompts.enqueue).not.toHaveBeenCalled()
	})

	test.each([
		'/api/workspaces',
		'/api/sessions/chat-1/prompt',
		'/api/sessions/chat-1/agent'
	])('returns 400 for malformed JSON and non-object request bodies at %s', async pathname => {
		const request = await listen(fixture().services)
		for (const body of ['{', 'null', '[]', 'true', '"hello"']) {
			const response = await request(pathname, { method: 'POST', body })
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: expect.any(String) })
		}
	})

	test('still rejects Workflow starts before stripping extra input fields and enforces frozen agent settings', async () => {
		const f = fixture()
		const request = await listen(f.services)
		for (const pathname of ['/api/workspaces', '/api/sessions/chat-1/prompt']) {
			const response = await request(pathname, {
				method: 'POST',
				body: JSON.stringify({
					repo: 'example',
					text: 'hello',
					workflow: false
				})
			})
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'Workflow starts through POST /api/workflows.' })
		}
		f.workflowFrozenError.mockReturnValue({ error: 'Workflow owns these settings' })
		for (const [pathname, body] of [
			['/api/sessions/chat-1/prompt', { text: 'hello', agent: { fast: false } }],
			['/api/sessions/chat-1/agent', { fast: false }]
		] as const) {
			const response = await request(pathname, { method: 'POST', body: JSON.stringify(body) })
			expect(response.status).toBe(409)
		}
		expect(f.deliverPrompt).not.toHaveBeenCalled()
		expect(f.applyAgentPatch).not.toHaveBeenCalled()
		expect(f.createWorkspaceAndRead).not.toHaveBeenCalled()
	})

	test('parks a locked send once and replays its accepted response', async () => {
		const f = fixture()
		f.deliverPrompt.mockResolvedValue({ ok: false, strategy: 'fake', error: MAC_LOCKED })
		const request = await listen(f.services)
		const options = {
			method: 'POST',
			body: JSON.stringify({ workspaceId: 'workspace-1', text: 'next task', queue: true, clientId: 'parked-intent' })
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await request('/api/sessions/chat-1/prompt', options)
			expect(response.status).toBe(202)
			expect(await response.json()).toMatchObject({
				ok: false,
				parked: true,
				queued: { sessionId: 'chat-1', queue: true }
			})
		}
		expect(f.parkedPrompts.park).toHaveBeenCalledOnce()
		expect(f.parkedPrompts.park).toHaveBeenCalledWith('workspace-1', 'chat-1', 'next task', undefined, true)
		expect(f.deliverPrompt).toHaveBeenCalledOnce()
		expect(f.firstPrompts.forget).not.toHaveBeenCalled()
	})

	test('keeps MCP method, token, origin and notification handling separate from API routing', async () => {
		const request = await listen(fixture().services)
		const get = await request('/mcp', {}, false)
		expect(get.status).toBe(405)
		expect(get.headers.get('allow')).toBe('POST')
		const unauthorized = await request('/mcp', { method: 'POST', body: '{}' }, false)
		expect(unauthorized.status).toBe(401)
		const foreign = await request('/mcp', { method: 'POST', headers: { origin: 'https://other.invalid' }, body: '{}' })
		expect(foreign.status).toBe(403)
		const notification = await request('/mcp', {
			method: 'POST',
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
		})
		expect(notification.status).toBe(202)
		expect(await notification.text()).toBe('')
	})

	test('maps expected errors and hides internal failure details', async () => {
		const f = fixture()
		const request = await listen(f.services)
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		const cases = [
			{
				error: new f.PayloadTooLargeError('attachment too large'),
				status: 413,
				body: { error: 'attachment too large' }
			},
			{
				error: new WorkflowRequestError('phone only', 403),
				status: 403,
				body: { ok: false, error: { code: 'workflow_authorization_failed', message: 'phone only', retryable: false } }
			},
			{ error: new UiBusyError(4), status: 503, body: { busy: true, queue: { waiting: 0, busy: false } } },
			{
				error: new Error('/private/conductor.db: internal stack detail'),
				status: 500,
				body: { error: 'internal error' }
			}
		]
		for (const example of cases) {
			f.reads.listRepos.mockImplementationOnce(() => {
				throw example.error
			})
			const response = await request('/api/repos')
			expect(response.status).toBe(example.status)
			expect(await response.json()).toMatchObject(example.body)
			expect(response.headers.get('cache-control')).toBe('no-store')
			if (example.status === 503) expect(response.headers.get('retry-after')).toBe('15')
		}
		expect(log).toHaveBeenCalledOnce()
	})

	test('lets the phone overtake waiting MCP requests on the shared UI lock', async () => {
		const f = fixture()
		const order: string[] = []
		f.planUsage.read.mockImplementation(refresh =>
			uiTurn(async () => {
				order.push(refresh ? 'phone' : 'mcp')
				return {}
			})
		)
		const request = await listen(f.services)
		const hold = Promise.withResolvers<void>()
		const blocker = uiTurn(() => hold.promise)
		try {
			const mcp = request('/api/usage', { headers: { 'x-relay-client': 'mcp' } })
			await vi.waitFor(() => expect(uiQueueDepth().waiting).toBe(1))
			const phone = request('/api/usage?refresh=1')
			await vi.waitFor(() => expect(uiQueueDepth().waiting).toBe(2))
			hold.resolve()
			const responses = await Promise.all([mcp, phone])
			expect(responses.map(response => response.status)).toEqual([200, 200])
			expect(order).toEqual(['phone', 'mcp'])
		} finally {
			hold.resolve()
			await blocker
		}
	})
})
