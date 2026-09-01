/**
 * The handful of things the relay and the phone must compute *identically*, in the
 * one place both can import.
 *
 * `src/` and `web/src/` are one TypeScript project (tsconfig.json includes both), so
 * a plain relative import crosses between them fine. What does not cross is Node: the
 * moment this file imports `node:anything` it stops being bundleable and every web
 * import of it becomes a build failure. **So this module stays stdlib-free — no
 * `node:` imports, ever.** It is the only file under `src/` the web app may import a
 * *value* from; everything else it may only `import type` (see src/wire.ts), which
 * `verbatimModuleSyntax` erases before the bundler ever sees it.
 *
 * Each of these was a second copy before, and each copy was a way for two screens to
 * disagree about the same workspace.
 */

/** Everything `workspaceTitle` needs — structural, because a search result is a leaner row. */
export interface Titled {
	id: string
	workspace_name: string | null
	pr_title: string | null
	branch: string | null
	directory_name: string | null
}

/**
 * The branch minus its prefix, sentence-cased — Conductor's own fallback title while a
 * workspace is still in progress. Prefix-agnostic (github_username / custom / none): it
 * strips the first path segment rather than reading Conductor's `branch_prefix_type`
 * setting, because the branch already embeds whichever prefix was resolved.
 */
export function humanizeBranch(branch: string | null): string {
	const b = branch ?? ''
	const slug = b.includes('/') ? b.slice(b.indexOf('/') + 1) : b
	const words = slug.replace(/[-_]/g, ' ').trim()
	return words ? words[0].toUpperCase() + words.slice(1) : ''
}

/**
 * Conductor's own sidebar title for a workspace: manual name, then PR title, then the
 * humanized branch, then the worktree codename, then the id.
 *
 * `pr_title` is Conductor's cached PR title, present exactly when the workspace has a PR
 * (in-review or done) and cleared back to empty otherwise, so it is the live sidebar
 * title rather than a stale value. `directory_name` (the worktree codename, e.g.
 * "managua-v2") is the last resort for a branchless workspace.
 *
 * Three callers have to agree — the sidebar list on the phone, the workspace a push
 * notification names (src/notify.ts), and the workspace an MCP tool result names
 * (src/mcp-tools.ts). A notification that titles a workspace differently from the list
 * it came from reads as a different workspace.
 */
export function workspaceTitle(w: Titled): string {
	return w.workspace_name || w.pr_title || humanizeBranch(w.branch) || w.directory_name || w.id.slice(0, 8)
}

/**
 * The words a query actually searches for. The phone filters the live workspace list
 * with these while the relay searches the transcript index with the same call, so two
 * different splits would make one list disagree with the other on the same keystroke.
 */
export function queryTokens(raw: string): string[] {
	return raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

/**
 * A temporary `NEW` marker in Conductor's picker is a badge, not part of the
 * model name. The relay and phone use this value for the visible label and for
 * a later selection, so both sides must remove it in the same way.
 */
export function modelPickerLabel(label: string): string {
	return label.endsWith(' NEW') ? label.slice(0, -4) : label
}

/** A labelled section in a model picker. */
export interface ModelPickerGroup {
	label: string
	models: string[]
}

/**
 * Conductor's labels omit the agent for its built-in models. Keep them in the
 * same provider sections as Conductor's picker: Claude Code, Codex, Cursor,
 * and OpenCode. An unknown label belongs in Other until Conductor gives us a
 * provider-qualified name or this small mapping gains its family.
 */
function modelProvider(model: string): string {
	const label = modelPickerLabel(model).trim().toLowerCase()
	if (label.startsWith('anthropic/')) return 'Anthropic'
	if (label.startsWith('openai/')) return 'OpenAI'
	if (label.startsWith('cursor/')) return 'Cursor'
	if (/^(claude|fable|haiku|opus|sonnet)(?:[\s-]|$)/.test(label)) return 'Anthropic'
	if (/^(?:auto|gpt|o[1-9]|\d)(?:[\s.-]|$)/.test(label)) return 'OpenAI'
	if (/^(composer|grok)(?:[\s-]|$)/.test(label)) return 'Cursor'
	if (/^opencode(?:-go)?\//.test(label)) return 'OpenCode'

	const slash = label.indexOf('/')
	if (slash > 0) return label.slice(0, slash)
	return 'Other'
}

/** Stable, case-insensitive grouping shared by every model selector. */
export function groupModelPickerLabels(models: string[]): ModelPickerGroup[] {
	const grouped = new Map<string, string[]>()
	for (const raw of models) {
		const model = modelPickerLabel(raw).trim()
		if (!model) continue
		const provider = modelProvider(model)
		const entries = grouped.get(provider) ?? []
		if (!entries.includes(model)) entries.push(model)
		grouped.set(provider, entries)
	}
	return [...grouped]
		.map(([label, entries]) => ({ label, models: entries.sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Markers the relay wraps search hits in (src/search.ts, via FTS5 `snippet()`). They
 * are control characters, so they must never reach the DOM: an unsplit snippet renders
 * as invisible garbage between the words it was meant to emphasise.
 */
export const HIT_OPEN = '\u0001'
export const HIT_CLOSE = '\u0002'

/** One attachment token in Conductor's prompt syntax. */
export interface AttachmentToken {
	/** Character offsets in the prompt, with `end` immediately after the closing parenthesis. */
	start: number
	end: number
	/** The file name shown on Conductor's attachment chip. */
	name: string
	/** The worktree-relative file path the token points to. */
	path: string
}

const ATTACHMENT_PREFIX = '.context/attachments/'

/**
 * Read Conductor attachment tokens from prompt text.
 *
 * `encodeURIComponent` intentionally leaves parentheses alone. Looking for the first
 * closing parenthesis would therefore break an ordinary file such as `diagram (old).png`.
 * Match a candidate only once its decoded path has Conductor's attachment layout and
 * its basename equals the visible name.
 */
export function attachmentTokens(text: string): AttachmentToken[] {
	const tokens: AttachmentToken[] = []
	let offset = 0
	while (offset < text.length) {
		const start = text.indexOf('@⟦', offset)
		if (start < 0) break
		const labelEnd = text.indexOf('⟧(', start + 2)
		if (labelEnd < 0 || /[\r\n]/.test(text.slice(start, labelEnd))) {
			offset = start + 2
			continue
		}
		const name = text.slice(start + 2, labelEnd)
		const pathStart = labelEnd + 2
		let close = pathStart
		let found = false
		while (!found) {
			close = text.indexOf(')', close)
			if (close < 0) break
			const encoded = text.slice(pathStart, close)
			try {
				const filePath = decodeURIComponent(encoded)
				const suffix = filePath.startsWith(ATTACHMENT_PREFIX) ? filePath.slice(ATTACHMENT_PREFIX.length) : ''
				const slash = suffix.indexOf('/')
				const id = slash < 0 ? '' : suffix.slice(0, slash)
				const fileName = slash < 0 ? '' : suffix.slice(slash + 1)
				if (/^[A-Za-z0-9]{6}$/.test(id) && fileName === name && !fileName.includes('/')) {
					tokens.push({ start, end: close + 1, name, path: filePath })
					offset = close + 1
					found = true
					continue
				}
			} catch {
				// Try a later parenthesis. It can be part of an otherwise valid file name.
			}
			close += 1
		}
		if (!found) offset = start + 2
	}
	return tokens
}

/** Text source formats the relay may return to the phone's source preview. */
const SOURCE_EXTENSIONS = new Set([
	'.bash',
	'.c',
	'.cc',
	'.cpp',
	'.css',
	'.go',
	'.h',
	'.hpp',
	'.html',
	'.java',
	'.js',
	'.json',
	'.jsx',
	'.md',
	'.mjs',
	'.mts',
	'.php',
	'.py',
	'.rb',
	'.rs',
	'.scss',
	'.sh',
	'.sql',
	'.svg',
	'.swift',
	'.toml',
	'.ts',
	'.tsx',
	'.txt',
	'.yaml',
	'.yml'
])

/** True for a file extension the relay's source preview accepts. */
export function isPreviewableSource(filePath: string): boolean {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	return dot !== -1 && SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * A transcript row that carries a tool's *output* rather than the call that produced it.
 *
 * The two are separate `session_messages` rows and reach the phone as separate entries
 * (src/transcript.ts), so three places have to agree on which is which: the phone folds
 * a result onto its call, a rendered transcript prints the call and leaves the output
 * behind, and `read_chat` does the same for an agent. Structural, because each of them
 * holds a slightly different view of the same row.
 */
export function isToolResult(e: { role: string; tool?: string; output?: string }): boolean {
	return e.role === 'tool' && !e.tool && e.output !== undefined
}

/**
 * The sentence every locked-Mac refusal starts with (src/conductor.applescript), and
 * the one thing two sides must agree it means.
 *
 * The relay decides control flow on it — `lockBlocked` (src/writes.ts) parks the prompt
 * rather than burning a phone's retry budget against a screen that will not answer for
 * hours — and the phone decides what to draw: a link to Screen Sharing, because the
 * relay will never unlock the Mac itself. Two matchers over one phrase, spelled out in
 * two files, is how one of them quietly stops matching. macOS's own wording is never
 * matched anywhere here; this sentence is ours, so it cannot drift under us.
 */
export const MAC_LOCKED = 'The Mac is locked'

export function isLockedError(error: string | null | undefined): boolean {
	return (error ?? '').includes(MAC_LOCKED)
}

/**
 * The diagnostic tail `windowEvidence()` (src/conductor.applescript) appends to every
 * window and lock refusal: the window server's count, the lock state, every process
 * named Conductor with its window count, and the menu bar titles.
 *
 * It exists to separate "genuinely windowless" from "we are addressing the wrong
 * process", which is a question for the relay's log. It reached the phone as well,
 * where a tap on Fork against a locked Mac answered with four lines of red text ending
 * in "[menus: Apple, Conductor, File, Edit, View, Window, Help]" and nothing to act on.
 * So `json()` in src/server.ts cuts it on the way out and logs the full text instead.
 *
 * Anchored on our own format: the whole tail is one run of bracketed groups that starts
 * at "[window server:", so a single cut takes all of it and never touches a message
 * that carries none.
 */
export function withoutWindowEvidence(error: string): string {
	return error.replace(/\s*\[window server:.*$/s, '').trim()
}

/**
 * Header naming the push device that sent a request, so the relay can tell which chat
 * that device has on screen and skip notifying it about that one chat (src/notify.ts).
 *
 * It rides the transcript poll, which is already a per-second heartbeat for exactly the
 * chat being read and for no other, so this costs no request and no timer. Declared here
 * rather than spelled twice because a typo would be silent in both directions: the relay
 * would simply never learn what is on screen, and every notification would keep arriving
 * as it does today.
 */
export const VIEWING_HEADER = 'x-relay-device'
