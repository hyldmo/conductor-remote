import { describe, expect, it } from 'vitest'
import { VOICE_INSTRUCTIONS } from '../../src/voice/prompt.ts'

describe('the voice session prompt', () => {
	it('keeps the model a narrow presenter and structurally requires preview before send', () => {
		expect(VOICE_INSTRUCTIONS).toContain('voice_roll_call')
		expect(VOICE_INSTRUCTIONS).toContain('voice_workspace_overview')
		expect(VOICE_INSTRUCTIONS).toMatch(/every time.*overview/i)
		expect(VOICE_INSTRUCTIONS).toMatch(/merged.*done/i)
		expect(VOICE_INSTRUCTIONS).toContain('updated_since')
		expect(VOICE_INSTRUCTIONS).toContain('voice_next_decision')
		expect(VOICE_INSTRUCTIONS).toContain('voice_list_repos')
		expect(VOICE_INSTRUCTIONS).toContain('voice_create_workspace_preview')
		expect(VOICE_INSTRUCTIONS).toContain('voice_create_workspace')
		expect(VOICE_INSTRUCTIONS).toContain('voice_send_preview')
		expect(VOICE_INSTRUCTIONS).toContain('voice_send')
		expect(VOICE_INSTRUCTIONS).toMatch(/exact preview/i)
		expect(VOICE_INSTRUCTIONS).toMatch(/yes/i)
		expect(VOICE_INSTRUCTIONS).toMatch(/one decision/i)
		expect(VOICE_INSTRUCTIONS.length).toBeLessThanOrEqual(2_600)
	})
})
