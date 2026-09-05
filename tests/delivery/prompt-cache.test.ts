import { describe, expect, test } from 'vitest'
import { coldPromptCache, type PromptCacheSession, promptCacheWindow } from '../../web/src/lib/prompts/cache.ts'

const hour = 60 * 60_000
const base: PromptCacheSession = {
	agent_type: 'claude',
	model: 'opus-5-1m',
	updated_at: '2026-09-03 10:00:00',
	last_user_message_at: '2026-09-03 09:58:00',
	prompt_cache_ttl_ms: null
}

describe('prompt cache windows', () => {
	test('prefers Claude Code’s observed cache-write tier', () => {
		expect(promptCacheWindow({ ...base, prompt_cache_ttl_ms: 5 * 60_000 })).toEqual({
			ttlMs: 5 * 60_000,
			ttlLabel: '5m',
			observed: true
		})
		expect(
			promptCacheWindow({ ...base, agent_type: 'codex', model: 'gpt-5.6-sol', prompt_cache_ttl_ms: 5 * 60_000 })
		).toMatchObject({ ttlMs: 30 * 60_000, observed: false })
	})

	test('uses harness defaults when Conductor has no cache metadata', () => {
		expect(promptCacheWindow(base).ttlMs).toBe(hour)
		expect(promptCacheWindow({ ...base, agent_type: 'codex', model: 'gpt-5.6-sol' }).ttlMs).toBe(30 * 60_000)
		expect(promptCacheWindow({ ...base, agent_type: 'cursor', model: 'claude-sonnet-5' }).ttlMs).toBe(5 * 60_000)
		expect(promptCacheWindow({ ...base, agent_type: 'cursor', model: 'gpt-5.6-sol' }).ttlMs).toBe(30 * 60_000)
		expect(promptCacheWindow({ ...base, agent_type: 'acp', model: 'opencode:opencode/x-preview' }).ttlMs).toBe(
			5 * 60_000
		)
	})
})

describe('cold prompt cache', () => {
	test('turns cold at the end of the provider window', () => {
		expect(coldPromptCache(base, Date.parse('2026-09-03T10:59:59Z'))).toBeNull()
		expect(coldPromptCache(base, Date.parse('2026-09-03T11:00:00Z'))?.ttlLabel).toBe('1h')
	})

	test('does not warn before a chat has had a turn', () => {
		expect(coldPromptCache({ ...base, last_user_message_at: null }, Date.parse('2026-09-04T10:00:00Z'))).toBeNull()
	})
})
