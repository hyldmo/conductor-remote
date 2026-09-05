/**
 * An opaque, copyable pointer to one source message in a Conductor chat.
 *
 * Search stores `session_messages.rowid` already. Keep that implementation detail
 * out of the MCP contract so the cursor can change shape later without teaching
 * agents to do arithmetic on it.
 */
export function chatCursor(rowid: number): string {
	if (!Number.isSafeInteger(rowid) || rowid < 1) throw new Error('chat cursor rowid must be a positive integer')
	return `m${rowid.toString(36)}`
}

/** Decode a cursor supplied back to `read_chat`; null means it was not one of ours. */
export function parseChatCursor(cursor: string): number | null {
	if (!/^m[0-9a-z]+$/.test(cursor)) return null
	const rowid = Number.parseInt(cursor.slice(1), 36)
	return Number.isSafeInteger(rowid) && rowid > 0 ? rowid : null
}
