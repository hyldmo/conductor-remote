import { afterEach, describe, expect, test } from 'vitest'
import { hasSelection, overSelection } from '../../web/src/lib/selection.ts'

/**
 * The two questions the phone's gesture handlers ask before they claim a touch. Both
 * failures are silent: answer "no selection" and selecting a word at the left margin
 * slides the sidebar out over it; answer "yes" too widely and an ordinary edge swipe
 * stops working with a stale selection somewhere on the page.
 */

type Rect = { left: number; right: number; top: number; bottom: number }

const stub = (text: string, rects: Rect[] = []) => {
	const range = { getClientRects: () => rects }
	const selection = {
		isCollapsed: text.length === 0,
		rangeCount: rects.length ? 1 : 0,
		getRangeAt: () => range,
		toString: () => text
	}
	// biome-ignore lint/suspicious/noExplicitAny: a hand-built Selection, only as wide as the code reads
	;(globalThis as any).window = { getSelection: () => selection }
}

afterEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: undoing the stub above
	;(globalThis as any).window = undefined
})

describe('hasSelection', () => {
	test('a caret is not a selection', () => {
		stub('')
		expect(hasSelection()).toBe(false)
	})

	test('selected text is', () => {
		stub('a word')
		expect(hasSelection()).toBe(true)
	})

	test('a range that spans no text is not', () => {
		// A collapsed range still reports rects, so the text is what decides.
		stub('', [{ left: 0, right: 10, top: 0, bottom: 20 }])
		expect(hasSelection()).toBe(false)
	})
})

describe('overSelection', () => {
	const line = { left: 40, right: 300, top: 500, bottom: 520 }

	test('a point on the selected text', () => {
		stub('a word', [line])
		expect(overSelection(100, 510)).toBe(true)
	})

	test('a point on the handle hanging below it', () => {
		stub('a word', [line])
		expect(overSelection(300, 540)).toBe(true)
	})

	test('the left margin beside a selected line is still the drawer’s', () => {
		stub('a word', [line])
		expect(overSelection(4, 510)).toBe(false)
	})

	test('another line entirely', () => {
		stub('a word', [line])
		expect(overSelection(100, 700)).toBe(false)
	})

	test('any point, with nothing selected', () => {
		stub('')
		expect(overSelection(100, 510)).toBe(false)
	})

	test('a selection spanning two lines is tested against both', () => {
		stub('two lines', [line, { left: 20, right: 120, top: 520, bottom: 540 }])
		expect(overSelection(60, 530)).toBe(true)
	})
})
