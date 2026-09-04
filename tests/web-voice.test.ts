import { describe, expect, it } from 'vitest'
import {
	DEFAULT_VOICE_PREFERENCES,
	loadVoicePreferences,
	parseVoiceEvent,
	voiceToolLabel
} from '../web/src/lib/voice.ts'

describe('the browser voice seam', () => {
	it('parses caller and orchestrator captions from the Realtime data channel', () => {
		expect(
			parseVoiceEvent(
				JSON.stringify({
					type: 'conversation.item.input_audio_transcription.delta',
					item_id: 'input_1',
					delta: 'hei '
				})
			)
		).toEqual({ kind: 'input-delta', itemId: 'input_1', text: 'hei ' })
		expect(
			parseVoiceEvent({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'input_1',
				transcript: 'Hei verden.'
			})
		).toEqual({ kind: 'input-done', itemId: 'input_1', text: 'Hei verden.' })
		expect(
			parseVoiceEvent({
				type: 'response.output_audio_transcript.delta',
				item_id: 'output_1',
				delta: 'Three workspaces'
			})
		).toEqual({ kind: 'output-delta', itemId: 'output_1', text: 'Three workspaces' })
		expect(
			parseVoiceEvent({
				type: 'response.output_audio_transcript.done',
				item_id: 'output_1',
				transcript: 'Three workspaces need you.'
			})
		).toEqual({ kind: 'output-done', itemId: 'output_1', text: 'Three workspaces need you.' })
	})

	it('surfaces tool activity, lifecycle, and useful errors', () => {
		expect(
			parseVoiceEvent({
				type: 'response.function_call_arguments.done',
				call_id: 'call_1',
				name: 'voice_roll_call',
				arguments: '{}'
			})
		).toEqual({ kind: 'tool', itemId: 'call_1', name: 'voice_roll_call' })
		expect(voiceToolLabel('voice_roll_call')).toBe('Checking the fleet')
		expect(voiceToolLabel('voice_workspace_overview')).toBe('Refreshing workspace overview')
		expect(parseVoiceEvent({ type: 'response.created' })).toEqual({ kind: 'response-started' })
		expect(parseVoiceEvent({ type: 'response.done', response: {} })).toEqual({ kind: 'response-done' })
		expect(parseVoiceEvent({ type: 'error', error: { message: 'connection lost' } })).toEqual({
			kind: 'error',
			text: 'connection lost'
		})
	})

	it('ignores unrelated or malformed events', () => {
		expect(parseVoiceEvent('{')).toBeNull()
		expect(parseVoiceEvent({ type: 'session.created' })).toBeNull()
	})

	it('falls back from stale local preferences', () => {
		const storage = { getItem: () => JSON.stringify({ voice: 'not-a-voice', language: 'xx' }) }
		expect(loadVoicePreferences(storage)).toEqual(DEFAULT_VOICE_PREFERENCES)
	})
})
