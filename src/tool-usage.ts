import { contextBlockBytes, parseContextFrame } from './context-breakdown.ts'
import type { ConductorDb } from './db.ts'

export type ToolUsageRange = '24h' | '7d' | '30d'

export interface ToolUsageRow {
	/** Null when Conductor saved a result without its matching call. */
	name: string | null
	calls: number
	inputTokens: number
	outputTokens: number
	totalTokens: number
	largestCallTokens: number
}

export interface ToolUsageProvider {
	provider: string
	sessionCount: number
	tools: ToolUsageRow[]
}

export interface ToolUsageSnapshot {
	range: ToolUsageRange
	/** UTC ISO timestamps bounding the saved traffic, not provider billing windows. */
	since: string
	until: string
	fetchedAt: number
	providers: ToolUsageProvider[]
}

interface ToolMessageRow {
	rowid: number
	role: string | null
	content: string | null
	in_range: number
}

interface ToolCall {
	name: string | null
	inputBytes: number
	outputBytes: number
}

export function isToolUsageRange(value: string): value is ToolUsageRange {
	return value === '24h' || value === '7d' || value === '30d'
}

/**
 * Join calls and results within one chat, never across chats with reused call IDs.
 * Older calls supply names only, so a result crossing the window's start still has
 * an owner. Repeated snapshots of a call/result use the largest saved payload once.
 * No prompts, arguments, or output text leave this accumulator.
 */
export class ToolUsageAccumulator {
	private readonly calls = new Map<string, ToolCall>()

	add(row: ToolMessageRow): void {
		const frame = parseContextFrame(row)
		if (!frame || frame.parent_tool_use_id || !Array.isArray(frame.message?.content)) return
		for (const [index, raw] of frame.message.content.entries()) {
			if (!raw || typeof raw !== 'object') continue
			const block = raw as Record<string, unknown>
			const isCall = block.type === 'tool_use'
			if (!isCall && (block.type !== 'tool_result' || !row.in_range)) continue
			const rawId = isCall ? block.id : block.tool_use_id
			const id = typeof rawId === 'string' && rawId ? `id:${rawId}` : `row:${row.rowid}:${index}`
			const call = this.calls.get(id) ?? { name: null, inputBytes: 0, outputBytes: 0 }
			if (isCall && typeof block.name === 'string' && block.name.trim()) call.name = block.name.trim()
			if (row.in_range) {
				const key = isCall ? 'inputBytes' : 'outputBytes'
				call[key] = Math.max(call[key], contextBlockBytes(block))
			}
			this.calls.set(id, call)
		}
	}

	tools(): ToolUsageRow[] {
		const tools = new Map<string | null, ToolUsageRow>()
		for (const call of this.calls.values()) {
			if (!call.inputBytes && !call.outputBytes) continue
			const inputTokens = Math.ceil(call.inputBytes / 4)
			const outputTokens = Math.ceil(call.outputBytes / 4)
			mergeToolUsage(tools, {
				name: call.name,
				calls: 1,
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
				largestCallTokens: inputTokens + outputTokens
			})
		}
		return [...tools.values()].sort((a, b) => b.totalTokens - a.totalTokens)
	}
}

function mergeToolUsage(tools: Map<string | null, ToolUsageRow>, row: ToolUsageRow): void {
	const previous = tools.get(row.name)
	if (!previous) {
		tools.set(row.name, { ...row })
		return
	}
	previous.calls += row.calls
	previous.inputTokens += row.inputTokens
	previous.outputTokens += row.outputTokens
	previous.totalTokens += row.totalTokens
	previous.largestCallTokens = Math.max(previous.largestCallTokens, row.largestCallTokens)
}

/** On-demand worker read. Includes archived workspaces and hidden chats. */
export function readToolUsage(db: ConductorDb, range: ToolUsageRange, now = Date.now()): ToolUsageSnapshot {
	const days = range === '24h' ? 1 : range === '7d' ? 7 : 30
	const since = new Date(now - days * 86_400_000).toISOString()
	const until = new Date(now).toISOString()
	const sessions = db.query<{ id: string; agent_type: string | null }>(
		`SELECT id, agent_type FROM sessions WHERE julianday(updated_at) >= julianday(?)`,
		[since]
	)
	const providers = new Map<string, { sessionCount: number; tools: Map<string | null, ToolUsageRow> }>()
	for (const session of sessions) {
		const accumulator = new ToolUsageAccumulator()
		// Conductor has a session_id index, but no global message-time index. Scope
		// each scan to a recently active chat and keep large historical results out of
		// JS. Prior calls are retained only to name results that cross the lower bound.
		// julianday handles Conductor's mixture of SQLite and ISO timestamp formats.
		const rows = db.query<ToolMessageRow>(
			`SELECT rowid, role, content, julianday(created_at) >= julianday(?) AS in_range
			 FROM session_messages
			 WHERE session_id = ? AND julianday(created_at) <= julianday(?)
			   AND (instr(content, '"tool_use"') > 0
			        OR (julianday(created_at) >= julianday(?) AND instr(content, '"tool_result"') > 0))
			 ORDER BY rowid ASC`,
			[since, session.id, until, since]
		)
		for (const row of rows) accumulator.add(row)
		const tools = accumulator.tools()
		if (!tools.length) continue
		const provider = session.agent_type === 'acp' ? 'opencode' : (session.agent_type ?? 'unknown')
		const group = providers.get(provider) ?? { sessionCount: 0, tools: new Map<string | null, ToolUsageRow>() }
		group.sessionCount++
		for (const tool of tools) mergeToolUsage(group.tools, tool)
		providers.set(provider, group)
	}
	return {
		range,
		since,
		until,
		fetchedAt: now,
		providers: [...providers].map(([provider, group]) => ({
			provider,
			sessionCount: group.sessionCount,
			tools: [...group.tools.values()].sort((a, b) => b.totalTokens - a.totalTokens)
		}))
	}
}
