/**
 * The voice listener's HTTP rules (`src/voice/server.ts`).
 *
 * This file is the only thing standing between the public internet and a process that can drive
 * the Mac, so the tests here are about what must *not* be reachable rather than about features.
 * Three of its rules fail silently if broken. A route that answers off `/webhook`, `/twiml` and
 * `/mcp` would put the relay's own surface on a Funnel port, and nothing in a typecheck or a
 * manual curl of the happy path would notice. The `/mcp` token gate is the only guard on a
 * credential that reaches `createVoiceTools`, and a gate that accepts an absent bearer looks
 * exactly like a gate that works when you test it with the right one. And the Origin refusal is
 * the whole DNS-rebinding defence, worth a test precisely because no legitimate client ever
 * sends the header, so its removal would never show up in use.
 *
 * The prefix rule earns a test of its own: Tailscale strips the `--set-path=/voice` mount before
 * proxying, so the public URL and the local one differ by a segment, and picking one spelling
 * would 404 whichever caller happened to use the other.
 */

import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVoiceServer, routeName, type VoiceRoutes } from '../../src/voice/server.ts'

const TOKEN = 'scoped-voice-token'
const seen: { webhook: string[]; twiml: string[]; rpc: unknown[] } = { webhook: [], twiml: [], rpc: [] }
let lastRpcHeaders: http.IncomingHttpHeaders = {}

const routes: VoiceRoutes = {
	async webhook(body) {
		seen.webhook.push(body)
		return { status: 200, body: 'ok' }
	},
	async twiml(body) {
		seen.twiml.push(body)
		return { status: 200, body: '<Response/>', contentType: 'text/xml' }
	},
	async rpc(message, headers) {
		seen.rpc.push(message)
		lastRpcHeaders = headers
		const id = (message as { id?: unknown }).id
		return id === undefined ? null : { jsonrpc: '2.0', id, result: { ok: true } }
	}
}

const server = createVoiceServer({ routes, mcpToken: () => TOKEN })
let base = ''

beforeAll(
	() =>
		new Promise<void>(resolve => {
			server.listen(0, '127.0.0.1', () => {
				base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
				resolve()
			})
		})
)
afterAll(() => new Promise<void>(resolve => void server.close(() => resolve())))

const post = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { method: 'POST', ...init })
const withToken = (token: string) => ({ authorization: `Bearer ${token}` })

describe('routeName', () => {
	it('accepts both the public and the stripped spelling', () => {
		expect(routeName('/')).toBe('webhook')
		expect(routeName('/voice')).toBe('webhook')
		expect(routeName('/webhook')).toBe('webhook')
		expect(routeName('/voice/webhook')).toBe('webhook')
		expect(routeName('/voice/mcp')).toBe('mcp')
		expect(routeName('/twiml/')).toBe('twiml')
	})

	it('knows nothing else, including the relay it sits beside', () => {
		for (const p of ['/api/state', '/mcp/extra', '/voicex/webhook', '/webhookk', '/index.html']) {
			expect(routeName(p)).toBeNull()
		}
	})
})

describe('the listener', () => {
	it('404s anything that is not one of its three routes', async () => {
		for (const p of ['/api/state', '/not-voice']) expect((await post(p)).status).toBe(404)
	})

	it('accepts the root path Funnel produces for the configured public /voice webhook', async () => {
		const res = await post('/', { body: '{"type":"realtime.call.incoming"}' })
		expect(res.status).toBe(200)
		expect(seen.webhook.at(-1)).toBe('{"type":"realtime.call.incoming"}')
	})

	it('answers POST only', async () => {
		expect((await fetch(`${base}/webhook`)).status).toBe(405)
		expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405)
	})

	it('lets the two signed webhooks through without a bearer, since neither caller can hold one', async () => {
		expect((await post('/voice/webhook', { body: '{"type":"realtime.call.incoming"}' })).status).toBe(200)
		expect(seen.webhook.at(-1)).toBe('{"type":"realtime.call.incoming"}')
		const twiml = await post('/twiml', { body: 'From=%2B4712345678' })
		expect(twiml.status).toBe(200)
		expect(twiml.headers.get('content-type')).toContain('text/xml')
	})

	it('refuses /mcp without a bearer, and with the wrong one', async () => {
		expect((await post('/mcp', { body: '{}' })).status).toBe(401)
		expect((await post('/mcp', { body: '{}', headers: withToken('nearly-right') })).status).toBe(401)
		expect((await post('/mcp', { body: '{}', headers: withToken(`${TOKEN}x`) })).status).toBe(401)
	})

	it('refuses /mcp from anything carrying an Origin, which a browser cannot omit', async () => {
		const res = await post('/mcp', {
			body: '{}',
			headers: { ...withToken(TOKEN), origin: 'https://evil.example' }
		})
		expect(res.status).toBe(403)
	})

	it('serves JSON-RPC to a caller holding the scoped token', async () => {
		const res = await post('/mcp', {
			body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
			headers: { ...withToken(TOKEN), 'content-type': 'application/json', 'x-voice-call-id': 'rtc_7' }
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
		expect(lastRpcHeaders['x-voice-call-id']).toBe('rtc_7')
	})

	it('answers a batch of nothing but notifications with 202 and no body', async () => {
		const res = await post('/mcp', {
			body: JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
			headers: withToken(TOKEN)
		})
		expect(res.status).toBe(202)
		expect(await res.text()).toBe('')
	})

	it('answers unparseable JSON with the JSON-RPC parse error rather than a bare 400', async () => {
		const res = await post('/mcp', { body: '{not json', headers: withToken(TOKEN) })
		expect(res.status).toBe(400)
		expect((await res.json()).error.code).toBe(-32700)
	})

	it('caps the body before the handler ever sees it', async () => {
		const res = await post('/voice/webhook', { body: 'x'.repeat(1_000_001) })
		expect(res.status).toBe(413)
		expect(seen.webhook.at(-1)).not.toContain('xxxxx')
	})
})
