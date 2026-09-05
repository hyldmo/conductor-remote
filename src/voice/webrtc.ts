/** Server-mediated WebRTC session creation for the PWA control-room call. */
import type { OpenAIRealtimeVoice, VoiceLanguage } from '../shared.ts'
import type { VoiceChatContext } from './context.ts'
import { VOICE_INSTRUCTIONS, workspaceVoiceInstructions } from './prompt.ts'
import { oneLine } from './speech.ts'
import { voiceFunctionTools } from './tools.ts'
import { voiceTranscription } from './transcription.ts'

export { TRANSCRIPTION_MODEL } from './transcription.ts'
export const MAX_SDP_CHARS = 100_000

function languageInstruction(language: VoiceLanguage): string {
	switch (language) {
		case 'no':
			return 'Speak Norwegian Bokmål unless the user explicitly asks for another language.'
		case 'en':
			return 'Speak English unless the user explicitly asks for another language.'
		case 'auto':
			return 'Reply in the language the user is speaking. Do not translate unless asked.'
	}
}

export interface WebRtcSessionInput {
	model: string
	voice: OpenAIRealtimeVoice
	language: VoiceLanguage
	instructions?: string
	context?: VoiceChatContext
}

/**
 * The PWA and SIP calls are the same orchestrator. The only transport-specific
 * difference is the tool plumbing: these function definitions are executed by
 * the relay over its private sideband instead of asking OpenAI to reach a public
 * MCP URL.
 */
export function buildWebRtcSession(input: WebRtcSessionInput): Record<string, unknown> {
	return {
		type: 'realtime',
		model: input.model,
		instructions: `${input.instructions ?? (input.context ? workspaceVoiceInstructions(input.context) : VOICE_INSTRUCTIONS)}\n\n${languageInstruction(input.language)}`,
		max_output_tokens: 800,
		output_modalities: ['audio'],
		parallel_tool_calls: false,
		audio: {
			input: {
				transcription: voiceTranscription(input.language),
				noise_reduction: { type: 'near_field' },
				turn_detection: {
					type: 'server_vad',
					threshold: 0.5,
					prefix_padding_ms: 300,
					silence_duration_ms: 650,
					create_response: true,
					interrupt_response: true
				}
			},
			output: { voice: input.voice }
		},
		tools: voiceFunctionTools(),
		tool_choice: 'auto'
	}
}

async function upstreamMessage(response: Response, action: string): Promise<Error> {
	const raw = await response.text().catch(() => '')
	let detail = ''
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: unknown } }
		if (typeof parsed.error?.message === 'string') detail = parsed.error.message
	} catch {
		detail = raw
	}
	const suffix = detail.trim() ? `: ${oneLine(detail, 240)}` : ''
	return new Error(`OpenAI ${action} returned ${response.status}${suffix}`)
}

function callIdFromLocation(location: string | null): string | null {
	if (!location) return null
	const pathname = new URL(location, 'https://api.openai.invalid').pathname.replace(/\/+$/, '')
	const value = pathname.split('/').pop()
	return value?.startsWith('rtc_') ? value : null
}

export interface WebRtcCall {
	callId: string
	sdp: string
}

/**
 * Use OpenAI's unified interface: the standard key never leaves the relay, and
 * the Location receipt gives the broker the call id for its private sideband.
 */
export async function createWebRtcCall(
	apiKey: string,
	apiOrigin: string,
	sdp: string,
	session: WebRtcSessionInput,
	safetyIdentifier: string,
	fetcher: typeof fetch = fetch
): Promise<WebRtcCall> {
	if (!sdp.trim()) throw new Error('WebRTC offer is required')
	if (sdp.length > MAX_SDP_CHARS) throw new Error('WebRTC offer is too large')
	const form = new FormData()
	form.set('sdp', sdp)
	form.set('session', JSON.stringify(buildWebRtcSession(session)))
	const origin = apiOrigin.replace(/\/+$/, '')
	const response = await fetcher(`${origin}/v1/realtime/calls`, {
		method: 'POST',
		signal: AbortSignal.timeout(20_000),
		headers: {
			authorization: `Bearer ${apiKey}`,
			'openai-safety-identifier': safetyIdentifier
		},
		body: form
	})
	if (!response.ok) throw await upstreamMessage(response, 'WebRTC call')
	const callId = callIdFromLocation(response.headers.get('location'))
	if (!callId) throw new Error('OpenAI WebRTC call returned no call id')
	const answer = await response.text()
	if (!answer.trim()) throw new Error('OpenAI WebRTC call returned no SDP answer')
	return { callId, sdp: answer }
}
