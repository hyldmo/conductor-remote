import type { SessionState } from '../reads/types.ts'
import type { ChatHistoryLink } from '../wire.ts'

function timestamp(value: string | null | undefined): number {
	if (!value) return 0
	const parsed = Date.parse(value.includes('T') || /Z$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
	return Number.isFinite(parsed) ? parsed : 0
}

/** Resolve replacements before status/date filters, so filtering cannot revive an old question. */
export function currentConversations(
	states: SessionState[],
	history: (workspaceId: string) => Record<string, ChatHistoryLink>
): SessionState[] {
	const unique = new Map<string, SessionState>()
	for (const state of states) {
		const previous = unique.get(state.sessionId)
		if (!previous || timestamp(state.updatedAt) > timestamp(previous.updatedAt)) unique.set(state.sessionId, state)
	}
	const histories = new Map<string, Map<string, string[]>>()
	return [...unique.values()].filter(state => {
		// A person may have resumed an earlier context as independent work.
		if (state.status === 'working') return true
		let next = histories.get(state.workspaceId)
		if (!next) {
			next = new Map()
			for (const [id, link] of Object.entries(history(state.workspaceId))) {
				next.set(link.previousSessionId, [...(next.get(link.previousSessionId) ?? []), id])
			}
			histories.set(state.workspaceId, next)
		}
		const seen = new Set([state.sessionId])
		let id = state.sessionId
		let accepted = false
		while (next.has(id)) {
			const successors = next.get(id)!
			// Corrupt or ambiguous relationships must never hide work.
			if (successors.length !== 1 || seen.has(successors[0])) return true
			const successor = unique.get(successors[0])
			if (successor && successor.workspaceId !== state.workspaceId) return true
			if (id === state.sessionId && state.lastUserMessageAt) {
				const created = timestamp(successor?.createdAt)
				if (!created || timestamp(state.lastUserMessageAt) >= created) return true
			}
			// Joining history precedes sending. An empty or queued successor is not a receipt.
			if (successor && timestamp(successor.turnStartedAt)) accepted = true
			id = successors[0]
			seen.add(id)
		}
		return !accepted
	})
}
