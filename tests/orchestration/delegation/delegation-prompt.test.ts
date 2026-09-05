import { describe, expect, test } from 'vitest'
import { delegatedPrompt } from '../../../src/orchestration/delegation/prompt.ts'
import { chatCursor } from '../../../src/transcript/cursor.ts'

describe('ordinary delegation instructions', () => {
	test.each(['exploration', 'implementation', 'review'])('honors a customized %s role and assignment', role => {
		const preamble = 'You may edit the assigned file. Return only JSON matching the requested schema.'
		const prompt = 'Fix src/queue.ts and return {"changed": true}.'
		const text = delegatedPrompt({
			parentSessionId: 'parent-1',
			throughRowid: 17,
			role,
			resolvedRole: { model: '5.6 Terra', agentType: 'codex', preamble },
			prompt,
			handoff: { name: 'context.md', path: '.context/context.md', bytes: 1, token: '@context.md' }
		})
		expect(text).toContain(preamble)
		expect(text).toContain(prompt)
		expect(text).toContain('@context.md')
		expect(text).not.toContain('read-only')
		expect(text).not.toContain('without editing files')
		expect(text).not.toContain('## Baton')
	})

	test('keeps a Baton requirement when it comes from the configured role', () => {
		const preamble = 'Return a ## Baton with the evidence.'
		expect(
			delegatedPrompt({
				parentSessionId: 'parent-1',
				role: 'exploration',
				resolvedRole: { model: 'Fable 5.1', agentType: 'claude', preamble },
				prompt: 'Inspect the queue.',
				handoff: { name: 'context.md', path: '.context/context.md', bytes: 1, token: '@context.md' }
			})
		).toContain(preamble)
	})

	test('gives the helper a bounded parent read and lets the relay deliver its final reply', () => {
		const text = delegatedPrompt({
			parentSessionId: 'parent-1',
			throughRowid: 17,
			role: 'exploration',
			resolvedRole: { model: 'Fable 5.1', agentType: 'claude' },
			prompt: 'Inspect the queue.',
			handoff: { name: 'context.md', path: '.context/context.md', bytes: 1, token: '@context.md' }
		})
		const read = JSON.parse(text.match(/read_chat\((\{[^\n]+\})\)/)![1])
		expect(read).toEqual({ session_id: 'parent-1', near: chatCursor(17), before: 6, after: 0 })
		expect(text).toContain('Put the complete result in your final reply.')
		expect(text).toContain('delivers a completion notice to the parent automatically')
	})
})
