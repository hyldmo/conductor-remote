import {
	isOpenAIRealtimeVoice,
	isVoiceLanguage,
	type OpenAIRealtimeVoice,
	type VoiceLanguage
} from '../../../src/shared.ts'

export interface VoicePreferences {
	voice: OpenAIRealtimeVoice
	language: VoiceLanguage
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = { voice: 'marin', language: 'auto' }
const PREFS_KEY = 'conductor-remote-voice'

export function loadVoicePreferences(storage: Pick<Storage, 'getItem'> = localStorage): VoicePreferences {
	try {
		const raw = JSON.parse(storage.getItem(PREFS_KEY) ?? '{}') as { voice?: unknown; language?: unknown }
		return {
			voice: isOpenAIRealtimeVoice(raw.voice) ? raw.voice : DEFAULT_VOICE_PREFERENCES.voice,
			language: isVoiceLanguage(raw.language) ? raw.language : DEFAULT_VOICE_PREFERENCES.language
		}
	} catch {
		return DEFAULT_VOICE_PREFERENCES
	}
}

export function saveVoicePreferences(prefs: VoicePreferences, storage: Pick<Storage, 'setItem'> = localStorage): void {
	try {
		storage.setItem(PREFS_KEY, JSON.stringify(prefs))
	} catch {
		// A private browser can refuse localStorage. Voice still works for this page.
	}
}

export type ParsedVoiceEvent =
	| { kind: 'input-delta'; itemId: string; text: string }
	| { kind: 'input-done'; itemId: string; text: string }
	| { kind: 'output-delta'; itemId: string; text: string }
	| { kind: 'output-done'; itemId: string; text: string }
	| { kind: 'tool'; itemId: string; name: string }
	| { kind: 'speech-started' }
	| { kind: 'response-started' }
	| { kind: 'response-done'; error?: string }
	| { kind: 'error'; text: string }

function stringField(value: Record<string, unknown>, key: string): string | null {
	return typeof value[key] === 'string' ? value[key] : null
}

/** The bounded Realtime event vocabulary the control-room UI needs to render. */
export function parseVoiceEvent(raw: unknown): ParsedVoiceEvent | null {
	let event: unknown = raw
	if (typeof event === 'string') {
		try {
			event = JSON.parse(event)
		} catch {
			return null
		}
	}
	if (!event || typeof event !== 'object') return null
	const value = event as Record<string, unknown>
	const type = stringField(value, 'type')
	const itemId = stringField(value, 'item_id') ?? stringField(value, 'call_id') ?? 'voice-item'
	if (type === 'conversation.item.input_audio_transcription.delta') {
		const delta = stringField(value, 'delta')
		return delta === null ? null : { kind: 'input-delta', itemId, text: delta }
	}
	if (type === 'conversation.item.input_audio_transcription.completed') {
		const transcript = stringField(value, 'transcript')
		return transcript === null ? null : { kind: 'input-done', itemId, text: transcript }
	}
	if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
		const delta = stringField(value, 'delta')
		return delta === null ? null : { kind: 'output-delta', itemId, text: delta }
	}
	if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
		const transcript = stringField(value, 'transcript')
		return transcript === null ? null : { kind: 'output-done', itemId, text: transcript }
	}
	// Text is a recovery path if a configured model declines audio for one response.
	if (type === 'response.output_text.delta') {
		const delta = stringField(value, 'delta')
		return delta === null ? null : { kind: 'output-delta', itemId, text: delta }
	}
	if (type === 'response.output_text.done') {
		const text = stringField(value, 'text')
		return text === null ? null : { kind: 'output-done', itemId, text }
	}
	if (type === 'response.function_call_arguments.done') {
		const name = stringField(value, 'name')
		return name === null ? null : { kind: 'tool', itemId, name }
	}
	if (type === 'input_audio_buffer.speech_started') return { kind: 'speech-started' }
	if (type === 'response.created') return { kind: 'response-started' }
	if (type === 'response.done') {
		const response =
			value.response && typeof value.response === 'object' ? (value.response as Record<string, unknown>) : null
		const error =
			response?.error && typeof response.error === 'object' ? (response.error as Record<string, unknown>) : null
		const message = error ? stringField(error, 'message') : null
		return message ? { kind: 'response-done', error: message } : { kind: 'response-done' }
	}
	if (type === 'error') {
		const error = value.error && typeof value.error === 'object' ? (value.error as Record<string, unknown>) : null
		return { kind: 'error', text: (error && stringField(error, 'message')) || 'Voice call failed' }
	}
	return null
}

export function voiceToolLabel(name: string): string {
	switch (name) {
		case 'voice_roll_call':
			return 'Checking the fleet'
		case 'voice_workspace_overview':
			return 'Refreshing workspace overview'
		case 'voice_next_decision':
			return 'Opening the next decision'
		case 'voice_send_preview':
			return 'Preparing a guarded send'
		case 'voice_send':
			return 'Queueing the approved prompt'
		default:
			return 'Working with the relay'
	}
}
