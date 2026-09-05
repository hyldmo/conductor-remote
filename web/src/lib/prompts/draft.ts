/**
 * Composer draft identities. The local-first persistence, host sync, revision
 * metadata and legacy-key mirroring live together in `lib/prefs.ts`.
 *
 * The store owns the live copy (see store.ts) because a draft is no longer only
 * typed: a first prompt that couldn't be delivered is stashed here, and the
 * composer has to show it without waiting for a remount. The key can also be a
 * workspace id while the workspace has no chat yet.
 */
import { attachmentToken, attachmentTokens } from '../../../../src/shared.ts'
import type { DraftAttachment } from '../types.ts'

export const DRAFT_PREFIX = 'conductor-remote-draft:'

/**
 * The New workspace sheet's first message, which has no chat to be keyed by yet.
 * The sheet is mounted only while it is open (web/src/components/workspaces/WorkspaceList.tsx) and its prompt was
 * component state, so closing it — or iOS relaunching the PWA behind it — threw away
 * typing that lived nowhere else. One key rather than one per repo: it is the box you
 * were typing in, and changing the repo should not swap the text underneath you. Ids
 * are UUIDs, so this cannot collide with a chat's own draft.
 */
export const NEW_WORKSPACE_DRAFT = 'new-workspace'

/** Recover the generated handoff in a draft saved before forks used separate attachments. */
export function legacyForkContent(
	text: string,
	attachments: DraftAttachment[]
): { text: string; attachments: DraftAttachment[] } | null {
	const prefix = 'Forked from '
	if (!text.startsWith(prefix)) return null
	const token = attachmentTokens(text)[0]
	if (
		!token ||
		token.start !== prefix.length ||
		!token.name.startsWith('Transcript of ') ||
		text.slice(token.start, token.end) !== attachmentToken(token.name, token.path) ||
		!text.slice(token.end).startsWith('\n\n')
	)
		return null
	const existing = attachments.find(attachment => attachment.path === token.path)
	return {
		// The old handoff adds a third newline when it appends a continuation.
		text: text.slice(token.end).replace(/^\n{2,3}/, ''),
		attachments: [
			...attachments.filter(attachment => attachment.path !== token.path),
			{
				name: token.name,
				path: token.path,
				// Legacy drafts stored only the reference; Conductor reads the actual file on send.
				bytes: existing?.bytes ?? 0,
				token: text.slice(token.start, token.end),
				source: 'fork'
			}
		]
	}
}
