/**
 * Arming lid-closed wakefulness from the phone.
 *
 * This is the one relay capability that needs root, and it only exists at all because
 * `nosleep setup` installed a scoped NOPASSWD rule: the LaunchAgent has no TTY, so
 * without that rule there is no prompt to answer and nothing here can work. Every
 * function below degrades to "not available" rather than failing loudly when the rule
 * isn't installed, because that is the normal state for anyone who hasn't opted in.
 *
 * Three properties matter and none is obvious:
 *
 *  - **The armed window must outlive this process.** `autoupdate` deliberately
 *    `exit()`s to reload and launchd restarts us; if the helper were an ordinary child
 *    it would die with us and silently restore sleep, which is exactly the moment the
 *    phone is relying on it. So it is spawned detached (its own session), and the
 *    relay finds it again after a restart by reading the pidfile rather than by
 *    holding a handle.
 *  - **Liveness can't be checked the usual way.** The armed process runs as root, so
 *    `kill(pid, 0)` from this process raises EPERM rather than succeeding. EPERM means
 *    it is alive and not ours; ESRCH means it is gone. Treating EPERM as dead would
 *    report every armed window as idle.
 *  - **Ending a window has to put a shut Mac to sleep itself.** Clamshell sleep is a
 *    lid-close *event*, not a state macOS keeps re-checking, and the lid closed while
 *    `disablesleep` was up — so the helper's restore re-allows sleep without causing
 *    any, and a lid-closed Mac that ended its window (the phone's "Let it sleep", or
 *    the timer running out) just sat there awake indefinitely. The relay follows the
 *    restore with `pmset sleepnow` — which needs no root (only pmset *settings* do),
 *    so it lives here and not in the installed helper, and existing setups need no
 *    re-`setup` — gated on ioreg's AppleClamshellState: an open lid, or a desktop Mac
 *    that has none, keeps the restore-only behaviour, because forcing sleep on a Mac
 *    someone may be sitting at is worse than the bug.
 *
 * Stdlib only, strip-clean — see CLAUDE.md.
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { HELPER_PATH, helperReady, PIDFILE_PATH } from './nosleep-helper.ts'

const execFileP = promisify(execFile)

/** Longest window the API will arm. A phone tap should never be able to disable sleep forever. */
export const MAX_SECONDS = 12 * 3600

export interface NoSleepState {
	/** False when `nosleep setup` hasn't been run — every action here is unavailable. */
	available: boolean
	armed: boolean
	/** Epoch ms the window expires, or null for "until stopped" / not armed. */
	until: number | null
	pid: number | null
}

/**
 * Whether `pid` exists. EPERM is the interesting case: the armed helper runs as root, so
 * signalling it from here is refused, and that refusal is itself proof it is alive.
 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Parse `<pid> <expiry-epoch-seconds>`; expiry 0 means "until stopped". */
function readPidfile(): { pid: number; until: number | null } | null {
	let raw: string
	try {
		raw = fs.readFileSync(PIDFILE_PATH, 'utf8')
	} catch {
		return null
	}
	const [pidRaw, untilRaw] = raw.trim().split(/\s+/)
	const pid = Number(pidRaw)
	if (!Number.isInteger(pid) || pid <= 0) return null
	const untilSec = Number(untilRaw)
	return { pid, until: Number.isFinite(untilSec) && untilSec > 0 ? untilSec * 1000 : null }
}

/**
 * Armed-ness on its own: a local file read plus a signal probe, no subprocess at all.
 *
 * Split out from `nosleepState()` because the wait loops below poll it several times a
 * second. `nosleepState()` falls through to `helperReady()` whenever nothing is armed,
 * which is exactly the state a loop *waiting* for an arm sits in, so polling it would fire
 * a synchronous sudo on every pass — fifty per arm, each one blocking the relay's single
 * thread. The loops already know the grant works; they checked before spawning.
 */
function armedRecord(): { pid: number; until: number | null } | null {
	const rec = readPidfile()
	return rec && alive(rec.pid) ? rec : null
}

function armedState(rec: { pid: number; until: number | null }): NoSleepState {
	return { available: true, armed: true, until: rec.until, pid: rec.pid }
}

/**
 * Current state. `helperReady()` shells out to sudo, so it is only consulted when nothing
 * is armed — an armed window is itself proof the grant works.
 */
export async function nosleepState(): Promise<NoSleepState> {
	const rec = armedRecord()
	if (rec) return armedState(rec)
	return { available: await helperReady(), armed: false, until: null, pid: null }
}

export interface NoSleepResult {
	ok: boolean
	error?: string
	/** Disarm only: the lid is shut, so the relay is about to `pmset sleepnow` the Mac. */
	willSleep?: boolean
	state: NoSleepState
}

/**
 * Whether the lid is physically shut. `null` means the probe couldn't say — a desktop Mac
 * has no clamshell and no such key — and callers must read that as "don't force anything",
 * never as either lid state.
 */
async function clamshellClosed(): Promise<boolean | null> {
	try {
		const { stdout } = await execFileP('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeout: 5000 })
		const m = stdout.match(/"AppleClamshellState"\s*=\s*(Yes|No)/)
		return m ? m[1] === 'Yes' : null
	} catch {
		return null
	}
}

/** Ask macOS to sleep now. Unprivileged on purpose: `sleepnow` is the one pmset verb that needs no root. */
async function sleepNow(): Promise<{ ok: boolean; error?: string }> {
	try {
		await execFileP('pmset', ['sleepnow'], { timeout: 10_000 })
		return { ok: true }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * How long a disarm answer gets to leave the Mac before the network suspends with it. The
 * phone's tap awaits the DELETE and immediately re-reads /api/settings (~90ms of concurrent
 * subprocesses plus one funnel round trip), so 2s covers both with room, and nobody watches
 * a lid-closed Mac take two extra seconds to sleep.
 */
const SLEEP_AFTER_REPLY_MS = 2000

/**
 * Sleep the Mac in a moment, unless a new window arms in the meantime — a tap pair of
 * "Let it sleep" then "1h" must end with a Mac that stays awake, not one that sleeps
 * two seconds into its fresh window.
 */
function sleepSoon(why: string): void {
	const t = setTimeout(() => {
		void (async () => {
			if (armedRecord()) {
				console.info(`nosleep: not sleeping the Mac (${why}) — a new keep-awake window armed first`)
				return
			}
			const res = await sleepNow()
			if (res.ok) console.info(`nosleep: lid is closed — putting the Mac to sleep (${why})`)
			else console.error(`nosleep: pmset sleepnow failed (${why}): ${res.error}`)
		})()
	}, SLEEP_AFTER_REPLY_MS)
	t.unref()
}

function unavailable(): NoSleepResult {
	return {
		ok: false,
		error: 'Passwordless nosleep isn’t installed. Run `conductor-remote nosleep setup` on the Mac.',
		state: { available: false, armed: false, until: null, pid: null }
	}
}

/**
 * Arm for `seconds` (0 = until stopped). Arming while already armed replaces the window
 * rather than stacking — the helper enforces that, and it has to, since two owners would
 * restore each other's flipped values and leave sleep disabled for good.
 */
export async function armNoSleep(seconds: number): Promise<NoSleepResult> {
	if (!(await helperReady())) return unavailable()
	// Floor of 1, not 0. The helper reads 0 as "until killed", so anything under a second
	// truncates straight past MAX_SECONDS into a window nothing ever closes — which is the
	// one thing the cap exists to prevent.
	const secs = Math.min(MAX_SECONDS, Math.max(1, Math.trunc(seconds)))
	// Detached, own session, no stdio: it has to survive this relay's own restarts,
	// which autoupdate performs routinely and without warning.
	const child = spawn('sudo', ['-n', HELPER_PATH, String(secs), ''], {
		detached: true,
		stdio: 'ignore'
	})
	child.unref()

	// The helper writes its pidfile only after pmset actually applied, so waiting for the
	// file is what turns "we launched something" into "sleep is genuinely blocked". A
	// takeover adds its own wait for the incumbent to restore, hence the generous ceiling.
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		const rec = armedRecord()
		if (rec) {
			// Watch this window's own end: the helper's restore re-allows sleep but causes
			// none, so a lid still shut at expiry needs the nudge below.
			rescanExpiry()
			return { ok: true, state: armedState(rec) }
		}
		await new Promise(r => setTimeout(r, 200))
	}
	return { ok: false, error: 'nosleep did not report itself armed within 10s', state: await nosleepState() }
}

/**
 * Disarm. Goes through the helper because the armed process is root and we can't signal it.
 * A shut lid then gets `pmset sleepnow` a beat later — restoring `disablesleep 0` re-allows
 * sleep without causing any (see the module note), and "Let it sleep" tapped from a phone
 * means exactly that. The caller is answered `willSleep` first, so the phone hears the
 * confirmation before the network goes down with the Mac.
 */
export async function disarmNoSleep(): Promise<NoSleepResult> {
	if (!(await helperReady())) return unavailable()
	try {
		await execFileP('sudo', ['-n', HELPER_PATH, '--stop'], { timeout: 10_000 })
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), state: await nosleepState() }
	}
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		if (!armedRecord()) {
			cancelExpiryWatch()
			const willSleep = (await clamshellClosed()) === true
			if (willSleep) sleepSoon('the keep-awake window was ended from the phone')
			else console.info('nosleep: window ended with the lid open (or unreadable) — sleep re-enabled, not forced')
			return { ok: true, willSleep, state: { available: true, armed: false, until: null, pid: null } }
		}
		await new Promise(r => setTimeout(r, 200))
	}
	return { ok: false, error: 'nosleep is still armed after --stop', state: await nosleepState() }
}

// --- The window's own expiry -------------------------------------------------------------
//
// "Awake until 12:30" promises a Mac that sleeps at 12:30, and the helper alone cannot keep
// that promise on a shut lid (its restore re-allows sleep, nothing more). Teaching the
// *installed* helper to sleepnow would strand every existing setup on the old behaviour —
// the root copy deliberately never self-updates — so the relay watches the recorded expiry
// instead, which also covers windows armed from a terminal.

/** Slack after the recorded expiry for the helper's own restore to land before we look. */
const EXPIRY_GRACE_MS = 15_000
/** A timer this far past its schedule fired on wake-from-sleep, not on schedule. */
const EXPIRY_LATE_MS = 60_000
/** How often to re-read the pidfile for windows this process didn't arm (CLI, pre-restart). */
const EXPIRY_RESCAN_MS = 60_000

let expiryTimer: ReturnType<typeof setTimeout> | null = null
/** Identity of the window the timer is armed for — `pid:until`, so a takeover reschedules. */
let expiryKey: string | null = null

function cancelExpiryWatch(): void {
	if (expiryTimer) clearTimeout(expiryTimer)
	expiryTimer = null
	expiryKey = null
}

function rescanExpiry(): void {
	const rec = armedRecord()
	const key = rec && rec.until !== null ? `${rec.pid}:${rec.until}` : null
	if (key === expiryKey) return
	cancelExpiryWatch()
	if (!rec || rec.until === null) return
	expiryKey = key
	const fireAt = rec.until + EXPIRY_GRACE_MS
	expiryTimer = setTimeout(
		() => {
			expiryTimer = null
			expiryKey = null
			void windowExpired(fireAt)
		},
		Math.max(0, fireAt - Date.now())
	)
	// A 12h timer must not hold the process open, and it survives nothing anyway — a
	// restarted relay rebuilds it from the pidfile in watchNoSleepExpiry's first rescan.
	expiryTimer.unref()
}

async function windowExpired(plannedAt: number): Promise<void> {
	// Node timers don't run while the Mac sleeps; one that fires long after its schedule
	// fired because something woke the Mac, and sleeping a Mac someone just woke is the one
	// wrong move here. On schedule ± a minute is the only firing that means "expiry".
	const lateMs = Date.now() - plannedAt
	if (lateMs > EXPIRY_LATE_MS) {
		console.info(`nosleep: expiry check ran ${Math.round(lateMs / 1000)}s late (Mac was asleep?) — leaving it awake`)
		return
	}
	// A record still (or again) present is a takeover or a helper mid-restore — not ours to end.
	if (armedRecord()) return
	if ((await clamshellClosed()) !== true) {
		console.info('nosleep: keep-awake window expired with the lid open (or unreadable) — leaving the Mac awake')
		return
	}
	const res = await sleepNow()
	if (res.ok) console.info('nosleep: keep-awake window expired with the lid closed — putting the Mac to sleep')
	else console.error(`nosleep: pmset sleepnow failed at window expiry: ${res.error}`)
}

/** Start watching for armed windows reaching their recorded expiry. Called once at relay startup. */
export function watchNoSleepExpiry(): void {
	rescanExpiry()
	const iv = setInterval(rescanExpiry, EXPIRY_RESCAN_MS)
	iv.unref()
}
