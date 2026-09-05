import type { TranscriptNode } from '../../lib/transcript/tree.ts'
import type { TranscriptEntry } from '../../lib/types.ts'

type Row =
	| { kind: 'entry'; key: string; node: TranscriptNode }
	| { kind: 'steps'; key: string; nodes: TranscriptNode[] }

export const rowKey = (e: TranscriptEntry) => `${e.rowid}-${e.id}`

/**
 * Fold each run of the agent's own work (thinking + tool calls) between two
 * spoken messages into one collapsible group — a turn is mostly plumbing, and on
 * a phone that plumbing buries the prose. A run of one stays inline: wrapping a
 * single row in a disclosure hides it without saving anything.
 */
export function groupSteps(nodes: TranscriptNode[]): Row[] {
	const rows: Row[] = []
	let run: TranscriptNode[] = []
	const flush = () => {
		if (run.length > 1) rows.push({ kind: 'steps', key: `steps-${rowKey(run[0].e)}`, nodes: run })
		else for (const node of run) rows.push({ kind: 'entry', key: rowKey(node.e), node })
		run = []
	}
	for (const node of nodes) {
		// An Agent call is already a named doorway to its child subtab. Folding that into
		// an opaque "N steps" disclosure would hide the feature.
		if (!node.e.subagentLabel && (node.e.role === 'tool' || node.e.role === 'thinking')) {
			run.push(node)
			continue
		}
		flush()
		rows.push({ kind: 'entry', key: rowKey(node.e), node })
	}
	flush()
	return rows
}
