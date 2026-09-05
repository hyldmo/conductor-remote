import { afterEach, describe, expect, test, vi } from 'vitest'
import { call } from '../../src/mcp/client.ts'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('MCP relay client refusals', () => {
	test.each([
		[
			{ error: { code: 'workflow_blocked', message: 'Retry the saved action.', retryable: true } },
			'workflow_blocked: Retry the saved action.'
		],
		[{ error: 'The chat is missing.' }, 'The chat is missing.'],
		[{ error: { message: 'Unable to read roles.' } }, 'Unable to read roles.'],
		[{ error: { detail: 'unknown shape' } }, 'HTTP 409'],
		[null, 'HTTP 409']
	])('preserves readable relay error details %#', async (body, message) => {
		vi.stubEnv('RELAY_TOKEN', 'test-token')
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status: 409 })))
		await expect(call('/api/workflows/run/delegate', { method: 'POST', body: {} })).rejects.toThrow(message)
	})
	test('keeps the UI-busy hint for a structured 503', async () => {
		vi.stubEnv('RELAY_TOKEN', 'test-token')
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(Response.json({ error: { code: 'ui_busy', message: 'Try again.' } }, { status: 503 }))
		)
		await expect(call('/api/test')).rejects.toThrow('ui_busy: Try again. (Conductor’s UI is busy — retry shortly)')
	})
})
