import { describe, expect, it } from 'vitest'
import { VOICE_INSTRUCTIONS } from '../../src/voice/prompt.ts'

describe('the voice session prompt', () => {
	it('routes fresh reads and requires preview before send', () => {
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
		expect(VOICE_INSTRUCTIONS.length).toBeLessThanOrEqual(5_000)
	})

	it('starts fresh and uses the separate call archive only when asked', () => {
		expect(VOICE_INSTRUCTIONS).toContain('Each new call starts as a blank slate')
		expect(VOICE_INSTRUCTIONS).toMatch(/neutral greeting.*wait for the user/)
		expect(VOICE_INSTRUCTIONS).toContain('Do not call tools')
		expect(VOICE_INSTRUCTIONS).not.toContain('Start with voice_roll_call')
		expect(VOICE_INSTRUCTIONS).toContain('Only look them up when asked')
		expect(VOICE_INSTRUCTIONS).toContain('separate from Conductor chats')
		expect(VOICE_INSTRUCTIONS).toContain('voice_list_calls with limit 1, then voice_read_call')
		expect(VOICE_INSTRUCTIONS).toContain('started_since yesterday and started_before today')
		expect(VOICE_INSTRUCTIONS).toContain('voice_search_calls')
		expect(VOICE_INSTRUCTIONS).toContain('a historical yes cannot authorize a new action')
	})
})
