import { describe, expect, it, vi } from 'vitest'
import { buildWebRtcSession, createWebRtcCall, TRANSCRIPTION_MODEL } from '../src/voice/webrtc.ts'

describe('PWA WebRTC orchestrator calls', () => {
	it('builds an audio session with captions, VAD, and only the scoped voice functions', () => {
		const session = buildWebRtcSession({
			model: 'gpt-realtime-2.1-mini',
			voice: 'marin',
			language: 'no'
		}) as {
			instructions: string
			parallel_tool_calls: boolean
			audio: {
				input: {
					transcription: Record<string, unknown>
					turn_detection: Record<string, unknown>
				}
				output: { voice: string }
			}
			tools: Array<{ type: string; name: string; parameters: Record<string, unknown> }>
		}
		expect(session.instructions).toContain('voice_roll_call')
		expect(session.instructions).toContain('Norwegian Bokmål')
		expect(session.parallel_tool_calls).toBe(false)
		expect(session.audio.input.transcription).toMatchObject({
			model: TRANSCRIPTION_MODEL,
			languages: ['no'],
			delay: 'low'
		})
		expect(session.audio.input.turn_detection).toMatchObject({
			type: 'server_vad',
			create_response: true,
			interrupt_response: true
		})
		expect(session.audio.output.voice).toBe('marin')
		expect(session.tools.map(tool => [tool.type, tool.name])).toEqual([
			['function', 'voice_roll_call'],
			['function', 'voice_workspace_overview'],
			['function', 'voice_next_decision'],
			['function', 'voice_send_preview'],
			['function', 'voice_send']
		])
		expect(session.tools.every(tool => tool.parameters.type === 'object')).toBe(true)
	})

	it('leaves the transcription language open when automatic detection is selected', () => {
		const session = buildWebRtcSession({
			model: 'gpt-realtime-2.1-mini',
			voice: 'cedar',
			language: 'auto'
		}) as { audio: { input: { transcription: Record<string, unknown> } } }
		expect(session.audio.input.transcription).not.toHaveProperty('languages')
	})

	it('uses the unified interface and returns its SDP plus Location call id', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('v=0\r\na=answer', {
				status: 200,
				headers: { location: '/v1/realtime/calls/rtc_browser_1' }
			})
		)
		await expect(
			createWebRtcCall(
				'sk-secret',
				'https://eu.api.openai.com/',
				'v=0\r\na=offer',
				{ model: 'gpt-realtime-2.1-mini', voice: 'marin', language: 'en' },
				'safe-id',
				fetcher
			)
		).resolves.toEqual({ callId: 'rtc_browser_1', sdp: 'v=0\r\na=answer' })

		const [url, init] = fetcher.mock.calls[0] ?? []
		expect(url).toBe('https://eu.api.openai.com/v1/realtime/calls')
		expect(init).toMatchObject({
			method: 'POST',
			headers: { authorization: 'Bearer sk-secret', 'openai-safety-identifier': 'safe-id' }
		})
		const form = init?.body as FormData
		expect(form.get('sdp')).toBe('v=0\r\na=offer')
		const configured = JSON.parse(String(form.get('session'))) as { model: string; tools: unknown[] }
		expect(configured.model).toBe('gpt-realtime-2.1-mini')
		expect(configured.tools).toHaveLength(5)
	})

	it('surfaces a bounded upstream error and refuses a missing call receipt', async () => {
		const failed = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'model is unavailable' }, debug: 'private' }), { status: 400 })
			)
		await expect(
			createWebRtcCall(
				'sk-secret',
				'https://api.openai.com',
				'v=0',
				{ model: 'gpt-realtime-2.1-mini', voice: 'marin', language: 'auto' },
				'safe-id',
				failed
			)
		).rejects.toThrow('OpenAI WebRTC call returned 400: model is unavailable')

		const noLocation = vi.fn<typeof fetch>().mockResolvedValue(new Response('v=0', { status: 200 }))
		await expect(
			createWebRtcCall(
				'sk-secret',
				'https://api.openai.com',
				'v=0',
				{ model: 'gpt-realtime-2.1-mini', voice: 'marin', language: 'auto' },
				'safe-id',
				noLocation
			)
		).rejects.toThrow('no call id')
	})
})
