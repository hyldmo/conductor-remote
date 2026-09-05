import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { withoutClientWindowEvidence, withoutWindowEvidence } from '../../src/shared.ts'
import { readConductorAppleScript } from '../../src/writes/applescript/source.ts'
import { lockBlocked, retryWontHelp, sendNeverStarted } from '../../src/writes/guards.ts'
import { uiBusy } from '../../src/writes/ui-lock.ts'

/**
 * The three predicates that decide what `deliverPrompt` does with a failed run.
 * Each is a substring match against a sentence this repo writes itself, and each
 * fails silently in the direction that costs the most:
 *
 *  - `sendNeverStarted` too wide skips the confirm window after a run that *did*
 *    send, so the retry types the same prompt into the chat a second time — the
 *    duplicate the window exists to prevent.
 *  - `lockBlocked` too narrow burns a phone's whole budget against a locked Mac
 *    instead of parking the prompt for the queue that waits hours.
 *  - `retryWontHelp` too wide stops retrying a send a second attempt would land.
 */
const ERRORS = {
	notTrusted: 'Conductor is not trusted for Accessibility',
	automationRefused: 'macOS blocked the relay from controlling the UI',
	noSession: 'no session id to target',
	noBranch: 'workspace has no branch to focus',
	paletteMiss: "the palette didn't land on sacramento-v1",
	noStrip: "couldn't identify the chat tab strip",
	tabMissing: 'chat tab 1 not found',
	timeout: 'Conductor took too long to respond',
	noWindow: "Can't get window 1 of process Conductor. Invalid index."
}

/**
 * Every lock refusal the UI script can raise, read out of the script rather than copied
 * here. Copies were the point of failure: three sentences in AppleScript, one predicate
 * in TypeScript that parks on them, and nothing connecting the two — so rewording one
 * (they are phone-facing prose, and they get reworded) silently stops the parking and
 * hands a locked Mac a red failure instead.
 */
const LOCK_ERRORS = (() => {
	const source = readConductorAppleScript()
	const found = [...source.matchAll(/error "(The Mac is locked[^"]*)"/g)].map(m => m[1])
	if (found.length < 3) throw new Error(`expected the script's lock refusals, found ${found.length}`)
	return found
})()

/** The sentence the send script itself errors with, read out of the script. */
const composerHeld = (() => {
	const source = readFileSync(new URL('../../src/writes/actuator.ts', import.meta.url), 'utf8')
	const found = source.match(/error "([^"]*still sitting in its composer[^"]*)"/)
	if (!found) throw new Error('the send script no longer errors with a composer-held sentence')
	return found[1]
})()

describe('send failure predicates', () => {
	test('only a composer-held run counts as having sent nothing', () => {
		expect(sendNeverStarted(composerHeld)).toBe(true)
		for (const [name, error] of Object.entries(ERRORS)) expect(sendNeverStarted(error), name).toBe(false)
		for (const error of LOCK_ERRORS) expect(sendNeverStarted(error), error).toBe(false)
	})

	test('a run that reported no error keeps its confirm window', () => {
		expect(sendNeverStarted(undefined)).toBe(false)
		expect(sendNeverStarted('')).toBe(false)
	})

	test('every lock refusal the script can raise parks, nothing else does', () => {
		for (const error of LOCK_ERRORS) expect(lockBlocked(error), error).toBe(true)
		// The evidence tail is cut before the phone sees it, so the predicate has to hold
		// on both shapes — the relay parks on the raw one, the phone links to the unlock
		// off the cut one.
		for (const error of LOCK_ERRORS) expect(lockBlocked(withoutWindowEvidence(error)), error).toBe(true)
		for (const [name, error] of Object.entries(ERRORS)) expect(lockBlocked(error), name).toBe(false)
		expect(lockBlocked(composerHeld)).toBe(false)
		expect(lockBlocked(undefined)).toBe(false)
	})

	test('only the window evidence is cut, and only where it is', () => {
		const raw = `${LOCK_ERRORS[0]} [window server: 6; screen: locked] [processes: conductor=0] [menus: Apple, Conductor]`
		expect(withoutWindowEvidence(raw)).toBe(LOCK_ERRORS[0])
		for (const [name, error] of Object.entries(ERRORS)) expect(withoutWindowEvidence(error), name).toBe(error)
		expect(withoutWindowEvidence(composerHeld)).toBe(composerHeld)
	})

	test('cuts Workflow message and quarantine reason fields without stripping relay log text', () => {
		const raw = `${LOCK_ERRORS[0]} [window server: 6; screen: locked] [processes: conductor=0]`
		for (const field of ['error', 'message', 'reason']) {
			expect(withoutClientWindowEvidence(raw, field)).toBe(LOCK_ERRORS[0])
		}
		expect(withoutClientWindowEvidence(raw, 'text')).toBe(raw)
	})

	test('only refusals a retry cannot fix stop the loop', () => {
		expect(retryWontHelp(ERRORS.notTrusted)).toBe(true)
		expect(retryWontHelp(ERRORS.automationRefused)).toBe(true)
		expect(retryWontHelp(ERRORS.noSession)).toBe(true)
		expect(retryWontHelp(ERRORS.noBranch)).toBe(true)
		for (const name of ['paletteMiss', 'noStrip', 'tabMissing', 'timeout', 'noWindow'] as const) {
			expect(retryWontHelp(ERRORS[name]), name).toBe(false)
		}
		// A lock is not terminal: the caller parks it, and an unlock mid-budget lands it.
		for (const error of LOCK_ERRORS) expect(retryWontHelp(error), error).toBe(false)
		expect(retryWontHelp(composerHeld)).toBe(false)
		expect(retryWontHelp(undefined)).toBe(false)
	})

	test('recognizes the relay-owned UI saturation error through retry annotations', () => {
		const busy = "Conductor's UI is busy — 4 operations already queued. Try again shortly."
		expect(uiBusy(busy)).toBe(true)
		expect(uiBusy(`${busy} (tried 2×)`)).toBe(true)
		expect(uiBusy(ERRORS.timeout)).toBe(false)
		expect(uiBusy(undefined)).toBe(false)
	})
})
