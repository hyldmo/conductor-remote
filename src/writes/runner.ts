import { WorkflowGatedCommandError } from '../orchestration/workflow/effect-runner.ts'
import { readConductorAppleScript } from './applescript/source.ts'

/**
 * How long one AppleScript run may take before it's killed.
 *
 * Sized from measurement, not taste. A send that *worked* measured 23.6s end to
 * end on a 30-workspace sidebar — past the 20s ceiling this replaces, which is why
 * ordinary sends were being killed mid-run and reported as "Conductor took too long
 * to respond". The cost is Accessibility round trips, not waiting: activating a
 * backgrounded Conductor and reading the pane cost ~10s cold, and finding the
 * sidebar row to press another ~10s.
 *
 * `openViaDeepLink` took the row scan out of the common path — a whole send now
 * measures ~4s, and focusing alone ~2s against the ~18s the same focus costs when
 * the link is unavailable — so this budget is really the *fallback's*, kept at the
 * size that fallback still needs. A ceiling costs nothing when a send is fast; only
 * a doomed one waits it out, and the caller's own deadline is what bounds that.
 */
export const SEND_ATTEMPT_MS = 28_000

/**
 * A restart's own ceiling. It is longer than a send's because it is mostly *waiting*:
 * up to 4s for the quit to be honoured, then a cold launch, then `waitForWindow(60)`'s
 * 15s for the first window — none of which can be hurried, and all of which the caller
 * would rather wait through than be told "try again" about.
 */
export const RESTART_ATTEMPT_MS = 45_000

/**
 * A run's own ceiling, taken off the caller's deadline at the moment it actually
 * starts.
 *
 * Both halves matter. `uiTurn` above means a run can sit in the queue behind
 * another write, so a duration computed when it was *requested* would let a queued
 * run overshoot a deadline the caller is still holding a phone open on.
 * `SEND_ATTEMPT_MS` then caps it, because a caller with a minute of budget still
 * shouldn't spend all of it on one doomed run when a retry is the thing that works.
 * The floor keeps a squeezed run honest instead of passing `timeout: 0`, which node
 * reads as "no timeout at all".
 */
export function runCeiling(deadline: number): number {
	return Math.max(5_000, Math.min(SEND_ATTEMPT_MS, deadline - Date.now()))
}

/**
 * Every AppleScript handler the write path uses, assembled as one program from
 * src/writes/applescript/. The source manifest also drives checking and copying.
 *
 * The source module resolves its sibling assets in both the checkout and the
 * emitted package. Joining inserts nothing and trimming matches the original
 * single-file loader, so every actuator appends to the same program as before.
 * Read once at import, because a missing copy is a packaging bug and a relay that
 * refuses to boot naming the missing assets is the loudest way to say so.
 */
export const CONDUCTOR_HANDLERS = readConductorAppleScript().trimEnd()

/** osascript echoes the whole failing script back; keep just the reason for the phone. */
export function osaError(err: unknown, timeoutMsg = 'Conductor took too long to respond'): string {
	const raw =
		err instanceof WorkflowGatedCommandError
			? [err.message, err.stderr].filter(Boolean).join('\n')
			: err instanceof Error
				? err.message
				: String(err)
	// A timeout kill carries no execution error at all — its first line is
	// "Command failed: osascript -e" plus the whole script, which is useless here.
	if (
		(err instanceof WorkflowGatedCommandError && err.code === 'timed_out') ||
		(err && typeof err === 'object' && 'killed' in err && (err as { killed?: boolean }).killed)
	) {
		return timeoutMsg
	}
	return raw.match(/execution error: (.+?) \(-?\d+\)/)?.[1] ?? raw.split('\n')[0]
}
