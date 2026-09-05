import { describe, expect, test } from 'vitest'
import { type EnterKeyEvent, enterSubmits } from '../../web/src/lib/keys.ts'

/**
 * Which Enter sends (web/src/lib/keys.ts). Both ways of getting it wrong are silent:
 * send on a touch keyboard and a return meant as a line break ships half a prompt,
 * which is the bug it was written for; stop sending on a hardware keyboard and every
 * desktop Enter turns into a newline with nothing in the log. The device answer is
 * injected, so no browser and no matchMedia.
 */
const key = (over: Partial<EnterKeyEvent> = {}): EnterKeyEvent => ({
	key: 'Enter',
	shiftKey: false,
	metaKey: false,
	ctrlKey: false,
	nativeEvent: { isComposing: false },
	...over
})

describe('enterSubmits', () => {
	test('hardware keyboard: Enter sends, Shift+Enter breaks the line', () => {
		expect(enterSubmits(key(), false)).toBe(true)
		expect(enterSubmits(key({ shiftKey: true }), false)).toBe(false)
	})

	test('touch keyboard: Enter breaks the line, the button sends', () => {
		expect(enterSubmits(key(), true)).toBe(false)
	})

	test('Cmd/Ctrl+Enter sends on either keyboard', () => {
		expect(enterSubmits(key({ metaKey: true }), true)).toBe(true)
		expect(enterSubmits(key({ ctrlKey: true }), true)).toBe(true)
		expect(enterSubmits(key({ metaKey: true }), false)).toBe(true)
	})

	test("an IME's own Enter is never a send", () => {
		expect(enterSubmits(key({ nativeEvent: { isComposing: true } }), false)).toBe(false)
		expect(enterSubmits(key({ metaKey: true, nativeEvent: { isComposing: true } }), false)).toBe(false)
	})

	test('other keys are ignored', () => {
		expect(enterSubmits(key({ key: 'a' }), false)).toBe(false)
	})
})
