/**
 * Shared Tailscale helpers used by BOTH the deploy script (scripts/service.ts) and the runtime funnel
 * watchdog (src/host/funnel-watchdog.ts). They must agree: the watchdog re-establishes Funnel with the same
 * port and posture the deploy configured, so "how do we find tailscale / this node's public name / the
 * expose mode" lives here once rather than drifting between deploy-time and runtime copies.
 *
 * Stdlib only, strip-clean (no transform-requiring syntax — see CLAUDE.md ▸ dev path).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ExposeMode = 'public' | 'tailnet'

/** The relay's loopback port — what Funnel/Serve proxy to. Mirrors config.ts (`RELAY_PORT ?? 8787`). */
export function relayPort(): string {
	return String(process.env.RELAY_PORT ?? 8787)
}

/** Locate the tailscale CLI: PATH first, then the common macOS install locations. Null if absent. */
export function tailscaleBin(): string | null {
	for (const bin of [
		'tailscale',
		'/opt/homebrew/bin/tailscale',
		'/usr/local/bin/tailscale',
		'/Applications/Tailscale.app/Contents/MacOS/Tailscale'
	]) {
		try {
			execFileSync(bin, ['version'], { stdio: 'pipe' })
			return bin
		} catch {
			// try the next candidate
		}
	}
	return null
}

/** This node's MagicDNS name without the trailing dot, e.g. `mac.taila6dcd6.ts.net`. Null if unknown. */
export function magicDnsName(bin: string): string | null {
	try {
		const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: 'pipe' })
		return (JSON.parse(out)?.Self?.DNSName ?? '').replace(/\.$/, '') || null
	} catch {
		return null
	}
}

/** Where the chosen expose mode is persisted (written by the deploy script; read-only here). */
export function exposeStorePath(): string {
	return path.join(os.homedir(), 'Library', 'Application Support', 'conductor-remote', 'expose')
}

export function normalizeExposeMode(raw: string | undefined): ExposeMode | null {
	const v = raw?.trim().toLowerCase()
	if (v === 'public' || v === 'funnel') return 'public'
	if (v === 'tailnet' || v === 'serve' || v === 'private') return 'tailnet'
	return null
}

/**
 * Read-only resolve of the expose posture: `EXPOSE` env > persisted choice > 'public' default. Unlike the
 * deploy script's resolveExposeMode(), this never writes the persisted file — the runtime only observes.
 */
export function readExposeMode(): ExposeMode {
	const fromEnv = normalizeExposeMode(process.env.EXPOSE)
	if (fromEnv) return fromEnv
	try {
		const saved = normalizeExposeMode(fs.readFileSync(exposeStorePath(), 'utf8'))
		if (saved) return saved
	} catch {
		// no saved choice yet
	}
	return 'public'
}

/** Where the phone-URL host (this node's MagicDNS name at deploy time) is recorded, so a later drift is detectable. */
export function urlHostStorePath(): string {
	return path.join(os.homedir(), 'Library', 'Application Support', 'conductor-remote', 'url-host')
}

/** The MagicDNS name the saved phone URL was issued for, or null if never deployed with a drift-aware build. */
export function readUrlHost(): string | null {
	try {
		return fs.readFileSync(urlHostStorePath(), 'utf8').trim() || null
	} catch {
		return null
	}
}

/** Record the name the phone URL uses now, so a future rename can be flagged. Best-effort. */
export function writeUrlHost(name: string): void {
	try {
		fs.mkdirSync(path.dirname(urlHostStorePath()), { recursive: true })
		fs.writeFileSync(urlHostStorePath(), name)
	} catch {
		// non-fatal: drift detection is a convenience, not a correctness requirement
	}
}

/**
 * Has this node's MagicDNS name drifted from the one the saved phone URL points at? Tailscale derives the
 * name from the Mac's hostname unless pinned (see service.ts ▸ pinHostname), and an OS update/reset can move
 * it — silently bricking the installed PWA, which is bolted to the old origin. Returns both names when they
 * disagree so callers can warn; null when there's no baseline yet or they still match.
 */
export function hostDrift(bin: string): { expected: string; current: string } | null {
	const expected = readUrlHost()
	if (!expected) return null
	const current = magicDnsName(bin)
	if (!current || current === expected) return null
	return { expected, current }
}

/** Ready-to-print, actionable warning lines if the phone URL's host drifted; empty when all is well. */
export function driftWarningLines(bin: string): string[] {
	const drift = hostDrift(bin)
	if (!drift) return []
	return [
		`  ⚠ Tailscale device name changed: "${drift.expected}" → "${drift.current}".`,
		`    The saved phone URL https://${drift.expected}/ no longer resolves — the installed PWA will fail to load.`,
		`    Restore the old URL:  conductor-remote service install --hostname ${drift.expected.split('.')[0]}`,
		`    …or re-add the PWA at the new URL:  https://${drift.current}/`
	]
}

// ── `tailscale serve status --json` ─────────────────────────────────────────────────────────────────

/** The parts of `tailscale serve status --json` read here. Keys of `Web`/`AllowFunnel` are `<host>:<port>`. */
export interface ServeStatus {
	TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string }>
	Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>
	AllowFunnel?: Record<string, boolean>
}

/**
 * Where Tailscale fronts the relay, if anywhere. The relay is not always on :443: Funnel only listens on
 * 443, 8443 and 10000, and OpenAI's cloud only ever dials 443 (measured 2026-09-02), so a voice listener
 * that needs a webhook owns :443 and the relay moves to a tailnet-only port of its own. A reader that
 * assumes `<host>:443` then reports a reachable relay as unreachable, and a writer that asserts :443
 * deletes the mount that lives there.
 */
export interface RelayServeState {
	/** HTTPS port whose `/` mount proxies to the relay; null when nothing does. Prefers 443 when several do. */
	port: number | null
	/** Funnel (public internet) is on for that port. Always false while `port` is null. */
	funnelOn: boolean
	/** Other mounts on the relay's port, e.g. `/voice → http://127.0.0.1:3333`. Funnel is per port, so a
	 *  posture change there would drag these along — a shared port is left exactly as found. */
	shared: string[]
	/** Every port carrying a mount the relay does not own, so a fresh mount can step around them. */
	taken: Map<number, string[]>
}

/** Tailscale's Funnel listens on these ports only; a tailnet-only `serve` may use any port. */
export const FUNNEL_PORTS = [443, 8443, 10000]

/** `tailscale serve status --json` prints `null` for an empty config, and anything else is not a status. */
export function parseServeStatus(out: string): ServeStatus {
	try {
		const parsed: unknown = JSON.parse(out)
		return parsed && typeof parsed === 'object' ? (parsed as ServeStatus) : {}
	} catch {
		return {}
	}
}

function portOf(hostPort: string): number | null {
	const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1))
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function describeHandler(handler: { Proxy?: string; Path?: string; Text?: string }): string {
	return handler.Proxy ?? handler.Path ?? (handler.Text !== undefined ? 'text' : 'unknown')
}

/** Pure: reads one parsed status, so a saved JSON can drive it in a test. `relayPort` is the loopback port. */
export function relayServeState(status: ServeStatus, relayPort: string | number): RelayServeState {
	const relayTargets = new Set([`http://127.0.0.1:${relayPort}`, `http://localhost:${relayPort}`])
	const owned = new Map<number, string>() // port → the host:port key, for the AllowFunnel lookup
	const taken = new Map<number, string[]>()
	const claim = (port: number, what: string) => {
		const list = taken.get(port) ?? []
		list.push(what)
		taken.set(port, list)
	}
	for (const [key, web] of Object.entries(status.Web ?? {})) {
		const port = portOf(key)
		if (port === null) continue
		for (const [mount, handler] of Object.entries(web.Handlers ?? {})) {
			const relay = handler.Proxy !== undefined && relayTargets.has(handler.Proxy)
			if (relay && mount === '/') {
				if (!owned.has(port) || port === 443) owned.set(port, key)
				continue
			}
			// A relay mount off the root is not a phone URL, and not a stranger either: neither owned nor taken.
			if (!relay) claim(port, `${mount} → ${describeHandler(handler)}`)
		}
	}
	for (const [key, tcp] of Object.entries(status.TCP ?? {})) {
		const port = portOf(key)
		if (port === null) continue
		if (tcp.TCPForward) claim(port, `tcp → ${tcp.TCPForward}`)
	}
	const port = owned.has(443) ? 443 : ([...owned.keys()].sort((a, b) => a - b)[0] ?? null)
	const key = port === null ? undefined : owned.get(port)
	return {
		port,
		funnelOn: key !== undefined && status.AllowFunnel?.[key] === true,
		shared: port === null ? [] : (taken.get(port) ?? []),
		taken
	}
}

/** The first candidate port carrying nothing the relay does not own, or null when every one is spoken for. */
export function freeServePort(state: RelayServeState, candidates: number[]): number | null {
	return candidates.find(port => !state.taken.has(port)) ?? null
}

/** The phone URL for a node name and the HTTPS port fronting the relay — no port suffix on 443. */
export function serveUrl(host: string, port: number): string {
	return `https://${host}${port === 443 ? '' : `:${port}`}/`
}
