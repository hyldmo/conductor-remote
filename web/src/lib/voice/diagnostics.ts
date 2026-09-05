import { voiceDiagnosticData, voiceRealtimeDiagnostic } from '../../../../src/shared.ts'
import type { VoiceDiagnosticEvent } from '../../../../src/voice/diagnostic-fields.ts'

/** Best-effort metadata only; never creates an audio graph or changes the microphone. */
export function startVoiceDiagnostics(
	track: MediaStreamTrack,
	peer: RTCPeerConnection,
	audio: HTMLAudioElement,
	send: (events: VoiceDiagnosticEvent[]) => Promise<unknown>
) {
	const started = performance.now()
	let stopped = false
	let inFlight = false
	let sampling = false
	let dropped = 0
	const pending: VoiceDiagnosticEvent[] = []
	const cleanups: (() => void)[] = []
	const add = (type: string, data: unknown = {}) => {
		if (stopped) return
		if (pending.length === 40) {
			pending.shift()
			dropped += 1
		}
		pending.push({ type, atMs: Math.round(performance.now() - started), data: voiceDiagnosticData(data) })
	}
	const flush = () => {
		if (inFlight || !pending.length) return
		const events = pending.splice(0)
		if (dropped) events[0].data.dropped = dropped
		dropped = 0
		inFlight = true
		// A failed upload must neither fail the call nor grow an offline retry queue.
		void Promise.resolve()
			.then(() => send(events))
			.catch(() => {
				dropped += events.length
			})
			.finally(() => {
				inFlight = false
				if (stopped) flush()
			})
	}
	const snapshot = () => {
		const settings = track.getSettings()
		return {
			echoCancellation: settings.echoCancellation ?? null,
			noiseSuppression: settings.noiseSuppression ?? null,
			autoGainControl: settings.autoGainControl ?? null,
			sampleRate: settings.sampleRate ?? null,
			sampleSize: settings.sampleSize ?? null,
			channelCount: settings.channelCount ?? null,
			micEnabled: track.enabled,
			micMuted: track.muted,
			playbackPaused: audio.paused,
			playbackMuted: audio.muted,
			playbackTime: audio.currentTime,
			playbackVolume: audio.volume,
			connection: peer.connectionState,
			hidden: document.hidden
		}
	}
	const capture = (type: string) => {
		try {
			add(type, snapshot())
		} catch {
			/* Track may have ended during teardown. */
		}
	}
	const listen = (target: EventTarget, event: string, type: string) => {
		const handler = () => {
			capture(type)
			flush()
		}
		target.addEventListener(event, handler)
		cleanups.push(() => target.removeEventListener(event, handler))
	}
	for (const event of ['mute', 'unmute', 'ended']) listen(track, event, `microphone.${event}`)
	for (const event of ['playing', 'pause', 'waiting', 'error']) listen(audio, event, `playback.${event}`)
	listen(peer, 'connectionstatechange', 'connection')
	listen(document, 'visibilitychange', 'visibility')
	listen(navigator.mediaDevices, 'devicechange', 'devicechange')
	try {
		const supports = navigator.mediaDevices.getSupportedConstraints()
		add('capture', {
			...snapshot(),
			supportsEchoCancellation: supports.echoCancellation === true,
			supportsNoiseSuppression: supports.noiseSuppression === true,
			supportsAutoGainControl: supports.autoGainControl === true
		})
	} catch {
		capture('capture')
	}
	flush()
	const sample = async () => {
		if (stopped || sampling) return
		sampling = true
		try {
			const data: Record<string, unknown> = snapshot()
			const stats = await peer.getStats()
			if (stopped) return
			stats.forEach(stat => {
				if (stat.kind !== 'audio' && stat.mediaType !== 'audio') return
				const side = stat.type === 'media-source' ? 'input' : stat.type === 'inbound-rtp' ? 'output' : null
				if (!side) return
				data[`${side}Level`] = stat.audioLevel
				data[`${side}Energy`] = stat.totalAudioEnergy
				data[`${side}Duration`] = stat.totalSamplesDuration
				if (side === 'input') {
					data.echoReturnLoss = stat.echoReturnLoss
					data.echoReturnLossEnhancement = stat.echoReturnLossEnhancement
				}
			})
			add('sample', data)
		} catch {
			capture('sample')
		} finally {
			sampling = false
			flush()
		}
	}
	const interval = setInterval(() => void sample(), 5_000)
	return {
		realtime(raw: unknown) {
			try {
				const event = voiceRealtimeDiagnostic(typeof raw === 'string' ? JSON.parse(raw) : raw)
				if (!event) return
				add(event.type, { ...snapshot(), ...event.data })
				flush()
			} catch {
				/* Diagnostics must not interfere with event handling. */
			}
		},
		stop() {
			if (stopped) return
			capture('closed')
			stopped = true
			clearInterval(interval)
			for (const cleanup of cleanups) cleanup()
			flush()
		}
	}
}
