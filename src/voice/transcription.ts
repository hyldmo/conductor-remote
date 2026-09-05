import type { VoiceLanguage } from '../shared.ts'

export const TRANSCRIPTION_MODEL = 'gpt-live-transcribe'

/** Both browser and dial-in calls need caller text for their durable transcript. */
export function voiceTranscription(language: VoiceLanguage = 'auto'): Record<string, unknown> {
	return {
		model: TRANSCRIPTION_MODEL,
		prompt:
			'Software development fleet control. Likely terms include Conductor, Codex, TypeScript, React, WebRTC, Tailwind, Biome, workspace, pull request, branch names, and file paths.',
		delay: 'low',
		...(language === 'auto' ? {} : { languages: [language] })
	}
}
