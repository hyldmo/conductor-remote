/**
 * Optimistic prompts — what was typed, from the moment it leaves the composer
 * until the relay confirms it — mirrored to localStorage.
 *
 * The composer clears its draft as soon as a send *starts* (Composer.tsx), because
 * the bubble is the feedback from then on. So between that and a confirmation this
 * list holds the only copy of the text. Kept in memory alone, a reload — or iOS
 * discarding a backgrounded PWA, which is the one that actually happens — threw a
 * failed prompt away in exactly the case its text was worth keeping.
 *
 * The two statuses come back differently:
 *
 * - `error` is restored verbatim, Retry and Dismiss and all.
 * - `sending` cannot be: the request died with the page, so nothing is waiting on it
 *   any more. It returns as `error` flagged `interrupted`, which the transcript
 *   reconciles like a `sending` bubble (`isUnconfirmed`) — a prompt that *did* land
 *   arrives as a real user row and the bubble is dropped, instead of sitting in red
 *   next to it.
 *
 * That reconciliation is also what keeps Retry from sending a landed prompt twice
 * once the entry outlives the relay's 10-minute send memo (src/sendonce.ts): inside
 * that window the id answers for itself, and outside it the bubble is already gone
 * by the time the transcript has painted, because its text is in the chat.
 */
import { WORKFLOW_OBJECTIVE_HEADING } from '../../../src/shared.ts'

const KEY = 'conductor-remote-pending'

/** A backstop, not a policy — a bubble is per chat and every failed one is dismissible. */
const LIMIT = 20

/**
 * How long an undelivered prompt is still worth restoring. It has to outlive a
 * reload, an app relaunch and a night's sleep. Past that the text is stale enough
 * that a red bubble in a chat you'd stopped thinking about costs more than it saves.
 */
const TTL_MS = 24 * 60 * 60 * 1000

/**
 * A prompt shown optimistically in the transcript before the relay confirms it.
 * `sending` until the POST resolves; `error` if it failed (the relay's read-back
 * found no matching row, or the request never reached it). Carries workspaceId so
 * the in-chat Retry can re-send without the Composer.
 */
export interface PendingMessage {
	id: string
	sessionId: string
	workspaceId: string
	text: string
	/** Keep a retry in Conductor's follow-up queue. */
	queue?: boolean
	/** Retry this first message through the server-owned planning-role workflow expansion. */
	workflow?: boolean
	status: 'sending' | 'error'
	error?: string
	/** Restored from storage as a send nobody is awaiting any more — see the header. */
	interrupted?: boolean
	createdAt: number
}

/**
 * The tiny status ring shared by the workspace row and chat tab. Local optimistic
 * sends use `sending` / `error`; prompts the relay owns use `waiting` / `failed`.
 * Collapse both vocabularies here so every surface changes at the same boundary.
 */
export type PromptIndicatorState = 'sending' | 'failed' | null
interface RelayPendingPrompt {
	text: string
	status: 'waiting' | 'failed'
}

export function promptIndicator(
	local: readonly Pick<PendingMessage, 'text' | 'status'>[],
	relay: readonly RelayPendingPrompt[] = [],
	workingHint = false
): PromptIndicatorState {
	let sending = workingHint
	const localTexts = new Set<string>()
	for (const prompt of local) {
		localTexts.add(prompt.text.trim())
		// An undismissed failure stays actionable even if another prompt is also moving.
		if (prompt.status === 'error') return 'failed'
		if (prompt.status === 'sending') sending = true
	}
	for (const prompt of relay) {
		// Retry moves ownership into the optimistic bubble immediately. The state poll
		// may still hold the old relay failure for one tick; don't let that stale X win.
		if (localTexts.has(prompt.text.trim())) continue
		if (prompt.status === 'failed') return 'failed'
		if (prompt.status === 'waiting') sending = true
	}
	return sending ? 'sending' : null
}

/**
 * Whether the chat is still the authority on this prompt: nothing has told us it
 * failed for a reason of its own, so the text arriving as a real user row is the
 * answer. A bubble that failed while the app was watching is *not* this — its red
 * state is a fact about the send, and matching text elsewhere in the chat (someone
 * says "yes" twice) must never quietly retire it.
 */
export const isUnconfirmed = (p: PendingMessage): boolean => p.status === 'sending' || !!p.interrupted

/** Workflow prompts gain server instructions, but retain the exact user objective after this heading. */
export function pendingMatchesTranscript(pending: PendingMessage, transcriptText: string): boolean {
	const expected = pending.text.trim()
	const actual = transcriptText.trim()
	if (!pending.workflow) return actual === expected
	return actual.endsWith(`${WORKFLOW_OBJECTIVE_HEADING}\n\n${expected}`)
}

function isPending(value: unknown): value is PendingMessage {
	const p = value as Partial<PendingMessage> | null
	return (
		!!p &&
		typeof p.id === 'string' &&
		typeof p.sessionId === 'string' &&
		typeof p.workspaceId === 'string' &&
		typeof p.text === 'string' &&
		typeof p.createdAt === 'number' &&
		(p.workflow === undefined || typeof p.workflow === 'boolean') &&
		(p.status === 'sending' || p.status === 'error')
	)
}

const restore = (p: PendingMessage): PendingMessage =>
	p.status === 'sending' ? { ...p, status: 'error', interrupted: true, error: 'Never confirmed — the app reloaded' } : p

/** Every prompt still awaiting an outcome — read once at boot to seed the store. */
export function loadPending(): PendingMessage[] {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
		if (!Array.isArray(raw)) return []
		const cutoff = Date.now() - TTL_MS
		return raw
			.filter(isPending)
			.filter(p => p.createdAt > cutoff)
			.slice(-LIMIT)
			.map(restore)
	} catch {
		return []
	}
}

export function writePending(pending: PendingMessage[]): void {
	try {
		const kept = pending.slice(-LIMIT)
		if (kept.length) localStorage.setItem(KEY, JSON.stringify(kept))
		else localStorage.removeItem(KEY)
	} catch {}
}
