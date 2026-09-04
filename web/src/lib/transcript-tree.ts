import type { TranscriptEntry } from './types.ts'

/** One visible transcript row and any delegated-agent rows that belong underneath it. */
export interface TranscriptNode {
	e: TranscriptEntry
	children: TranscriptNode[]
}

/** A selectable provider-native child inside one Conductor chat transcript. */
export interface TranscriptSubagent {
	id: string
	label: string
	node: TranscriptNode
}

/**
 * Rebuild Conductor's delegated-agent hierarchy from the SDK's durable parent ids.
 *
 * A subagent does not get a separate `sessions` row. Its frames are interleaved with
 * the parent chat and each carries `parent_tool_use_id`; the spawning Agent call carries
 * that value as its own `toolUseId`. Attaching by id rather than by adjacency is what
 * keeps a parent update, written while the child is still running, outside the rail.
 *
 * Unknown parents fail open: their entries remain at the top level instead of silently
 * disappearing when Conductor introduces a new agent tool shape.
 */
export function transcriptTree(entries: readonly TranscriptEntry[]): TranscriptNode[] {
	const agents = new Map<string, TranscriptEntry>()
	for (const entry of entries) {
		if (entry.subagentLabel && entry.toolUseId && !agents.has(entry.toolUseId)) agents.set(entry.toolUseId, entry)
	}

	const children = new Map<string, TranscriptEntry[]>()
	const attached = new Set<TranscriptEntry>()
	for (const entry of entries) {
		const parentId = entry.parentToolUseId
		const parent = parentId ? agents.get(parentId) : undefined
		if (!parent || parent === entry) continue
		const list = children.get(parentId as string) ?? []
		list.push(entry)
		children.set(parentId as string, list)
		attached.add(entry)
	}

	const build = (entry: TranscriptEntry, ancestors: ReadonlySet<string>): TranscriptNode => {
		const id = entry.toolUseId
		if (!id || ancestors.has(id)) return { e: entry, children: [] }
		const nextAncestors = new Set(ancestors)
		nextAncestors.add(id)
		return { e: entry, children: (children.get(id) ?? []).map(child => build(child, nextAncestors)) }
	}

	return entries.filter(entry => !attached.has(entry)).map(entry => build(entry, new Set()))
}

/**
 * Flatten every selectable agent call for the transcript's virtual child-tab strip.
 *
 * Native subagents share their parent's `sessions` row, so the spawning tool id is
 * their only durable address. Nested agents join the same strip: selecting one shows
 * exactly its own frame subtree while its parent remains the real chat tab above it.
 * A malformed call without an id stays visible in the parent transcript but cannot
 * become a tab whose selection would be impossible to restore.
 */
export function transcriptSubagents(nodes: readonly TranscriptNode[]): TranscriptSubagent[] {
	const found: TranscriptSubagent[] = []
	const seen = new Set<string>()
	const visit = (node: TranscriptNode) => {
		const id = node.e.toolUseId
		const label = node.e.subagentLabel
		if (id && label && !seen.has(id)) {
			seen.add(id)
			found.push({ id, label, node })
		}
		for (const child of node.children) visit(child)
	}
	for (const node of nodes) visit(node)
	return found.sort((a, b) => a.node.e.rowid - b.node.e.rowid || a.id.localeCompare(b.id))
}
