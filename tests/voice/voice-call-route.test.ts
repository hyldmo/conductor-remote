import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceRoutes } from '../../src/http/routes/voice.ts'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
	const fetcher = vi.fn<typeof fetch>(
		async () =>
			new Response('sdp-answer', {
				status: 200,
				headers: { location: '/v1/realtime/calls/rtc_test' }
			})
	)
	vi.stubGlobal('fetch', fetcher)
	const config = { openaiKey: 'fake-key', model: 'gpt-realtime-2.1', speed: 1.1, sipHost: 'sip.api.openai.com' }
	const registered = vi.fn()
	const request = (body: Record<string, unknown>) =>
		createVoiceRoutes({
			voiceConfig: config,
			voiceBroker: { registerWebRtc: registered },
			readBody: async () => JSON.stringify({ sdp: 'sdp-offer', voice: 'marin', language: 'en', ...body }),
			json: (_req: IncomingMessage, _res: ServerResponse, status: number, result: unknown) => ({
				status,
				body: result
			}),
			voiceSafetyIdentifier: 'test-safety-id'
		} as unknown as Parameters<typeof createVoiceRoutes>[0])(
			{ method: 'POST' } as IncomingMessage,
			{} as ServerResponse,
			new URL('http://relay/api/voice/calls')
		)
	const sentSpeed = (index: number) => {
		const body = fetcher.mock.calls[index]?.[1]?.body as FormData
		return JSON.parse(String(body.get('session'))).audio.output.speed
	}
	return { request, fetcher, registered, config, sentSpeed }
}

describe('browser call speed at the relay boundary', () => {
	it('uses the requested speed for one call and preserves the configured default for older clients', async () => {
		const f = fixture()
		expect(await f.request({ speed: 1.5 })).toMatchObject({ status: 200 })
		expect(f.sentSpeed(0)).toBe(1.5)
		expect(f.config.speed).toBe(1.1)
		expect(await f.request({})).toMatchObject({ status: 200 })
		expect(f.sentSpeed(1)).toBe(1.1)
		expect(f.registered).toHaveBeenCalledTimes(2)
	})

	it.each([
		null,
		'1.5',
		0,
		0.24,
		1.51,
		{}
	])('rejects invalid speed %j before creating an upstream call', async speed => {
		const f = fixture()
		expect(await f.request({ speed })).toMatchObject({ status: 400, body: { error: expect.stringContaining('speed') } })
		expect(f.fetcher).not.toHaveBeenCalled()
		expect(f.registered).not.toHaveBeenCalled()
	})
})
