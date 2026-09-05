import type { ChatHistoryLink, Session } from '../types.ts'

/** Oldest first, excluding the live chat. Tolerate a stale/corrupt link without looping. */
export function previousChats(sessionId: string | null, links: Record<string, ChatHistoryLink>): string[] {
	const result: string[] = []
	const seen = new Set(sessionId ? [sessionId] : [])
	let id = sessionId ? links[sessionId]?.previousSessionId : undefined
	while (id && !seen.has(id)) {
		seen.add(id)
		result.unshift(id)
		id = links[id]?.previousSessionId
	}
	return result
}

/** Links and notifications for an earlier context still open the same conversation. */
export function latestChat(sessionId: string | null, links: Record<string, ChatHistoryLink>): string | null {
	const next = new Map(Object.entries(links).map(([id, link]) => [link.previousSessionId, id]))
	const seen = new Set<string>()
	let id = sessionId
	while (id && next.has(id) && !seen.has(id)) {
		seen.add(id)
		id = next.get(id) ?? id
	}
	return id
}

/** Only the newest context gets a tab; status and sends still address its real session id. */
export function conversationTabs(sessions: Session[], links: Record<string, ChatHistoryLink>): Session[] {
	const predecessors = new Set(Object.values(links).map(link => link.previousSessionId))
	return sessions
		.filter(session => !predecessors.has(session.id))
		.map(session => {
			const link = links[session.id]
			return link ? { ...session, title: link.title || session.title, created_at: link.createdAt } : session
		})
		.sort((a, b) => a.created_at.localeCompare(b.created_at))
}
