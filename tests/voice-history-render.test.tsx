import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SavedVoiceTranscript } from '../web/src/components/VoiceHistoryPanel.tsx'
import type { VoiceHistoryCall } from '../web/src/lib/types.ts'
import { voiceTranscriptText } from '../web/src/lib/voice-history.ts'

const call: VoiceHistoryCall = {
	callId: 'rtc_saved',
	startedAt: 1_000,
	updatedAt: 3_000,
	endedAt: null,
	transport: 'webrtc',
	model: 'test',
	voice: 'marin',
	language: 'no',
	status: 'interrupted',
	hasGaps: true,
	preview: 'Hei',
	entryCount: 3,
	entries: [
		{
			id: 'u1',
			role: 'user',
			text: 'Hei <script>alert(1)</script>',
			at: 1_000,
			partial: false,
			interrupted: false,
			transcriptionFailed: false
		},
		{
			id: 'a1',
			role: 'assistant',
			text: 'The answer\nkeeps its lines.',
			at: 2_000,
			partial: true,
			interrupted: true,
			transcriptionFailed: false
		},
		{ id: 'u2', role: 'user', text: '', at: 3_000, partial: true, interrupted: false, transcriptionFailed: true }
	]
}

describe('saved call reading and export', () => {
	it('renders caller and assistant text safely with incomplete-capture explanations', () => {
		const html = renderToStaticMarkup(<SavedVoiceTranscript call={call} />)
		expect(html).toContain('You')
		expect(html).toContain('Orchestrator')
		expect(html).toContain('&lt;script&gt;')
		expect(html).not.toContain('<script>')
		expect(html).toContain('This transcript may have gaps')
		expect(html).toContain('Partial transcript')
		expect(html).toContain('words that were not played')
		expect(html).toContain('Audio could not be transcribed')
	})

	it('exports the full conversation in order and preserves the same gap and interruption markers', () => {
		const text = voiceTranscriptText(call)
		expect(text).toContain('rtc_saved')
		expect(text).toContain('This transcript may have gaps')
		expect(text).toContain('The answer\nkeeps its lines.')
		expect(text).toContain('[Partial transcript.]')
		expect(text).toContain('words that were not played')
		expect(text.indexOf('Hei')).toBeLessThan(text.indexOf('The answer'))
		expect(text).toContain('[Audio could not be transcribed.]')
	})
})
