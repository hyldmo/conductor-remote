import { isToolResult } from '../../../src/shared.ts'
import type { TranscriptEntry } from './types.ts'

/**
 * Fold each tool result onto the call it answers.
 *
 * A call and its output are two `session_messages` rows, and the transcript is polled
 * with a rowid cursor, so anything slower than the 1s tick lands in a later fetch than
 * the row it belongs to. The relay therefore ships the result as its own entry naming
 * the call (`toolUseId`, src/transcript.ts) and the pairing happens here, against every
 * row already on screen rather than within one batch.
 *
 * Identity is the property this has to hold: every row re-renders when its entry object
 * changes and this runs on the 1s poll, so an untouched entry comes back as the same
 * object and only a call row that just gained output is rebuilt.
 *
 * An unpaired result belongs to a call this transcript never carried. A failure still
 * shows on its own — dropping it would read as a step that worked — while a success is
 * output with nothing to attach it to, so it goes.
 */
export function mergeEntries(
	prev: readonly TranscriptEntry[],
	incoming: readonly TranscriptEntry[]
): TranscriptEntry[] {
	const results = incoming.filter(e => isToolResult(e) && e.toolUseId)
	if (!results.length) return [...prev, ...incoming]

	const next = [...prev, ...incoming.filter(e => !isToolResult(e))]
	const calls = new Map<string, number>()
	next.forEach((e, i) => {
		if (e.tool && e.toolUseId && !calls.has(e.toolUseId)) calls.set(e.toolUseId, i)
	})
	for (const result of results) {
		const at = result.toolUseId ? calls.get(result.toolUseId) : undefined
		if (at === undefined) {
			if (result.error) next.push(result)
			continue
		}
		const call = next[at]
		next[at] = {
			...call,
			output: result.output,
			diff: result.diff,
			images: result.images,
			error: result.error ?? call.error
		}
	}
	return next
}
