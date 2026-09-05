import { describe, expect, test } from 'vitest'
import { isLockedError, MAC_LOCKED } from '../../src/shared.ts'
import { readConductorAppleScript } from '../../src/writes/applescript/source.ts'

/**
 * The lock refusals are a contract between two languages, and nothing else checks it.
 *
 * `MAC_LOCKED` is matched as a *substring* by both sides — the relay parks a send on it
 * (src/writes/guards.ts ▸ lockBlocked) and the phone draws its unlock link beside it — while the
 * sentences themselves are written in AppleScript, which no typechecker here reads. So a
 * reworded refusal ("Your Mac is locked…") still compiles, still reaches the phone, and
 * silently costs the park and the link: the send fails outright and the one control that
 * would fix it isn't drawn. This pins every refusal that talks about the lock screen —
 * including the restart's, which is why the restart route can promise the same handling.
 */
const script = readConductorAppleScript()

/** Every literal the script raises. The `& windowEvidence()` tails sit outside the quotes. */
const refusals = [...script.matchAll(/error "((?:[^"\\]|\\.)*)"/g)].map(match => match[1])

describe('conductor.applescript refusals', () => {
	test('are found at all — the regex is the whole test', () => {
		expect(refusals.length).toBeGreaterThan(20)
	})

	test('every refusal about the lock screen carries the phrase both sides match on', () => {
		const aboutLock = refusals.filter(text => /lock/i.test(text))
		// Sends, the window ladder's two branches, the restart, and the Wi-Fi popover.
		expect(aboutLock.length).toBeGreaterThanOrEqual(5)
		for (const text of aboutLock) expect(isLockedError(text), text).toBe(true)
	})

	test('the phrase leads, so it survives being truncated for a notification', () => {
		for (const text of refusals.filter(isLockedError)) expect(text.startsWith(MAC_LOCKED), text).toBe(true)
	})
})
