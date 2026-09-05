import { describe, expect, test } from 'vitest'
import { delegatedPrompt } from '../src/delegation-prompt.ts'

describe('ordinary delegation instructions', () => {
	test.each(['exploration', 'implementation', 'review'])('honors a customized %s role and assignment', role => {
		const preamble = 'You may edit the assigned file. Return only JSON matching the requested schema.'
		const prompt = 'Fix src/queue.ts and return {"changed": true}.'
		const text = delegatedPrompt({
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
				role: 'exploration',
				resolvedRole: { model: 'Fable 5.1', agentType: 'claude', preamble },
				prompt: 'Inspect the queue.',
				handoff: { name: 'context.md', path: '.context/context.md', bytes: 1, token: '@context.md' }
			})
		).toContain(preamble)
	})
})
