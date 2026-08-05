/**
 * Read marks — the newest activity this phone has actually had on screen, per chat.
 *
 * Conductor's unread flag is cleared by *opening the workspace on the Mac*, and the
 * relay holds the DB read-only (see CLAUDE.md), so nothing the phone does can clear
 * it. Without a local mark, a chat you read here stays shouting until you touch the
 * Mac — which is exactly the state a phone user is trying to avoid.
 *
 * The mark is the session's own `updated_at` at the moment it was on screen, never a
 * clock of ours: it's compared with values from that same column, so a phone whose
 * clock disagrees with the Mac still gets this right, and the next thing the agent
 * says pushes `updated_at` past the mark and lights the chat up again.
 */
import type { Session, Workspace } from './types.ts'

const KEY = 'conductor-remote-read'
/** Marks are per session and sessions only accumulate — keep the newest, drop the rest. */
const LIMIT = 300

export type ReadMarks = Record<string, string>

export function loadReadMarks(): ReadMarks {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
		if (!raw || typeof raw !== 'object') return {}
		return Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === 'string')) as ReadMarks
	} catch {
		return {}
	}
}

/** Persist marks (pruned to `LIMIT`) and hand back exactly what was stored. */
export function writeReadMarks(marks: ReadMarks): ReadMarks {
	const entries = Object.entries(marks)
	const kept = entries.length > LIMIT ? entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, LIMIT) : entries
	const pruned = Object.fromEntries(kept)
	try {
		localStorage.setItem(KEY, JSON.stringify(pruned))
	} catch {}
	return pruned
}

const unseen = (marks: ReadMarks, id: string, at: string) => (marks[id] ?? '') < at

/** Chats in a workspace with news this phone hasn't seen — the sidebar's unread count. */
export function unreadCount(w: Workspace, marks: ReadMarks): number {
	// `?? []` covers a phone running a cached build against an older relay that predates the field.
	return (w.unread_sessions ?? []).filter(s => unseen(marks, s.id, s.at)).length
}

/** Same question for one chat, used by the session tabs. */
export function isUnread(s: Session, marks: ReadMarks): boolean {
	return !!s.unread_count && unseen(marks, s.id, s.updated_at)
}
