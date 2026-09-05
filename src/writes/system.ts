import path from 'node:path'
import { CONDUCTOR_HANDLERS, osaError, RESTART_ATTEMPT_MS } from './runner.ts'
import type { SendResult } from './types.ts'
import { exec, uiTurn } from './ui-lock.ts'

/**
 * Press the Wi-Fi menu's row for a personal hotspot — Instant Hotspot, the same
 * button a human clicks. `networksetup` can only join a network that is
 * broadcasting, and a personal hotspot usually isn't; the row in Control
 * Center's Wi-Fi popover is fed by Continuity over Bluetooth, and pressing it
 * asks the phone to wake its hotspot. The funnel watchdog reaches for this when
 * a plain join answered "Could not find network".
 *
 * The one UI write here that doesn't target Conductor, and it still takes a
 * uiTurn: the popover steals key focus, so a palette fallback running at the
 * same moment would type into it. The name travels via a temp file like the
 * prompt does — same escaping-and-encoding dodge, and hotspot names ("Han
 * høyes iPhone") are non-ASCII more often than prompts are. Success here means
 * *pressed*, nothing more: joining takes several seconds of Bluetooth wake +
 * DHCP, so the caller owns the wait, and it watches `hasDefaultRoute()` — the
 * one link signal that needs no permission — not this function's word.
 * Everything else — the lock check, the toggle-aware close, the already-open
 * abort, the contention story — lives with the handler in src/writes/applescript/hotspot.applescript.
 */
export async function joinInstantHotspot(name: string): Promise<{ ok: boolean; error?: string }> {
	const script = `
${CONDUCTOR_HANDLERS}

my joinInstantHotspot()`.trim()
	const os = await import('node:os')
	const fs = await import('node:fs/promises')
	const tmp = path.join(os.tmpdir(), `relay-hotspot-${process.pid}-${Date.now()}.txt`)
	await fs.writeFile(tmp, name, 'utf8')
	try {
		await uiTurn(() =>
			exec('osascript', ['-e', script], {
				env: { ...process.env, RELAY_HOTSPOT_FILE: tmp },
				timeout: 25_000
			})
		)
		return { ok: true }
	} catch (err) {
		return { ok: false, error: osaError(err, 'the Wi-Fi menu press took too long') }
	} finally {
		await fs.rm(tmp, { force: true }).catch(() => undefined)
	}
}

/**
 * Quit Conductor and start it again because the phone asked — the one write here
 * whose subject is the app rather than anything inside it.
 *
 * The lever already existed and was unreachable. `activateConductor` restarts as its
 * last resort, but only after a *running* Conductor has drawn no window through
 * `reopen` and a Dock click, so it answers exactly one failure: a windowless app. The
 * failure this is for looks healthy from every probe on that ladder — window up,
 * sidebar drawing, composer taking prompts — while the agent runtime behind it has
 * stopped producing anything. Measured on this Mac (2026-09-02): the last agent frame
 * in `session_messages` was 20:47:44 and prompts kept landing as user rows for the
 * next two and a half hours, each turn flipping `working → idle` having written
 * nothing. Nothing on the read side can fix that, and "quit it on your Mac" is not
 * advice a phone can act on.
 *
 * Two gates, and neither lives here. The **working chats** are counted from the DB by
 * src/http/routes/system.ts, which refuses without `stopAgents` — quitting takes every agent mid-turn
 * down with it, so that has to be said out loud, exactly as it is for archiving. The
 * **lock screen** is asked by `restartApp` itself, because a relaunch fired behind it
 * comes up windowless (and once, wedged). What is left for this function is the UI
 * lock: a restart is not a read, and letting one land while a send is mid-flight would
 * quit the app between the composer write and the Enter.
 */
export async function restartConductorApp(): Promise<SendResult> {
	const script = `
${CONDUCTOR_HANDLERS}

return my restartApp()`.trim()
	try {
		await uiTurn(() => exec('osascript', ['-e', script], { env: { ...process.env }, timeout: RESTART_ATTEMPT_MS }))
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err, 'Conductor didn’t come back in time') }
	}
}
