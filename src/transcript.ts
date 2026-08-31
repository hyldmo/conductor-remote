/**
 * Conductor stores each turn's raw Claude Code SDK stream JSON in
 * `session_messages.content`. User-typed prompts are stored as plain text.
 * This turns a row into compact, phone-renderable entries.
 *
 * Classification rule (verified against the whole DB): a JSON frame with
 * `type:"user"` is ALWAYS tool plumbing — every one of them carries
 * tool_result blocks, never the user's own words. Real prompts are the
 * plain-text rows. Never render an SDK user frame as a user bubble.
 */

import { isToolResult } from './shared.ts'

export interface TranscriptEntry {
	id: string
	rowid: number
	/** Display role: user | assistant | tool | thinking | system */
	role: 'user' | 'assistant' | 'tool' | 'thinking' | 'system'
	/** Human-readable text. For tool rows: the call's description, else the tool name. */
	text: string
	/** Tool name when role === 'tool'. */
	tool?: string
	/** Full mono secondary detail for tool rows (command, path, pattern, …). */
	detail?: string
	/**
	 * The SDK's `tool_use` id. Carried by the call and by the result answering it — the
	 * only thing that pairs the two, which sit in different `session_messages` rows.
	 */
	toolUseId?: string
	/** A tool result's output, clipped. The phone folds it onto the call row. */
	output?: string
	/** True when `output` is a unified diff (an edit's result), so the phone colours it. */
	diff?: boolean
	/** Images the result carried, as `GET /api/tool-images/:reference` references. */
	images?: string[]
	/** True when this row is a failed tool result. */
	error?: boolean
	ts: string
	/** True when the message is queued but not yet sent (queue_order set, sent_at null). */
	queued: boolean
}

interface RawRow {
	rowid: number
	id: string
	role: string | null
	content: string | null
	full_message: string | null
	created_at: string
	sent_at: string | null
	queue_order: number | null
}

interface SdkBlock {
	type: string
	text?: string
	thinking?: string
	name?: string
	input?: unknown
	content?: unknown
	is_error?: boolean
	/** On a `tool_use` block: the id its `tool_result` answers with. */
	id?: string
	/** On a `tool_result` block: the `tool_use` it answers. */
	tool_use_id?: string
}

/** One block of a `tool_result`'s content array. */
interface ResultBlock {
	type?: string
	text?: unknown
	/** `tool_reference`: the tool a search or a registry answered with. */
	tool_name?: unknown
	/** `image`: base64 bytes plus, usually, their media type. */
	source?: { type?: string; media_type?: unknown; data?: unknown }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Make tool details repo-relative: absolute worktree paths waste the whole line on a phone. */
function stripWorktree(s: string, worktree: string | null): string {
	if (!worktree) return s
	// Conductor prefixes commands with `cd <worktree>` (newline- or &&-joined) — drop the whole clause.
	if (s.startsWith(`cd ${worktree}`)) s = s.slice(`cd ${worktree}`.length).replace(/^\s*(&&)?\s*/, '')
	return s.replaceAll(`${worktree}/`, '').replaceAll(worktree, '.')
}

/**
 * Mirror Conductor's tool rows: the human description as the title (Bash always
 * has one), the primary input as mono detail. The phone truncates that detail in
 * the closed row and reveals this full value on demand. Tools without a recognizable
 * primary input get the title alone — dumping raw JSON is noise.
 */
function summarizeToolUse(name: string, input: unknown, worktree: string | null): { text: string; detail?: string } {
	if (!input || typeof input !== 'object') return { text: name }
	const o = input as Record<string, unknown>
	const text = str(o.description) ?? name
	const detail =
		str(o.command) ?? str(o.file_path) ?? str(o.path) ?? str(o.pattern) ?? str(o.url) ?? str(o.skill) ?? str(o.prompt)
	if (!detail || detail === text) return { text }
	return { text, detail: stripWorktree(detail, worktree) }
}

/**
 * How much of a tool's output travels to the phone.
 *
 * Output is the largest thing in the history — 799 MB of the 3,106 MB in
 * `session_messages.content` (see src/search.ts) — and a chat's first transcript fetch
 * carries the whole backlog at once, so this cap is what keeps opening a chat from
 * paying for every file the agent ever read. Measured over the two biggest chats on
 * this Mac: 335 results / 271 kB raw and 664 results / 1,732 kB raw, which this cap
 * brings down to 193 kB and 569 kB. What is past it is worth reading in Conductor.
 */
const MAX_OUTPUT_CHARS = 2000

/** What one `tool_result` says, in the three forms a phone can show. */
interface ResultOutput {
	text: string
	/** `text` is a unified diff, so it is rendered as one rather than as prose. */
	diff: boolean
	/** How many image blocks the result carried, in the order this row holds them. */
	images: number
}

/**
 * Read a tool result, whatever shape it came in.
 *
 * Measured over the 40,000 most recent result blocks on this Mac: 35,709 are a plain
 * string, 3,120 are Conductor's own edit result (`{status, diffString}`), 753 are text
 * blocks, 205 are `tool_reference` lists and 80 carry an image. Only the first and third
 * used to be read, so **3,917 results rendered as nothing at all** — an edit's diff, the
 * tools a search found, and every screenshot, each of them a step that looked like it
 * did nothing. An unknown shape falls back to its own JSON rather than to silence, which
 * is what keeps Conductor drift visible instead of blank.
 */
function resultOutput(content: unknown, worktree: string | null): ResultOutput {
	const plain = (text: string, diff = false): ResultOutput => ({
		text: clip(text.replace(/<\/?tool_use_error>/g, '').trim(), MAX_OUTPUT_CHARS),
		diff,
		images: 0
	})

	if (typeof content === 'string') return plain(content)

	if (Array.isArray(content)) {
		const said: string[] = []
		const tools: string[] = []
		let images = 0
		for (const raw of content as ResultBlock[]) {
			if (!raw || typeof raw !== 'object') continue
			if (raw.type === 'image') images++
			else if (str(raw.tool_name)) tools.push(str(raw.tool_name) as string)
			else if (typeof raw.text === 'string') said.push(raw.text)
		}
		// A tool_reference list is the whole answer of a tool search; naming them beats the
		// count, because which tools came back is the thing worth reading later.
		if (tools.length) said.push(`${plural(tools.length, 'tool')}: ${tools.join(', ')}`)
		return { ...plain(said.join('')), images }
	}

	if (content && typeof content === 'object') {
		const o = content as Record<string, unknown>
		// Conductor's edit result. The status names the file it wrote, so it is worth a line
		// of its own above the hunks — worktree-relative, like every other path here.
		const patch = str(o.diffString)
		if (patch) {
			const status = str(o.status)
			const head = status ? `${stripWorktree(status, worktree)}\n` : ''
			return plain(head + patch, true)
		}
		return plain(JSON.stringify(content))
	}

	return plain('')
}

/**
 * The images one row's tool results carry, in the order the transcript numbered them.
 *
 * The reference on an entry is `<rowid>.<n>`, and `n` counts image blocks across every
 * `tool_result` in that row — so this walk and the one in `parseMessage` must stay the
 * same walk, which is why they live in one file.
 */
export function toolImageAt(content: string, index: number): { mediaType: string; data: string } | null {
	let parsed: { message?: { content?: SdkBlock[] } }
	try {
		parsed = JSON.parse(content)
	} catch {
		return null
	}
	let seen = 0
	for (const b of parsed.message?.content ?? []) {
		if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue
		for (const raw of b.content as ResultBlock[]) {
			if (raw?.type !== 'image') continue
			if (seen++ !== index) continue
			const data = str(raw.source?.data)
			if (!data) return null
			return { mediaType: str(raw.source?.media_type) ?? sniffImageType(data), data }
		}
	}
	return null
}

/** Base64 magic bytes, for the image blocks that carry no `media_type`. */
function sniffImageType(base64: string): string {
	if (base64.startsWith('iVBOR')) return 'image/png'
	if (base64.startsWith('/9j/')) return 'image/jpeg'
	if (base64.startsWith('R0lGOD')) return 'image/gif'
	if (base64.startsWith('UklGR')) return 'image/webp'
	return 'application/octet-stream'
}

export function parseMessage(row: RawRow, worktree: string | null = null): TranscriptEntry[] {
	const queued = row.queue_order !== null && row.sent_at === null
	const base = { rowid: row.rowid, ts: row.created_at, queued }
	const content = row.content ?? ''

	// Plain user prompt (not SDK JSON) — the only source of real user bubbles.
	if (!content.startsWith('{')) {
		if (!content.trim()) return []
		return [{ ...base, id: row.id, role: 'user', text: content }]
	}

	let parsed: { type?: string; subtype?: string; message?: { content?: SdkBlock[] } }
	try {
		parsed = JSON.parse(content)
	} catch {
		return [{ ...base, id: row.id, role: 'system', text: clip(content, 200) }]
	}

	// Bookkeeping frames: hooks, init, token accounting, end-of-turn results.
	if (parsed.type === 'system' || parsed.type === 'result') return []

	// How a stopped turn ends: `{"type":"error","content":"aborted by user"}`, and it
	// carries no `message.content`, so without this it fell through to the raw-JSON
	// dump below. That was tolerable while stopping needed a Mac; the phone can do it
	// now (`POST /api/sessions/:id/stop`), so it is the last line of every stopped
	// chat. The SDK's own wording is kept rather than reworded — "aborted by user" is
	// already plain, and inventing a phrase here would drift from what the desktop shows.
	if (parsed.type === 'error') {
		const said = str((parsed as { content?: unknown }).content)
		if (said) return [{ ...base, id: row.id, role: 'system', text: clip(said, 200) }]
	}

	const blocks = parsed.message?.content
	if (!Array.isArray(blocks)) {
		if (parsed.type === 'user' || parsed.type === 'assistant') return []
		// Unknown frame shape — keep a dim raw dump so Conductor drift stays visible.
		return [{ ...base, id: row.id, role: 'system', text: clip(content, 200) }]
	}

	const entries: TranscriptEntry[] = []
	const push = (e: Pick<TranscriptEntry, 'role' | 'text'> & Partial<TranscriptEntry>) =>
		entries.push({ ...base, ...e, id: `${row.id}:${entries.length}` })

	// Images are numbered per row, because that is all a reference needs to find one again
	// (`toolImageAt`) and a row may hold several results.
	let imageIndex = 0
	let pending: string[] = []
	const flush = () => {
		const text = pending.join('\n').trim()
		if (text) push({ role: 'assistant', text })
		pending = []
	}

	for (const b of blocks) {
		if (b.type === 'text' && typeof b.text === 'string') {
			// Text inside an SDK user frame would be injected context, not the user.
			if (parsed.type !== 'user') pending.push(b.text)
		} else if (b.type === 'thinking') {
			flush()
			const text = str(b.thinking) ?? str(b.text)
			if (text) push({ role: 'thinking', text })
		} else if (b.type === 'tool_use' && typeof b.name === 'string') {
			flush()
			push({ role: 'tool', tool: b.name, toolUseId: str(b.id), ...summarizeToolUse(b.name, b.input, worktree) })
		} else if (b.type === 'tool_result') {
			// A result is written to a later row than the call it answers — anything slower than
			// the 1s poll lands a tick or more behind it — so it travels as its own entry naming
			// that call, and the phone folds the two together (web/src/lib/transcript-merge.ts).
			// Only a failure repeats the output as `text`, which is what an unpaired one renders
			// as. Repeating it for a success would send the biggest thing here twice: on the
			// largest chat on this Mac that second copy was 569 kB of a 2.0 MB transcript.
			flush()
			const read = resultOutput(b.content, worktree)
			// Bytes stay behind: a screenshot is ~100 kB of base64 in this row, and the phone
			// fetches one only when the step it belongs to is opened (routes ▸ toolImage).
			const images = Array.from({ length: read.images }, () => `${row.rowid}.${imageIndex++}`)
			const output = read.text || (b.is_error ? '(tool error)' : '')
			if (!output && !images.length) continue
			const result: Pick<TranscriptEntry, 'role' | 'text'> & Partial<TranscriptEntry> = {
				role: 'tool',
				text: b.is_error ? output : '',
				output,
				toolUseId: str(b.tool_use_id)
			}
			if (read.diff) result.diff = true
			if (images.length) result.images = images
			if (b.is_error) result.error = true
			push(result)
		}
	}
	flush()
	return entries
}

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
	if (e.error) return `- [error] ${e.text}`
	return `- [${e.tool ?? 'tool'}] ${e.text}${e.detail ? ` — \`${e.detail}\`` : ''}`
}

function plural(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? '' : 's'}`
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
		// the biggest half of a chat (src/search.ts) as well as the least re-readable. So a
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
		out.push(e.role === 'tool' ? toolLine(e) : e.text)
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
