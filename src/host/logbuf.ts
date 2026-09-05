/**
 * The relay's own log, made readable from the phone.
 *
 * Nothing here changes *what* the relay logs — it changes where that output can be read from.
 * `installLogCapture()` wraps `console.*` so every line lands in two places: a bounded in-memory
 * ring (timestamped, level-tagged, served by `GET /api/logs`) and stdout/stderr exactly as before,
 * now prefixed with a stamp. The prefix is what makes the *on-disk* daemon log parseable back into
 * the same shape, so "what happened before this process started" (a crash + KeepAlive respawn —
 * precisely the thing you can't see from a phone) reads like the live buffer.
 *
 * Two facts to keep in mind when touching this:
 * - **The daemon's log contains the access token** (the startup banner prints the phone URL with
 *   `#token=…`). Everything served out of here goes through `redactSecrets` first — the endpoint is
 *   token-gated, so that isn't an escalation, but the whole point of the feature is copy-pasting
 *   logs into a bug report, and that must not ship the key to the relay.
 * - **The files belong to the LaunchAgent, not necessarily to this process.** Only the managed
 *   daemon has them as its stdout/stderr; a dev `yarn start` writes to a terminal. Callers get
 *   `managed` so they can say whose log they're reading rather than implying it's this one's.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { scrubWorkflowSecrets } from '../shared.ts'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
	/** Epoch ms. Null for on-disk lines with no stamp: continuation lines, or lines from before this shipped. */
	t: number | null
	level: LogLevel
	text: string
}

export interface LogFileInfo {
	name: string
	size: number
	modifiedAt: number | null
}

/** Kept small enough that a phone on a slow link can pull the whole thing; ~a day of a quiet relay. */
const CAPACITY = 600
/** One AppleScript failure can carry a long stack; keep a single entry from crowding out the rest. */
const MAX_TEXT = 4000
/** Read window for a file tail — enough for a few restarts, small enough to parse per request. */
const MAX_TAIL_BYTES = 256 * 1024

/** The LaunchAgent's stdout / stderr, in the order they're offered to the UI (see scripts/service.ts). */
export const LOG_FILE_NAMES = ['relay.log', 'relay.err.log'] as const

const ring: LogEntry[] = []
const startedAt = Date.now()

function stampText(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `2026-08-04 15:02:11 WARN …` — level only when it isn't `info`, so the banner stays readable in a terminal. */
const STAMPED = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: (WARN|ERROR))? /

function prefixed(text: string, level: LogLevel, at: Date): string {
	// Several call sites open with a blank line to separate a block; keep that ahead of the stamp.
	const lead = /^\n*/.exec(text)?.[0] ?? ''
	const tag = level === 'info' ? '' : `${level.toUpperCase()} `
	return `${lead}${stampText(at)} ${tag}${text.slice(lead.length)}`
}

function push(level: LogLevel, text: string, at: number): void {
	ring.push({ t: at, level, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated]` : text })
	if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY)
}

let installed = false

/**
 * Route `console.*` through the ring buffer. Call once, as early as possible — anything logged
 * before it (a module-level warning in an import) only reaches the file, not `/api/logs`.
 */
export function installLogCapture(): void {
	if (installed) return
	installed = true
	const wrap = (level: LogLevel, original: (...args: unknown[]) => void) => {
		return (...args: unknown[]): void => {
			const at = new Date()
			const text = scrubWorkflowSecrets(util.format(...args))
			push(level, text, at.getTime())
			original(prefixed(text, level, at))
		}
	}
	console.log = wrap('info', console.log.bind(console))
	console.info = wrap('info', console.info.bind(console))
	console.warn = wrap('warn', console.warn.bind(console))
	console.error = wrap('error', console.error.bind(console))
}

/** When this relay process started — the phone's cue that a restart, not a network blip, ate the history. */
export function processStartedAt(): number {
	return startedAt
}

/** Is this the launchd-supervised instance, i.e. are the log files below actually *this* process's output? */
export function isManaged(): boolean {
	return process.env.CONDUCTOR_REMOTE_MANAGED === '1'
}

export function recentLogs(limit: number): LogEntry[] {
	return ring.slice(Math.max(0, ring.length - limit))
}

/** Where `scripts/service.ts` points the LaunchAgent's stdout/stderr. */
export function logDir(): string {
	return path.join(os.homedir(), 'Library', 'Logs', 'conductor-remote')
}

export function logFiles(): LogFileInfo[] {
	const dir = logDir()
	const out: LogFileInfo[] = []
	for (const name of LOG_FILE_NAMES) {
		try {
			const st = fs.statSync(path.join(dir, name))
			out.push({ name, size: st.size, modifiedAt: st.mtimeMs })
		} catch {
			// not written yet (no LaunchAgent, or nothing on that stream) — omit it rather than offering an empty tab
		}
	}
	return out
}

/** Last `maxBytes` of a file, dropping the leading partial line (which is also what fixes a split UTF-8 char). */
function readTail(file: string, maxBytes: number): string {
	const fd = fs.openSync(file, 'r')
	try {
		const size = fs.fstatSync(fd).size
		const start = Math.max(0, size - maxBytes)
		const buf = Buffer.alloc(size - start)
		if (buf.length) fs.readSync(fd, buf, 0, buf.length, start)
		const text = buf.toString('utf8')
		return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
	} finally {
		fs.closeSync(fd)
	}
}

/**
 * Tail one of the daemon's log files as entries. Lines written since capture was installed carry their
 * own stamp and level and are restored exactly; older or continuation lines fall back to the stream's
 * meaning — stderr is where both `console.warn` and `console.error` land, so it reads as `warn`.
 */
export function tailLogFile(name: string, limit: number): LogEntry[] {
	const fallback: LogLevel = name === 'relay.err.log' ? 'warn' : 'info'
	const raw = readTail(path.join(logDir(), name), MAX_TAIL_BYTES)
	const lines = raw.split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return lines.slice(Math.max(0, lines.length - limit)).map(line => {
		const m = STAMPED.exec(line)
		if (!m) return { t: null, level: fallback, text: line }
		const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
		const level: LogLevel = m[7] === 'ERROR' ? 'error' : m[7] === 'WARN' ? 'warn' : 'info'
		return { t: t.getTime(), level, text: line.slice(m[0].length) }
	})
}

/**
 * Strip the access token out of anything about to leave the machine. The startup banner prints it
 * verbatim, so a copied log would otherwise hand over the relay. Also masks any other `token=…`
 * (a rotated token still sitting in an older line, a Tailscale URL) — a false positive costs nothing.
 */
export function redactSecrets(text: string, token: string): string {
	const masked = token ? text.split(token).join('<token>') : text
	return scrubWorkflowSecrets(
		masked
			.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<openai-key>')
			.replace(/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, '<webhook-secret>')
			.replace(/(token=)[^\s&"'`]+/gi, '$1<token>')
	)
}
