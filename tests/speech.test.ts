/**
 * The speech caps (`src/speech.ts`).
 *
 * Worth pinning because both failure directions are silent. A clip that overruns its cap
 * by the ellipsis is invisible against `notify.ts`'s byte budget, which carries eight
 * bytes of slack, and becomes a real overrun the moment a voice field with an exact
 * character budget uses the same helper — which is the whole reason the function moved
 * here and gained the `Exact` in its name. A clip that cuts mid-word is the opposite: it
 * typechecks, it fits, and it only sounds wrong, which no test that counts characters
 * would ever catch. So the invariant is asserted absolutely and the word boundary is
 * asserted separately, since the boundary is a preference that must never win over the cap.
 */
import { describe, expect, it } from 'vitest'
import { clipExact, oneLine } from '../src/speech.ts'

const LONG = 'the quick brown fox jumps over the lazy dog and keeps running well past the cap'

describe('clipExact', () => {
	it('never returns more characters than the cap, ellipsis included', () => {
		for (let max = 1; max <= LONG.length + 2; max++) expect(clipExact(LONG, max).length).toBeLessThanOrEqual(max)
	})

	it('leaves text that already fits completely alone', () => {
		expect(clipExact('short', 20)).toBe('short')
		expect(clipExact('exactly-ten', 11)).toBe('exactly-ten')
	})

	it('ends on a word boundary when one is near the cut', () => {
		const out = clipExact(LONG, 20)
		expect(out.endsWith('…')).toBe(true)
		expect(out.slice(0, -1)).not.toMatch(/\s$/)
		expect(LONG.startsWith(out.slice(0, -1))).toBe(true)
		expect(out).toBe('the quick brown fox…')
	})

	it('cuts hard rather than overshooting when no boundary is near', () => {
		expect(clipExact('supercalifragilistic', 10)).toBe('supercali…')
	})

	it('degrades sanely at the edges', () => {
		expect(clipExact(LONG, 0)).toBe('')
		expect(clipExact(LONG, -5)).toBe('')
		expect(clipExact(LONG, 1)).toBe('…')
		expect(clipExact('', 10)).toBe('')
	})
})

describe('oneLine', () => {
	it('collapses newlines and whitespace runs to single spaces', () => {
		expect(oneLine('two\n\nlines   apart', 100)).toBe('two lines apart')
	})

	it('replaces a fenced block rather than reading it aloud', () => {
		expect(oneLine('before ```js\nconst x = 1\n``` after', 100)).toBe('before … after')
	})

	it('still honours the cap after collapsing', () => {
		expect(oneLine(`  ${LONG}  `, 20).length).toBeLessThanOrEqual(20)
	})
})
