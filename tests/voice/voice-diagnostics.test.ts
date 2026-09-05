import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceRoutes } from '../../src/http/routes/voice.ts'
import { parseVoiceDiagnostics, voiceRealtimeDiagnostic } from '../../src/voice/diagnostic-fields.ts'
import { startVoiceDiagnostics } from '../../web/src/lib/voice/diagnostics.ts'

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('voice diagnostic metadata', () => {
	it('keeps response identity and cancellation without retaining audio, captions or secrets', () => {
		const event = voiceRealtimeDiagnostic({
			type: 'response.done',
			response: { id: 'resp_1', status: 'cancelled', output: [{ text: 'private caption' }] },
			audio: 'raw-audio',
			authorization: 'secret'
		})
		expect(event).toEqual({ type: 'response.done', data: { response_id: 'resp_1', status: 'cancelled' } })
		expect(voiceRealtimeDiagnostic({ type: 'response.output_audio.delta', delta: 'raw-audio' })).toBeNull()
		expect(
			parseVoiceDiagnostics({
				events: [
					{
						type: 'capture',
						atMs: 12.4,
						data: {
							echoCancellation: null,
							noiseSuppression: false,
							micEnabled: true,
							deviceId: 'device-secret',
							label: 'Personal microphone',
							inputLevel: Number.NaN,
							transcript: 'private caption'
						}
					}
				]
			})
		).toEqual([
			{ type: 'capture', atMs: 12, data: { echoCancellation: null, noiseSuppression: false, micEnabled: true } }
		])
	})

	it('bounds batches and rejects malformed events', () => {
		for (const events of [
			[],
			Array(41).fill({ type: 'sample', atMs: 0 }),
			[{ type: 'sample', atMs: -1 }],
			[{ type: 'arbitrary', atMs: 1 }]
		])
			expect(parseVoiceDiagnostics({ events })).toBeNull()
	})

	it('accepts diagnostics for a saved call, including after hangup, and rejects unknown calls', async () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => {})
		let known = true
		let body = JSON.stringify({ events: [{ type: 'closed', atMs: 100, data: { hidden: false, token: 'secret' } }] })
		const handler = createVoiceRoutes({
			voiceHistory: { status: () => (known ? { status: 'ended' } : null) },
			readBody: async () => body,
			json: (_req: unknown, _res: unknown, status: number) => status
		} as unknown as Parameters<typeof createVoiceRoutes>[0])
		const request = () =>
			handler(
				{ method: 'POST' } as IncomingMessage,
				{} as ServerResponse,
				new URL('http://relay/api/voice/calls/rtc_1/diagnostics')
			)
		expect(await request()).toBe(200)
		expect(log.mock.calls[0][0]).toContain('rtc_1')
		expect(log.mock.calls[0][0]).not.toContain('secret')
		body = '{'
		expect(await request()).toBe(400)
		body = 'x'.repeat(32_001)
		expect(await request()).toBe(413)
		known = false
		expect(await request()).toBe(404)
		expect(log).toHaveBeenCalledTimes(1)
	})
})

describe('browser diagnostic lifecycle', () => {
	function fixture(send = vi.fn(async (_events: unknown) => {})) {
		vi.useFakeTimers()
		const mediaDevices = Object.assign(new EventTarget(), {
			getSupportedConstraints: () => ({ echoCancellation: true })
		})
		vi.stubGlobal('navigator', { mediaDevices })
		vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }))
		const track = Object.assign(new EventTarget(), {
			enabled: true,
			muted: false,
			getSettings: () => ({ echoCancellation: true, deviceId: 'secret' })
		})
		const audio = Object.assign(new EventTarget(), { paused: false, muted: false, currentTime: 4, volume: 1 })
		const peer = Object.assign(new EventTarget(), {
			connectionState: 'connected',
			getStats: vi.fn(
				async () =>
					new Map([
						[
							'mic',
							{ type: 'media-source', kind: 'audio', audioLevel: 0.2, totalAudioEnergy: 1, totalSamplesDuration: 5 }
						]
					])
			)
		})
		const diagnostics = startVoiceDiagnostics(
			track as unknown as MediaStreamTrack,
			peer as unknown as RTCPeerConnection,
			audio as unknown as HTMLAudioElement,
			send
		)
		return { diagnostics, track, audio, peer, send }
	}

	it('records unknown settings as unknown, correlates speech with playback, and cleans up without muting', async () => {
		const f = fixture()
		await vi.advanceTimersByTimeAsync(0)
		expect(f.send.mock.calls[0][0]).toMatchObject([
			{ type: 'capture', data: { echoCancellation: true, noiseSuppression: null } }
		])
		f.diagnostics.realtime(
			JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'item_1', audio_start_ms: 200 })
		)
		await vi.advanceTimersByTimeAsync(0)
		expect(f.send.mock.calls[1][0]).toMatchObject([
			{ type: 'input_audio_buffer.speech_started', data: { item_id: 'item_1', playbackPaused: false, playbackTime: 4 } }
		])
		await vi.advanceTimersByTimeAsync(5_000)
		expect(JSON.stringify(f.send.mock.calls)).toContain('inputLevel')
		expect(JSON.stringify(f.send.mock.calls)).not.toContain('secret')
		f.diagnostics.stop()
		await vi.advanceTimersByTimeAsync(0)
		const count = f.send.mock.calls.length
		f.audio.dispatchEvent(new Event('playing'))
		await vi.advanceTimersByTimeAsync(10_000)
		expect(f.send).toHaveBeenCalledTimes(count)
		expect(f.track.enabled).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('flushes a bounded final batch after an in-flight upload fails', async () => {
		let fail!: () => void
		const send = vi
			.fn<(_events: unknown) => Promise<void>>()
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						fail = () => reject(new Error('offline'))
					})
			)
			.mockResolvedValue(undefined)
		const f = fixture(send)
		await vi.advanceTimersByTimeAsync(0)
		for (let i = 0; i < 80; i++)
			f.diagnostics.realtime({ type: 'input_audio_buffer.speech_started', item_id: `item_${i}` })
		f.diagnostics.stop()
		fail()
		await vi.advanceTimersByTimeAsync(0)
		expect(send).toHaveBeenCalledTimes(2)
		const last = send.mock.calls[1][0] as { type: string; data: { dropped?: number } }[]
		expect(last).toHaveLength(40)
		expect(last.at(-1)?.type).toBe('closed')
		expect(last[0].data.dropped).toBeGreaterThan(0)
	})
})
