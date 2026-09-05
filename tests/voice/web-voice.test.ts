import { describe, expect, it } from 'vitest'
import {
	DEFAULT_VOICE_PREFERENCES,
	loadVoicePreferences,
	parseVoiceEvent,
	saveVoicePreferences,
	voiceToolLabel
} from '../../web/src/lib/voice/connection.ts'

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
		expect(voiceToolLabel('voice_list_repos')).toBe('Checking repositories')
		expect(voiceToolLabel('voice_create_workspace_preview')).toBe('Preparing a workspace')
		expect(voiceToolLabel('voice_create_workspace')).toBe('Creating the approved workspace')
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

	it('starts at 1.25 and remembers the last chosen speed without losing voice or language', () => {
		let saved = JSON.stringify({ voice: 'cedar', language: 'no' })
		const storage = {
			getItem: () => saved,
			setItem: (_key: string, value: string) => {
				saved = value
			}
		}
		const prefs = loadVoicePreferences(storage)
		expect(prefs).toEqual({ voice: 'cedar', language: 'no', speed: 1.25 })
		saveVoicePreferences({ ...prefs, speed: 1.5 }, storage)
		expect(loadVoicePreferences(storage)).toEqual({ voice: 'cedar', language: 'no', speed: 1.5 })
		saveVoicePreferences({ ...prefs, speed: 1.4 }, storage)
		expect(loadVoicePreferences(storage)).toEqual({ voice: 'cedar', language: 'no', speed: 1.4 })
	})

	it.each([null, '1.5', 0, 2])('ignores an invalid saved speed: %s', speed => {
		expect(loadVoicePreferences({ getItem: () => JSON.stringify({ voice: 'cedar', language: 'en', speed }) })).toEqual({
			voice: 'cedar',
			language: 'en',
			speed: 1.25
		})
	})
})

it('distinguishes failed and incomplete answers from normal interruption', () => {
	expect(
		parseVoiceEvent({
			type: 'response.done',
			response: { status: 'failed', status_details: { error: { code: 'server_error' } } }
		})
	).toMatchObject({ kind: 'response-done', error: expect.stringContaining('server_error') })
	expect(
		parseVoiceEvent({
			type: 'response.done',
			response: { status: 'incomplete', status_details: { reason: 'max_output_tokens' } }
		})
	).toMatchObject({ error: expect.stringContaining('max_output_tokens') })
	expect(
		parseVoiceEvent({
			type: 'response.done',
			response: { status: 'cancelled', status_details: { reason: 'turn_detected' } }
		})
	).toEqual({ kind: 'response-done' })
})

it('separates playback from generation and receives caption truncation', () => {
	expect(parseVoiceEvent({ type: 'output_audio_buffer.started' })).toEqual({ kind: 'playback-started' })
	expect(parseVoiceEvent({ type: 'response.done', response: { status: 'completed' } })).toEqual({
		kind: 'response-done'
	})
	expect(parseVoiceEvent({ type: 'output_audio_buffer.stopped' })).toEqual({ kind: 'playback-stopped' })
	expect(parseVoiceEvent({ type: 'output_audio_buffer.cleared' })).toEqual({ kind: 'playback-cleared' })
	expect(parseVoiceEvent({ type: 'conversation.item.truncated', item_id: 'old' })).toEqual({
		kind: 'truncated',
		itemId: 'old'
	})
	expect(parseVoiceEvent({ type: 'input_audio_buffer.speech_stopped' })).toEqual({ kind: 'speech-stopped' })
})
