/** Shared, metadata-only allowlist. Never pass raw Realtime events or track settings to logs. */
export interface VoiceDiagnosticEvent {
	type: string
	atMs: number
	data: Record<string, string | number | boolean | null>
}

const EVENTS = new Set([
	'capture',
	'sample',
	'closed',
	'visibility',
	'devicechange',
	'connection',
	'microphone.mute',
	'microphone.unmute',
	'microphone.ended',
	'playback.playing',
	'playback.pause',
	'playback.waiting',
	'playback.error',
	'input_audio_buffer.speech_started',
	'input_audio_buffer.speech_stopped',
	'input_audio_buffer.committed',
	'output_audio_buffer.started',
	'output_audio_buffer.stopped',
	'output_audio_buffer.cleared',
	'conversation.item.truncated',
	'conversation.item.input_audio_transcription.completed',
	'conversation.item.input_audio_transcription.failed',
	'response.created',
	'response.done'
])
const BOOLEAN_FIELDS = new Set([
	'noiseSuppression',
	'autoGainControl',
	'supportsEchoCancellation',
	'supportsNoiseSuppression',
	'supportsAutoGainControl',
	'micEnabled',
	'micMuted',
	'playbackPaused',
	'playbackMuted',
	'hidden'
])
const NUMBER_FIELDS = new Set([
	'sampleRate',
	'sampleSize',
	'channelCount',
	'latency',
	'playbackTime',
	'playbackVolume',
	'inputLevel',
	'inputEnergy',
	'inputDuration',
	'outputLevel',
	'outputEnergy',
	'outputDuration',
	'echoReturnLoss',
	'echoReturnLossEnhancement',
	'audio_start_ms',
	'audio_end_ms',
	'dropped'
])

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function voiceDiagnosticData(value: unknown): VoiceDiagnosticEvent['data'] {
	const result: VoiceDiagnosticEvent['data'] = {}
	for (const [key, item] of Object.entries(object(value))) {
		if (BOOLEAN_FIELDS.has(key) && (typeof item === 'boolean' || item === null)) result[key] = item
		else if (NUMBER_FIELDS.has(key) && (item === null || (typeof item === 'number' && Number.isFinite(item))))
			result[key] = item
		else if (
			key === 'echoCancellation' &&
			(item === null || typeof item === 'boolean' || item === 'all' || item === 'remote-only')
		)
			result[key] = item
		else if ((key === 'item_id' || key === 'response_id') && typeof item === 'string' && /^[\w-]{1,100}$/.test(item))
			result[key] = item
		else if (
			key === 'status' &&
			typeof item === 'string' &&
			['completed', 'cancelled', 'failed', 'incomplete', 'in_progress'].includes(item)
		)
			result[key] = item
		else if (
			key === 'connection' &&
			typeof item === 'string' &&
			['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(item)
		)
			result[key] = item
	}
	return result
}

export function voiceRealtimeDiagnostic(value: unknown): Omit<VoiceDiagnosticEvent, 'atMs'> | null {
	const event = object(value)
	if (
		typeof event.type !== 'string' ||
		!EVENTS.has(event.type) ||
		(!event.type.includes('_') && !event.type.startsWith('response.'))
	)
		return null
	const response = object(event.response)
	return {
		type: event.type,
		data: voiceDiagnosticData({ ...event, response_id: event.response_id ?? response.id, status: response.status })
	}
}

/** Limits each HTTP batch and strips unknown fields even from authenticated clients. */
export function parseVoiceDiagnostics(value: unknown): VoiceDiagnosticEvent[] | null {
	const events = object(value).events
	if (!Array.isArray(events) || !events.length || events.length > 40) return null
	const result: VoiceDiagnosticEvent[] = []
	for (const raw of events) {
		const event = object(raw)
		if (
			typeof event.type !== 'string' ||
			!EVENTS.has(event.type) ||
			typeof event.atMs !== 'number' ||
			!Number.isFinite(event.atMs) ||
			event.atMs < 0
		)
			return null
		result.push({ type: event.type, atMs: Math.round(event.atMs), data: voiceDiagnosticData(event.data) })
	}
	return result
}
