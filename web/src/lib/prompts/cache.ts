import { timestampMs } from '../format.ts'

const MINUTE = 60_000

export interface PromptCacheSession {
	agent_type: string | null
	model: string | null
	updated_at: string
	last_user_message_at: string | null
	prompt_cache_ttl_ms: number | null
}

export interface ColdPromptCache {
	/** How long the provider keeps an inactive prefix warm. */
	ttlMs: number
	/** Compact copy for the composer warning. */
	ttlLabel: string
	/** True when Claude's own usage metadata supplied the TTL. */
	observed: boolean
}

const isClaudeModel = (model: string) =>
	/(?:^|[:/])(claude|fable|haiku|opus|sonnet)|^(claude|fable|haiku|opus|sonnet)/.test(model)
const isOpenAiModel = (model: string) => /(?:^|[:/])(openai|gpt|o[1-9])|^(openai|gpt|o[1-9]|\d)/.test(model)

/**
 * Best available cache window for a Conductor chat.
 *
 * Claude Code records whether its latest cache write used the five-minute or
 * one-hour tier, which beats any authentication guess. Other harnesses do not
 * expose their request policy through Conductor, so use their documented
 * defaults/minimums and keep the warning probabilistic:
 *
 * - Claude subscription conversations default to 1h (an observed write wins).
 * - Current OpenAI/Codex models keep a prefix for at least 30m.
 * - Cursor follows the selected model provider; its Claude path uses 5m.
 * - OpenCode starts optional warming at 4m to cover providers' 5m window.
 */
export function promptCacheWindow(session: PromptCacheSession): ColdPromptCache {
	const agent = session.agent_type?.trim().toLowerCase() ?? ''
	const model = session.model?.trim().toLowerCase() ?? ''
	if ((agent === 'claude' || agent === 'anthropic') && session.prompt_cache_ttl_ms && session.prompt_cache_ttl_ms > 0) {
		return window(session.prompt_cache_ttl_ms, true)
	}

	if (agent === 'claude' || agent === 'anthropic') return window(60 * MINUTE, false)
	if (agent === 'codex' || agent === 'openai') return window(30 * MINUTE, false)

	if (agent === 'cursor') {
		if (isClaudeModel(model)) return window(5 * MINUTE, false)
		if (isOpenAiModel(model)) return window(30 * MINUTE, false)
		// Cursor's own and third-party models publish cached-token prices, but not a
		// stable TTL. Thirty minutes avoids claiming five-minute precision they lack.
		return window(30 * MINUTE, false)
	}

	if (agent === 'acp' || agent === 'opencode') {
		if (isOpenAiModel(model)) return window(30 * MINUTE, false)
		return window(5 * MINUTE, false)
	}

	// A newly added harness gets the cautious common denominator until it exposes
	// a cache policy of its own. The UI says "may be cold", not that it is expired.
	return window(5 * MINUTE, false)
}

/** A warning only makes sense after this chat has completed at least one turn. */
export function coldPromptCache(session: PromptCacheSession, now = Date.now()): ColdPromptCache | null {
	if (!session.last_user_message_at) return null
	const lastActivity = timestampMs(session.updated_at)
	if (!Number.isFinite(lastActivity)) return null
	const cache = promptCacheWindow(session)
	return now - lastActivity >= cache.ttlMs ? cache : null
}

function window(ttlMs: number, observed: boolean): ColdPromptCache {
	return {
		ttlMs,
		ttlLabel: ttlMs >= 60 * MINUTE ? `${ttlMs / (60 * MINUTE)}h` : `${ttlMs / MINUTE}m`,
		observed
	}
}
