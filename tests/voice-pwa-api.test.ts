import { afterEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../src/routes.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => 'token', setItem: () => {}, removeItem: () => {} }
})

const { client } = await import('../web/src/lib/api.ts')
afterEach(() => vi.unstubAllGlobals())

describe('PWA voice call target', () => {
	it('carries the selected chat and keeps fleet calls compatible', async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({ callId: 'rtc_1', sdp: 'answer' })))
		vi.stubGlobal('fetch', fetcher)
		const target = { workspaceId: 'workspace-1', sessionId: 'selected-chat' }
		await client.voiceCall('offer', 'marin', 'en', target)
		await client.voiceCall('offer', 'cedar', 'auto')
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			routes.voiceCall.path(),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ sdp: 'offer', voice: 'marin', language: 'en', target })
			})
		)
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			routes.voiceCall.path(),
			expect.objectContaining({ body: JSON.stringify({ sdp: 'offer', voice: 'cedar', language: 'auto' }) })
		)
	})
})
