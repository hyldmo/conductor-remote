import { timestampMs } from './format.ts'
import type { TranscriptEntry } from './types.ts'

/**
 * Find the response that owns Copy/Fork in the current turn.
 *
 * Reasoning, tools, and system notices are supporting rows around a response, so
 * they do not replace it. A user row starts a new turn and prevents actions from
 * reaching back to an older response while that turn is unanswered.
 */
export function latestAssistantForActions(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry.role === 'assistant') return entry
		if (entry.role === 'user') return null
	}
	return null
}

/**
 * The response that closes each turn — the last thing the agent said before the next
 * prompt, and the only place in that turn a fork can be cut from.
 *
 * An agent speaks several times inside one turn (a short update, more work, then the
 * answer), so a control under every assistant row would offer four cuts of one exchange,
 * three of which end a copy mid-answer.
 */
export function assistantTurnEnds(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
	const ends: TranscriptEntry[] = []
	let latest: TranscriptEntry | null = null
	for (const entry of entries) {
		if (entry.role === 'assistant') latest = entry
		else if (entry.role === 'user') {
			if (latest) ends.push(latest)
			latest = null
		}
	}
	if (latest) ends.push(latest)
	return ends
}

/**
 * When the turn holding `target` was dispatched — the origin for how long that answer
 * took.
 *
 * `sessions.turn_started_at` is the better source and is what `dispatched` carries: the
 * relay groups current rows by `turn_id`, so a message typed *into* a running turn
 * (steering) does not restart the clock, with `queue_order` retained for legacy rows.
 * A row carrying neither still needs the transcript fallback below. A dispatch at or
 * after the response belongs to a *later* turn, which is every turn but the newest, so
 * it measures nothing about this one.
 */
export function turnOrigin(
	entries: readonly TranscriptEntry[],
	target: TranscriptEntry,
	dispatched?: string | null
): string | null {
	const end = timestampMs(target.ts)
	if (dispatched && timestampMs(dispatched) < end) return dispatched
	const from = entries.lastIndexOf(target)
	for (let i = (from < 0 ? entries.length : from) - 1; i >= 0; i--) {
		if (entries[i].role === 'user') return entries[i].ts
	}
	return null
}
