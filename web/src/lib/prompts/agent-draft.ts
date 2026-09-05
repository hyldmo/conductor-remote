/**
 * Staged agent settings — a model / effort / plan / fast change picked on the
 * phone that Conductor hasn't been told about yet; it rides along with the next
 * prompt (hooks/send.ts ▸ `useSendPrompt`).
 *
 * Persisted per session id for the same reason composer drafts are (lib/prompts/draft.ts):
 * the text and the settings are one intent ("send this, on that model"), so an
 * iOS PWA relaunch that restores the draft but forgets the model would quietly
 * send it on the old one. `lib/prefs.ts` owns persistence and host sync; this
 * prefix remains exported because cached older builds use the same key.
 */
export const AGENT_DRAFT_PREFIX = 'conductor-remote-agent:'
