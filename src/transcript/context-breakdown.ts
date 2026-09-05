/**
 * Provider-neutral estimates for the context meter shown on a chat tab.
 *
 * Conductor persists the provider's exact total, but not its category accounting.
 * The durable SDK frames still preserve the useful boundaries — visible prose,
 * reasoning, and tool traffic — so those three can be estimated from UTF-8 size and
 * the unaccounted remainder can be named honestly as initial context.
 */

export interface ContextMessageRow {
	role: string | null
	content: string | null
}

export interface ContextCategories {
	/** System/developer prompts, instructions, tool definitions, attachments, summaries, and protocol overhead. */
	initial: number
	/** User prompts plus visible assistant prose. */
	chat: number
	/** Provider reasoning/thinking blocks, excluding opaque signatures. */
	thinking: number
	/** Tool calls and their results. */
	tools: number
}

export interface ContextBreakdown {
	/** The provider-owned total Conductor persisted for the last completed turn. */
	totalTokens: number
	usedPercent: number | null
	/** Whether the active window follows at least one compaction boundary. */
	compacted: boolean
	categories: ContextCategories
	/** Approximate attachment sizes for the fork choices that copy the whole chat. */
	forkTokens: {
		concise: number
		reasoning: number
		full: number
	}
}

interface FrameBlock {
	type?: unknown
}

interface Frame {
	type?: unknown
	subtype?: unknown
	parent_tool_use_id?: unknown
	message?: { content?: unknown }
}

interface ParsedRow extends ContextMessageRow {
	frame: Frame | null
}

const BYTES_PER_TOKEN = 4

/** A deliberately dependency-free approximation shared with fork payload sizing. */
export function estimateTextTokens(text: string): number {
	return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN) : 0
}

export function parseContextFrame(row: ContextMessageRow): Frame | null {
	const content = row.content ?? ''
	if (!content.startsWith('{')) return null
	try {
		const parsed = JSON.parse(content) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
		const frame = parsed as Frame
		// Human prompts are allowed to be JSON too. A provider message frame has typed
		// content blocks; the remaining recognized frame types are SDK bookkeeping.
		// Requiring one of those shapes keeps `{ "task": "inspect this" }` in chat.
		if ((frame.type === 'assistant' || frame.type === 'user') && Array.isArray(frame.message?.content)) return frame
		return frame.type === 'system' || frame.type === 'result' || frame.type === 'error' ? frame : null
	} catch {
		return null
	}
}

function isRootFrame(frame: Frame | null): boolean {
	return !!frame && !frame.parent_tool_use_id
}

function isCompactBoundary(frame: Frame | null): boolean {
	return isRootFrame(frame) && frame?.type === 'system' && frame.subtype === 'compact_boundary'
}

/**
 * Count a JSON block without charging opaque signatures or base64 image bytes as
 * ordinary text. Providers account for those specially; treating base64 as prose can
 * turn one screenshot into hundreds of thousands of imaginary tool tokens.
 */
export function contextBlockBytes(block: unknown): number {
	function visibleValue(this: { type?: unknown; mimeType?: unknown }, key: string, value: unknown): unknown {
		if (key === 'signature' || key === 'encrypted_content') return undefined
		if (typeof value === 'string' && /^data:[^;,]+;base64,/i.test(value)) return '[binary data]'
		if (key === 'data' && typeof value === 'string' && ['base64', 'image', 'audio'].includes(String(this.type))) {
			return '[binary data]'
		}
		if (key === 'blob' && typeof value === 'string' && typeof this.mimeType === 'string') return '[binary data]'
		// Codex often saves an MCP result as serialized JSON inside the tool_result
		// string. Its image.data is still binary, even though the outer frame looks
		// textual. Preserve ordinary JSON formatting unless a payload was stripped.
		if (
			key === 'content' &&
			this.type === 'tool_result' &&
			typeof value === 'string' &&
			(/"(?:data|blob|signature|encrypted_content)"\s*:/.test(value) || /data:[^;,]+;base64,/i.test(value))
		) {
			try {
				let changed = false
				const cleaned = JSON.stringify(JSON.parse(value), function (nestedKey, nestedValue: unknown) {
					const visible = visibleValue.call(this, nestedKey, nestedValue)
					if (visible !== nestedValue) changed = true
					return visible
				})
				if (changed) return cleaned
			} catch {
				// Ordinary tool text need not be JSON.
			}
		}
		return value
	}
	const json = JSON.stringify(block, visibleValue)
	return json ? Buffer.byteLength(json, 'utf8') : 0
}

function fittedCategories(bytes: Omit<ContextCategories, 'initial'>, totalTokens: number): ContextCategories {
	const keys = ['chat', 'thinking', 'tools'] as const
	const estimated = Object.fromEntries(keys.map(key => [key, Math.ceil(bytes[key] / BYTES_PER_TOKEN)])) as Record<
		(typeof keys)[number],
		number
	>
	const visible = keys.reduce((sum, key) => sum + estimated[key], 0)
	if (visible <= totalTokens) return { initial: totalTokens - visible, ...estimated }
	if (visible === 0 || totalTokens === 0) return { initial: 0, chat: 0, thinking: 0, tools: 0 }

	// A byte heuristic can overshoot a provider tokenizer. Preserve the measured total
	// and the estimated proportions rather than drawing a bar wider than its context.
	const scale = totalTokens / visible
	const portions = keys.map(key => {
		const exact = estimated[key] * scale
		return { key, value: Math.floor(exact), fraction: exact - Math.floor(exact) }
	})
	let left = totalTokens - portions.reduce((sum, portion) => sum + portion.value, 0)
	for (const portion of [...portions].sort((a, b) => b.fraction - a.fraction)) {
		if (left-- <= 0) break
		portion.value++
	}
	const scaled = Object.fromEntries(portions.map(portion => [portion.key, portion.value])) as Record<
		(typeof keys)[number],
		number
	>
	return { initial: 0, ...scaled }
}

/**
 * Estimate the active categories represented by Conductor's last completed turn.
 *
 * Rows from a turn currently streaming are deliberately excluded: the exact total on
 * `sessions` is updated by its final `result` frame, so mixing newer partial frames
 * into an older total would produce a plausible-looking but internally inconsistent
 * answer. Likewise, only rows after the latest completed compaction boundary remain in
 * the active model window; its generated summary lands in the `initial` remainder.
 */
export function estimateContextCategories(
	rows: ContextMessageRow[],
	totalTokens: number
): { categories: ContextCategories; compacted: boolean } {
	const total = Number.isFinite(totalTokens) ? Math.max(0, Math.round(totalTokens)) : 0
	const parsed: ParsedRow[] = rows.map(row => ({ ...row, frame: parseContextFrame(row) }))
	// A Claude subagent's frames are copied into its parent chat. Its own result and
	// compaction markers describe the child's window, not the session meter beside this
	// tab, so only root frames may define the completed cut or reset the active history.
	const lastResult = parsed.findLastIndex(row => isRootFrame(row.frame) && row.frame?.type === 'result')
	const completedThrough = lastResult >= 0 ? lastResult : parsed.length - 1
	let boundary = -1
	for (let i = 0; i <= completedThrough; i++) {
		if (isCompactBoundary(parsed[i].frame)) boundary = i
	}

	const bytes = { chat: 0, thinking: 0, tools: 0 }
	for (let i = boundary + 1; i <= completedThrough; i++) {
		const row = parsed[i]
		const content = row.content ?? ''
		const frame = row.frame
		// Conductor mirrors a delegated child's SDK frames into its parent transcript
		// for display. The parent model sees only its own subagent tool call and the
		// resulting summary, not every internal thought/tool step from the child.
		if (frame?.parent_tool_use_id) continue
		if (!frame) {
			// Real user prompts are plain rows. A malformed assistant frame is not useful
			// category evidence and remains part of the initial/unattributed remainder.
			if (row.role === 'user' || !content.startsWith('{')) bytes.chat += Buffer.byteLength(content, 'utf8')
			continue
		}

		const blocks = frame.message?.content
		if (!Array.isArray(blocks)) continue
		for (const raw of blocks as FrameBlock[]) {
			if (!raw || typeof raw !== 'object') continue
			const type = typeof raw.type === 'string' ? raw.type : ''
			const size = contextBlockBytes(raw)
			if (type === 'tool_use' || type === 'tool_result') bytes.tools += size
			else if (/thinking|reasoning/.test(type)) bytes.thinking += size
			else if ((type === 'text' || type === 'output_text') && frame.type !== 'user') bytes.chat += size
		}
	}

	return { categories: fittedCategories(bytes, total), compacted: boundary >= 0 }
}
