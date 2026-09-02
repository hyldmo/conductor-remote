/**
 * Speech bounding — the two helpers that keep a spoken field inside its budget.
 *
 * The voice orchestrator's caps are enforced in relay code rather than in the model's
 * prompt (design ▸ Constraints), because a prompt that asks for brevity is a request and
 * a cap is a guarantee. Both callers here are budgets someone else set: a push body has
 * a payload ceiling, and a roll call has an attention ceiling — roughly 600 characters
 * before a listener stops holding it.
 *
 * `clipExact` is named for the property `notify.ts`'s private `clip` did not have: the
 * ellipsis counts against the cap, so the result is never longer than what was asked for.
 * The old helper returned `max + 1` characters, which was invisible against a byte budget
 * carrying eight bytes of slack and would not be invisible against a spoken one.
 *
 * Stdlib-free on purpose, so a fixture test needs nothing but the function.
 */

/** Cut back to the last word boundary when one is close enough to the cut to be worth it. */
const WORD_LOOKBACK = 0.2

/**
 * At most `max` characters, ellipsis included. Prefers a word boundary near the cut, so a
 * clipped sentence ends on a word rather than mid-syllable, which matters when it is read
 * aloud rather than shown.
 */
export function clipExact(text: string, max: number): string {
	if (max <= 0) return ''
	if (text.length <= max) return text
	if (max === 1) return '…'
	const hard = text.slice(0, max - 1)
	// Only back off when the cut actually lands inside a word. A cut that already falls on a
	// space has nothing to repair, and backing off anyway throws away a whole word for free.
	const splitsWord = !/\s/.test(text.charAt(max - 1))
	const space = hard.lastIndexOf(' ')
	const body = splitsWord && space >= Math.floor((max - 1) * (1 - WORD_LOOKBACK)) ? hard.slice(0, space) : hard
	return `${body.trimEnd()}…`
}

/**
 * One spoken line: code fences become an ellipsis, every run of whitespace becomes one
 * space, then the whole thing is clipped. A transcript entry is written to be read on a
 * screen, so its newlines and fences are layout that speech has no use for.
 */
export function oneLine(text: string, max: number): string {
	return clipExact(
		text
			.replace(/```[\s\S]*?```/g, '…')
			.replace(/\s+/g, ' ')
			.trim(),
		max
	)
}
