/**
 * Composer draft identities. The local-first persistence, host sync, revision
 * metadata and legacy-key mirroring live together in `lib/prefs.ts`.
 *
 * The store owns the live copy (see store.ts) because a draft is no longer only
 * typed: a first prompt that couldn't be delivered is stashed here, and the
 * composer has to show it without waiting for a remount. The key can also be a
 * workspace id while the workspace has no chat yet.
 */
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
