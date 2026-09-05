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

import type { TranscriptEntry } from './transcript/parser.ts'

export { voiceDiagnosticData, voiceRealtimeDiagnostic } from './voice/diagnostic-fields.ts'

/** Stable wire values used by request validation and the phone's effort controls. */
export const AGENT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const

export function isAgentEffort(value: unknown): value is (typeof AGENT_EFFORTS)[number] {
	return AGENT_EFFORTS.some(effort => effort === value)
}

/** Everything `workspaceTitle` needs — structural, because a search result is a leaner row. */
export interface Titled {
	id: string
	workspace_name: string | null
	pr_title: string | null
	branch: string | null
	directory_name: string | null
}

/**
 * Parse the duration grammar accepted by `conductor-remote nosleep`: `90m`,
 * `2h`, `30s`, or bare seconds. Kept here so the CLI and phone cannot drift.
 */
export function parseDurationSeconds(raw: string): number | null {
	const match = /^(\d+)(s|m|h)?$/.exec(raw.trim())
	if (!match) return null
	const amount = Number(match[1])
	const unit = match[2] ?? 's'
	const seconds = amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1)
	return Number.isSafeInteger(seconds) ? seconds : null
}

/** Stable delimiter around the user-authored part of a server-expanded Workflow prompt. */
export const WORKFLOW_OBJECTIVE_HEADING = '## Workflow objective'

/**
 * Private orchestration metadata is deliberately recognizable at every relay read
 * boundary. The model needs this block in its original Conductor context, while the
 * phone, search index, transcript attachments, logs, and MCP reads must never repeat
 * it. Keep one versioned marker rather than teaching each consumer about individual
 * fields as the state machine grows.
 */
export const WORKFLOW_PRIVATE_ENVELOPE_VERSION = 1 as const
export const WORKFLOW_PRIVATE_ENVELOPE_OPEN = `<conductor-remote-workflow-private version="${WORKFLOW_PRIVATE_ENVELOPE_VERSION}">`
export const WORKFLOW_PRIVATE_ENVELOPE_CLOSE = '</conductor-remote-workflow-private>'
export const WORKFLOW_PRIVATE_REDACTION = '[Workflow orchestration metadata hidden]'

/** Prefix on the random 256-bit bearer values issued by the Workflow coordinator. */
export const WORKFLOW_CAPABILITY_PREFIX = `crwf_v${WORKFLOW_PRIVATE_ENVELOPE_VERSION}_`

export interface WorkflowPrivateEnvelope {
	workflowId: string
	phaseCapability: string
	cycle: number
	revision: number
	allowedRoles: readonly string[]
}

/**
 * Add a non-secret version prefix to 32 bytes of base64url entropy. Besides making
 * accidental disclosure recognizable, the prefix lets a future protocol rotate its
 * scrub rule without treating arbitrary long identifiers as capabilities.
 */
export function workflowCapabilityToken(base64urlEntropy: string): string {
	if (!/^[A-Za-z0-9_-]{43}$/.test(base64urlEntropy)) {
		throw new Error('Workflow capability entropy must be 32 bytes encoded as base64url.')
	}
	return `${WORKFLOW_CAPABILITY_PREFIX}${base64urlEntropy}`
}

/** The opaque, machine-readable block delivered only into the root model's context. */
export function workflowPrivateEnvelope(value: WorkflowPrivateEnvelope): string {
	return [
		WORKFLOW_PRIVATE_ENVELOPE_OPEN,
		JSON.stringify({
			workflow_id: value.workflowId,
			phase_capability: value.phaseCapability,
			cycle: value.cycle,
			revision: value.revision,
			allowed_roles: [...value.allowedRoles]
		}),
		WORKFLOW_PRIVATE_ENVELOPE_CLOSE
	].join('\n')
}

/**
 * Remove Workflow bearer material from anything leaving the relay's private
 * orchestration boundary. An unterminated opening marker consumes the rest of the
 * string: losing display text is safer than exposing a capability after a truncated
 * database row or error. The loose-token pass also covers rendered tool arguments,
 * where the model necessarily repeats the capability outside its original envelope.
 */
export function scrubWorkflowSecrets(text: string): string {
	return text
		.replace(
			/<conductor-remote-workflow-private\b[^>]*>[\s\S]*?<\/conductor-remote-workflow-private>/gi,
			WORKFLOW_PRIVATE_REDACTION
		)
		.replace(/<conductor-remote-workflow-private\b[^>]*>[\s\S]*$/gi, WORKFLOW_PRIVATE_REDACTION)
		.replace(/(^|[^A-Za-z0-9_-])crwf_v\d+_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, '$1[Workflow capability hidden]')
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
 * notification names (src/notifications/notify.ts), and the workspace an MCP tool result names
 * (src/mcp/tools/). A notification that titles a workspace differently from the list
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
 * Parse one of Conductor's timestamps as an epoch.
 *
 * Its SQLite defaults/triggers use `datetime('now')`, which is UTC but serializes as
 * `YYYY-MM-DD HH:MM:SS` with no zone. Other writers use ISO strings ending in `Z`.
 * Browsers interpret the bare SQLite form as local time, making a fresh chat look two
 * hours old in Oslo during summer. Add the zone only to that exact database shape;
 * explicitly zoned ISO values and local wall-clock strings keep their native meaning.
 */
export function timestampMs(value: string): number {
	const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
	return Date.parse(sqliteUtc ? `${value.replace(' ', 'T')}Z` : value)
}

/**
 * A temporary `NEW` marker in Conductor's picker is a badge, not part of the
 * model name. The relay and phone use this value for the visible label and for
 * a later selection, so both sides must remove it in the same way.
 */
export function modelPickerLabel(label: string): string {
	return label.endsWith(' NEW') ? label.slice(0, -4) : label
}

/**
 * Shorten the provider namespace only for display, including a saved model's
 * OpenCode harness prefix. The full label remains the picker value.
 */
export function displayedModelPickerLabel(label: string): string {
	return modelPickerLabel(label)
		.replace(/^opencode:/i, '')
		.replace(/^opencode\//i, '')
		.replace(/^opencode-/i, '')
}

/** Compact model name: strip the `claude-`/date noise from Conductor's stored id. */
export function shortModel(model: string | null): string {
	if (!model) return ''
	return model
		.replace(/^claude-/, '')
		.replace(/-\d{8}$/, '')
		.replace(/-latest$/, '')
}

/** Letters and digits alone: a stored id and picker label agree on nothing else. */
const modelAlnum = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Drop the context-window suffix Conductor sometimes omits from a picker label. */
const contextlessModel = (name: string) => modelAlnum(name.replace(/[\s\-_]\d+[mk]$/i, ''))

/** `opus-4-8-1m` is one version, not two numbers: put the dot back. */
function modelVersionParts(parts: string[]): string[] {
	const out: string[] = []
	for (const part of parts) {
		const previous = out[out.length - 1]
		if (previous !== undefined && /^\d+$/.test(part) && /^\d[\d.]*$/.test(previous)) {
			out[out.length - 1] = `${previous}.${part}`
		} else out.push(part)
	}
	return out
}

/** Best-effort picker spelling for a built-in stored model id. */
function derivedModelLabel(id: string): string {
	const parts = modelVersionParts(id.split('-'))
	const title = (part: string) => {
		if (!part) return ''
		return part.toLowerCase() === '1m' ? '1M' : part[0].toUpperCase() + part.slice(1)
	}
	if (parts[0] === 'gpt' && parts[1]) return [parts[1], ...parts.slice(2).map(title)].join(' ')
	if (/^(opus|sonnet|haiku|fable)$/.test(parts[0] ?? '')) return parts.map(title).join(' ')
	return id
}

/** Resolve a stored model id to the exact label Conductor offered when possible. */
export function modelLabel(model: string | null, catalog: string[] = []): string {
	const raw = shortModel(model)
	if (!raw) return ''
	const pathTail = raw.split('/').pop() ?? raw
	const id = pathTail.split(':').pop() ?? pathTail
	const key = modelAlnum(id)
	if (key) {
		const exact = catalog.find(label => modelAlnum(label) === key)
		if (exact) return exact
		const near = catalog.filter(label => contextlessModel(label) === contextlessModel(id))
		if (near.length === 1) return near[0]
	}
	return derivedModelLabel(id)
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

/** The value Conductor persists in `sessions.agent_type` for a picker label. */
export function modelAgentType(model: string): string | undefined {
	const provider = modelProvider(model)
	if (provider === 'Anthropic') return 'claude'
	if (provider === 'OpenAI') return 'codex'
	if (provider === 'Cursor') return 'cursor'
	if (provider === 'OpenCode') return 'acp'
	return undefined
}

/**
 * Whether this harness can render a per-session reasoning control. Claude and
 * Codex still decide support model by model; Cursor and OpenCode do not expose
 * one in Conductor today, so a stored default in their session row is not a
 * capability signal.
 */
export function agentTypeCanExposeEffort(agentType: string | null | undefined): boolean {
	return agentType === 'claude' || agentType === 'codex'
}

/** Conductor currently exposes its Fast session control only for Claude and Codex. */
export function agentTypeCanExposeFastMode(agentType: string | null | undefined): boolean {
	return agentType === 'claude' || agentType === 'codex'
}

/** Whether one exact picker label appears in any cached whole-menu snapshot. */
export function modelCatalogIncludes(model: string, groups: readonly { models: readonly string[] }[]): boolean {
	const wanted = modelPickerLabel(model)
	return groups.some(group => group.models.some(candidate => modelPickerLabel(candidate) === wanted))
}

/**
 * Return the latest observed menu, ignoring groups learned only from selections.
 * A menu can expose only some providers; use currentModelCatalog for role choices.
 */
export function newestModelSnapshot<
	T extends { models: readonly string[]; updatedAt: number; snapshotAt?: number | null }
>(groups: readonly T[]): T | null {
	let newest: T | null = null
	for (const group of groups) {
		if (!group.models.some(model => modelPickerLabel(model).trim())) continue
		if (group.snapshotAt === null) continue
		const observedAt = group.snapshotAt ?? group.updatedAt
		const newestObservedAt = newest ? (newest.snapshotAt ?? newest.updatedAt) : -1
		if (!newest || observedAt >= newestObservedAt) newest = group
	}
	return newest
}

/**
 * Only an explicit whole-menu observation can retire a provider's older labels.
 * Legacy entries have unknown provenance: successful selections used to look like
 * menus too. They and known partial entries prove individual choices, never absence
 * of other choices. A later real menu supersedes that positive evidence per provider.
 * agentType names the chat that exposed the menu, not every model's provider.
 */
export function currentModelCatalog(
	groups: readonly {
		models: readonly string[]
		updatedAt: number
		snapshotAt?: number | null
		snapshotModels?: readonly string[]
		selections?: readonly { model: string; selectedAt: number }[]
	}[]
): string[] {
	const providers = new Map<string, { observedAt: number; models: string[] }>()
	for (const group of groups) {
		if (group.snapshotAt == null) continue
		const observedAt = group.snapshotAt
		for (const provider of groupModelPickerLabels([...(group.snapshotModels ?? group.models)])) {
			const current = providers.get(provider.label)
			if (!current || observedAt >= current.observedAt) {
				providers.set(provider.label, { observedAt, models: provider.models })
			}
		}
	}
	const models = new Set([...providers.values()].flatMap(provider => provider.models))
	for (const group of groups) {
		const selections =
			group.selections ??
			(group.snapshotAt == null ? group.models.map(model => ({ model, selectedAt: group.updatedAt })) : [])
		for (const selection of selections) {
			const model = modelPickerLabel(selection.model).trim()
			if (!model) continue
			const menu = providers.get(modelProvider(model))
			if (!menu || selection.selectedAt > menu.observedAt) models.add(model)
		}
	}
	return [...models].sort((a, b) => a.localeCompare(b))
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

/** A route may return either the long-standing string error or a typed domain error. */
export function responseErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === 'string' && error.trim()) return error
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string' && message.trim()) return message
	}
	return fallback
}

/**
 * Markers the relay wraps search hits in (src/search/worker.ts, via FTS5 `snippet()`). They
 * are control characters, so they must never reach the DOM: an unsplit snippet renders
 * as invisible garbage between the words it was meant to emphasise.
 */
export const HIT_OPEN = '\u0001'
export const HIT_CLOSE = '\u0002'

/**
 * OpenAI's built-in Realtime voices, in the order the phone presents them. The
 * two voices OpenAI recommends for quality lead the list; every value is shared
 * with the relay so a stale or hand-written client cannot ask it to configure an
 * arbitrary voice id.
 */
export const OPENAI_REALTIME_VOICES = [
	'marin',
	'cedar',
	'alloy',
	'ash',
	'ballad',
	'coral',
	'echo',
	'sage',
	'shimmer',
	'verse'
] as const

export type OpenAIRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number]

/** The deliberately small language picker for the first voice surface. */
export const VOICE_LANGUAGES = ['auto', 'no', 'en'] as const
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]

export function isOpenAIRealtimeVoice(value: unknown): value is OpenAIRealtimeVoice {
	return typeof value === 'string' && (OPENAI_REALTIME_VOICES as readonly string[]).includes(value)
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
	return typeof value === 'string' && (VOICE_LANGUAGES as readonly string[]).includes(value)
}

/** Realtime's speech-speed range, shared by the browser, call API, and CLI setting. */
export function isVoiceSpeed(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 1.5
}

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

/** Conductor's attachment syntax encodes the whole relative path, including slashes. */
export function attachmentToken(name: string, relPath: string): string {
	return `@⟦${name}⟧(${encodeURIComponent(relPath)})`
}

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

/** Raster formats browsers can display without executing document content. */
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'])

function fileExtension(filePath: string): string | null {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	return dot === -1 ? null : name.slice(dot).toLowerCase()
}

/** True for a file extension the relay's source preview accepts. */
export function isPreviewableSource(filePath: string): boolean {
	const extension = fileExtension(filePath)
	return extension !== null && SOURCE_EXTENSIONS.has(extension)
}

/** True for a raster image the relay may return to an authenticated browser. */
export function isPreviewableImage(filePath: string): boolean {
	const extension = fileExtension(filePath)
	return extension !== null && IMAGE_EXTENSIONS.has(extension)
}

/**
 * A transcript row that carries a tool's *output* rather than the call that produced it.
 *
 * The two are separate `session_messages` rows and reach the phone as separate entries
 * (src/transcript/parser.ts), so three places have to agree on which is which: the phone folds
 * a result onto its call, a rendered transcript prints the call and leaves the output
 * behind, and `read_chat` does the same for an agent. Structural, because each of them
 * holds a slightly different view of the same row.
 */
export function isToolResult(e: { role: string; tool?: string; output?: string }): boolean {
	return e.role === 'tool' && !e.tool && e.output !== undefined
}

/**
 * The sentence every locked-Mac refusal starts with (src/writes/applescript/window.applescript), and
 * the one thing two sides must agree it means.
 *
 * The relay decides control flow on it — `lockBlocked` (src/writes/guards.ts) parks the prompt
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
 * The diagnostic tail `windowEvidence()` (src/writes/applescript/window.applescript) appends to every
 * window and lock refusal: the window server's count, the lock state, every process
 * named Conductor with its window count, and the menu bar titles.
 *
 * It exists to separate "genuinely windowless" from "we are addressing the wrong
 * process", which is a question for the relay's log. It reached the phone as well,
 * where a tap on Fork against a locked Mac answered with four lines of red text ending
 * in "[menus: Apple, Conductor, File, Edit, View, Window, Help]" and nothing to act on.
 * So `json()` in src/http/services/responses.ts cuts it on the way out and logs the full text instead.
 *
 * Anchored on our own format: the whole tail is one run of bracketed groups that starts
 * at "[window server:", so a single cut takes all of it and never touches a message
 * that carries none.
 */
export function withoutWindowEvidence(error: string): string {
	return error.replace(/\s*\[window server:.*$/s, '').trim()
}

/**
 * Only diagnostic-bearing wire fields lose the AX/window-server tail. Relay log
 * entries use `text`, so they retain the evidence the phone's log viewer needs.
 */
export function withoutClientWindowEvidence(value: string, field?: string): string {
	return field === 'error' || field === 'message' || field === 'reason' ? withoutWindowEvidence(value) : value
}

/**
 * Header naming the push device that sent a request, so the relay can tell which chat
 * that device has on screen and skip notifying it about that one chat (src/notifications/notify.ts).
 *
 * It rides the transcript poll, which is already a per-second heartbeat for exactly the
 * chat being read and for no other, so this costs no request and no timer. Declared here
 * rather than spelled twice because a typo would be silent in both directions: the relay
 * would simply never learn what is on screen, and every notification would keep arriving
 * as it does today.
 */
export const VIEWING_HEADER = 'x-relay-device'

// ── rendering ───────────────────────────────────────────────────────────────────

/**
 * What a rendered transcript carries beyond the prose.
 *
 * The base is what Conductor's own "Copy concise transcript" produces: the user's
 * prompts and the agent's replies, verbatim, with a marker where anything was left
 * out. The two flags are the cuts Conductor cannot make. Its concise copy drops
 * thinking, which is the half of a long chat that explains *why*, and its full copy
 * brings the tool churn back with it — 98.8% of the bytes and the least re-readable
 * part. `include_tools` on `read_chat` already means exactly this, so the words are
 * reused rather than invented.
 */
export interface TranscriptFormat {
	thinking: boolean
	tools: boolean
}

/** What a render left out, so the caller can say so instead of implying completeness. */
export interface TranscriptElisions {
	thinking: number
	tools: number
}

const HEADINGS: Record<TranscriptEntry['role'], string> = {
	user: 'User',
	assistant: 'Assistant',
	thinking: 'Thinking',
	tool: 'Tools',
	system: 'System'
}

/** One tool row per line, the shape `read_chat` prints: what it did, then what it did it to. */
function toolLine(e: TranscriptEntry): string {
	if (e.error) return `- [error] ${scrubWorkflowSecrets(e.text)}`
	return `- [${scrubWorkflowSecrets(e.tool ?? 'tool')}] ${scrubWorkflowSecrets(e.text)}${e.detail ? ` — \`${scrubWorkflowSecrets(e.detail)}\`` : ''}`
}

export function plural(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? '' : 's'}`
}

/**
 * Cut a transcript at one message, that message included — a fork from an earlier point.
 *
 * The cut is made on the rowid rather than on a position, because that is the granularity
 * every pointer into a chat already has: `read_chat`'s cursor is a rowid, and one source
 * row yields several entries (the reasoning, the prose, the tool calls it made) that belong
 * to the same message and have to cross together.
 *
 * Null means no message here carries that rowid — a cursor from a different chat, or one
 * past the end of this one. Copying the whole chat in that case is the silent failure this
 * exists to prevent: a transcript that stops at the wrong place reads exactly like one that
 * stops where it was asked to.
 */
export function transcriptThrough(
	entries: TranscriptEntry[],
	rowid: number
): { entries: TranscriptEntry[]; later: number } | null {
	if (!entries.some(entry => entry.rowid === rowid)) return null
	const kept = entries.filter(entry => entry.rowid <= rowid)
	return { entries: kept, later: entries.length - kept.length }
}

/**
 * Keep one source message and nothing around it.
 *
 * One `session_messages` row can produce several transcript entries — prose split by
 * reasoning or tool calls — so selecting by rowid keeps them together. Treating the
 * last rendered bubble as the message would silently lose the other prose fragments.
 */
export function transcriptMessage(
	entries: TranscriptEntry[],
	rowid: number
): { entries: TranscriptEntry[]; earlier: number; later: number } | null {
	const first = entries.findIndex(entry => entry.rowid === rowid)
	if (first < 0) return null
	const kept = entries.filter(entry => entry.rowid === rowid)
	const last = entries.findLastIndex(entry => entry.rowid === rowid)
	return { entries: kept, earlier: first, later: entries.length - last - 1 }
}

/**
 * A chat as markdown, in Conductor's own transcript layout.
 *
 * The layout is copied from the files Conductor writes (`Transcript of <chat>.md`):
 * an `##` heading per role, prose verbatim under it, and an elision marker for what
 * was dropped. The heading comes *before* the marker — a run of tool calls between a
 * prompt and its answer prints as `## Assistant`, then the marker, then the reply —
 * which is what makes the result read like Conductor's own file rather than a log.
 *
 * The marker says what kind of thing went missing rather than only how many, because
 * this render is configurable and Conductor's is not: "12 tool calls elided" tells
 * you a flag was off, where a bare count reads as noise nobody wanted.
 *
 * `system` rows are always kept. They are rare, short, and one of them is how a
 * cancelled turn ends ("aborted by user") — the single line that explains why an
 * answer stops mid-thought, and dropping it would leave the next agent to guess.
 */
export function renderTranscript(
	entries: TranscriptEntry[],
	format: TranscriptFormat
): { text: string; kept: number; elided: TranscriptElisions } {
	const out: string[] = []
	const elided: TranscriptElisions = { thinking: 0, tools: 0 }
	const pending: TranscriptElisions = { thinking: 0, tools: 0 }
	let heading: string | null = null
	let kept = 0

	const flushElisions = () => {
		const parts: string[] = []
		if (pending.tools) parts.push(plural(pending.tools, 'tool call'))
		if (pending.thinking) parts.push(plural(pending.thinking, 'thinking block'))
		pending.tools = 0
		pending.thinking = 0
		if (parts.length) out.push(`[${parts.join(', ')} elided]`)
	}

	for (const e of entries) {
		// A successful result is the output of the call printed just above it, and output is
		// the biggest half of a chat (src/search/coordinator.ts) as well as the least re-readable. So a
		// render carries the call and leaves the file dumps behind — this is not an elision
		// of a tool *call*, so it is not counted as one. A failure still prints: one line,
		// and it is often why the answer changed course.
		if (isToolResult(e) && !e.error) continue
		if (e.role === 'thinking' && !format.thinking) {
			pending.thinking++
			elided.thinking++
			continue
		}
		if (e.role === 'tool' && !format.tools) {
			pending.tools++
			elided.tools++
			continue
		}
		const want = HEADINGS[e.role]
		if (want !== heading) {
			out.push(`## ${want}`)
			heading = want
		}
		flushElisions()
		out.push(e.role === 'tool' ? toolLine(e) : scrubWorkflowSecrets(e.text))
		kept++
	}
	// Anything dropped after the last kept entry still has to be admitted to.
	flushElisions()

	// Tool rows are a list, so consecutive ones share a paragraph; everything else is
	// separated by a blank line, which is what makes the markdown render as prose.
	const text = out
		.map((line, i) => (line.startsWith('- ') && out[i + 1]?.startsWith('- ') ? `${line}\n` : `${line}\n\n`))
		.join('')
		.trim()
	return { text: `${text}\n`, kept, elided }
}
