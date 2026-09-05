/**
 * The relay's own preferences, set from the phone.
 *
 * Persisted beside the token and the parked queues (`stateDir()/settings.json`) for the
 * same reason those are: the daemon restarts itself on every self-update, and anything
 * held in memory is a preference that quietly reverts.
 *
 * **Nothing secret goes in here.** The file is plain JSON at rest and its contents flow
 * back out through a token-gated API, so the Wi-Fi entries are SSIDs only — macOS already
 * holds the credentials for any network it has joined, and `src/host/wifi.ts` never passes a
 * password. An SSID the Mac doesn't know is reported as unjoinable rather than stored
 * with one.
 *
 * Stdlib only, strip-clean — see CLAUDE.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './config.ts'

export interface Settings {
	/**
	 * SSIDs the watchdog may fall back to, in order, when this Mac loses its link
	 * entirely. Normally one entry: your phone's hotspot.
	 */
	fallbackSsids: string[]
	/** Master switch for that rejoin. Off by default — switching networks is not a thing to do uninvited. */
	autoRejoin: boolean
}

const DEFAULTS: Settings = { fallbackSsids: [], autoRejoin: false }

function settingsPath(): string {
	return path.join(stateDir(), 'settings.json')
}

/** Coerce anything (a hand-edited file, an older shape, a bad PATCH) into a valid Settings. */
function sanitize(raw: unknown): Settings {
	const obj = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>
	const ssids = Array.isArray(obj.fallbackSsids) ? obj.fallbackSsids : []
	return {
		// An SSID is at most 32 bytes; anything longer is not one. Deduped and capped so a
		// runaway list can't turn the rejoin branch into a minutes-long walk.
		fallbackSsids: [
			...new Set(ssids.filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim()))
		]
			.filter(s => s.length <= 32)
			.slice(0, 8),
		autoRejoin: obj.autoRejoin === true
	}
}

let cache: Settings | null = null

export function readSettings(): Settings {
	if (cache) return cache
	try {
		cache = sanitize(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')))
	} catch {
		cache = { ...DEFAULTS }
	}
	return cache
}

/** Merge a partial patch over what's stored and persist. Returns the settings as they now are. */
export function writeSettings(patch: Partial<Settings>): Settings {
	const next = sanitize({ ...readSettings(), ...patch })
	const file = settingsPath()
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, `${JSON.stringify(next, null, '\t')}\n`, { mode: 0o600 })
	} catch (err) {
		console.warn(`⚠ could not persist settings (${err instanceof Error ? err.message : err})`)
	}
	cache = next
	return next
}
