/**
 * The Mac's own Wi-Fi, read and (narrowly) written through `networksetup`.
 *
 * Used by the funnel watchdog to move this Mac onto a phone hotspot when the link it was
 * on disappears. Two things shape every function here:
 *
 *  - **The SSID is not readable.** Since macOS Sonoma, reporting the associated network
 *    needs Location Services, and `airport -I` is gone. On this Mac `-getairportnetwork`
 *    answers "You are not associated with an AirPort network" while a default route is
 *    live on the same interface. So `currentSsid()` is INFORMATIONAL ONLY — never branch
 *    on it. `hasDefaultRoute()` is the signal that can be trusted.
 *  - **Passwords are never stored here.** `-setairportnetwork` takes an optional password
 *    and *writes* it to the keychain; for a network macOS already knows, the argument is
 *    unnecessary. So this only ever joins networks already in the preferred list, and an
 *    unknown SSID is reported rather than guessed at. Nothing secret reaches settings.json
 *    or the log, which matters because `/api/logs` is a wire surface.
 *
 * Stdlib only, strip-clean — see CLAUDE.md.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const NETWORKSETUP = '/usr/sbin/networksetup'

let cachedDevice: string | null | undefined

/**
 * Every reader here is async, and that is not cosmetic. The relay is one thread serving
 * polls at 1s / 2s / 2.5s, and `networksetup` is slowest exactly when this module matters
 * most: a wedged Wi-Fi interface is the case the fallback network exists for, and it is
 * also the case where these calls sit on their timeouts. Synchronously that is up to 18
 * seconds of a frozen relay behind one tap on the Connect sheet.
 */

/**
 * The Wi-Fi interface (`en0` on most Macs, but never assume — a Mac with a Thunderbolt
 * dock renumbers). Parsed from the hardware-port table: the device on the line after
 * `Hardware Port: Wi-Fi`. Cached, since it can't change without a reboot.
 */
export async function wifiDevice(): Promise<string | null> {
	if (cachedDevice !== undefined) return cachedDevice
	cachedDevice = null
	try {
		const { stdout } = await execFileP(NETWORKSETUP, ['-listallhardwareports'], { encoding: 'utf8', timeout: 5000 })
		const lines = stdout.split('\n')
		for (let i = 0; i < lines.length; i++) {
			if (!/^Hardware Port:\s*Wi-Fi\s*$/.test(lines[i])) continue
			const m = lines[i + 1]?.match(/^Device:\s*(\S+)/)
			if (m) {
				cachedDevice = m[1]
				break
			}
		}
	} catch {
		// no networksetup / not macOS — stays null, and every caller treats that as "no opinion"
	}
	return cachedDevice
}

/**
 * Is there a route off this machine at all? The one link signal that doesn't need a
 * permission grant, and the only one the rejoin branch is allowed to act on.
 */
export async function hasDefaultRoute(): Promise<boolean> {
	try {
		const { stdout } = await execFileP('route', ['-n', 'get', 'default'], { timeout: 5000 })
		return /^\s*gateway:\s*\S+/m.test(stdout)
	} catch {
		return false
	}
}

/**
 * Networks macOS already holds credentials for, in its own preference order.
 *
 * **The order is a signal and the picker leans on it.** macOS keeps this roughly
 * most-recently-joined first, so the head of the list is what the Wi-Fi menu draws —
 * measured here: the associated network, then the phone hotspot, then the office APs.
 * That matters because the short menu list itself is unreachable (a live scan redacts
 * every name without Location Services, the hotspot arrives over private Continuity),
 * so ranking by this order is the closest the phone can get. Preserve it — don't sort.
 */
export async function preferredNetworks(): Promise<string[]> {
	const dev = await wifiDevice()
	if (!dev) return []
	try {
		const { stdout } = await execFileP(NETWORKSETUP, ['-listpreferredwirelessnetworks', dev], {
			encoding: 'utf8',
			timeout: 8000
		})
		// First line is the "Preferred networks on enN:" header; the rest are tab-indented names.
		return stdout
			.split('\n')
			.slice(1)
			.map(l => l.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

/**
 * macOS's own **Auto-join Hotspot** setting: `Never`, `Ask`, or `Automatic`
 * (System Settings ▸ Wi-Fi). Null when it can't be read.
 *
 * This is the closest thing to hotspot awareness that is actually available to us, and it
 * matters more than an icon would. On `Never` — the default here — the Mac will not join
 * your iPhone on its own even when nothing else is in range, so the "I forgot to turn the
 * hotspot on" case cannot resolve itself no matter what this relay does. Worth reporting;
 * not worth changing behind someone's back, so nothing here writes it.
 *
 * Read from the world-readable airport prefs. The richer per-network store,
 * `/Library/Preferences/com.apple.wifi.known-networks.plist`, is `-rw------- root` and
 * stays out of reach on purpose: widening the root helper to read it would trade a real
 * security boundary for a nicer picker.
 */
export async function autoJoinHotspotMode(): Promise<string | null> {
	try {
		const { stdout } = await execFileP(
			'/usr/bin/plutil',
			[
				'-extract',
				'AutoHotspotMode',
				'raw',
				'-o',
				'-',
				'/Library/Preferences/SystemConfiguration/com.apple.airport.preferences.plist'
			],
			{ encoding: 'utf8', timeout: 5000 }
		)
		return stdout.trim() || null
	} catch {
		return null
	}
}

/**
 * Networks whose name reads like a phone hotspot. A **guess**, and labelled as one wherever
 * it surfaces: macOS knows the real answer over Continuity/BLE, which is private, and every
 * public source is blocked. `system_profiler SPAirPortDataType` does scan live and reports
 * `Network Type`, but it redacts every SSID without Location Services, so it can't name what
 * it finds. So this only ever reorders a list — it never decides anything.
 *
 * Apple names a hotspot after the device ("Han's iPhone"), localised, hence matching the
 * device word rather than a possessive form.
 */
export function looksLikeHotspot(ssid: string): boolean {
	return /\b(iphone|ipad|hotspot|androidap)\b/i.test(ssid)
}

/**
 * The associated SSID, or null when macOS won't say. Null is the common case without
 * Location Services, so it means "unknown", never "not connected". Display only.
 */
export async function currentSsid(): Promise<string | null> {
	const dev = await wifiDevice()
	if (!dev) return null
	try {
		const { stdout } = await execFileP(NETWORKSETUP, ['-getairportnetwork', dev], { encoding: 'utf8', timeout: 5000 })
		const m = stdout.match(/^Current Wi-Fi Network:\s*(.+?)\s*$/m)
		return m ? m[1] : null
	} catch {
		return null
	}
}

/**
 * Join a network macOS already knows. No password argument by design — see the header.
 * `networksetup` exits 0 even when the join fails, printing the reason, so the text is
 * the result and an empty one is success.
 */
export async function joinNetwork(ssid: string): Promise<{ ok: boolean; error?: string }> {
	const dev = await wifiDevice()
	if (!dev) return { ok: false, error: 'no Wi-Fi interface on this Mac' }
	try {
		const { stdout, stderr } = await execFileP(NETWORKSETUP, ['-setairportnetwork', dev, ssid], { timeout: 30_000 })
		const text = `${stdout}${stderr}`.trim()
		if (!text) return { ok: true }
		return { ok: false, error: text }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message.trim() : String(err) }
	}
}
