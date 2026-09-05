import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ExposeMode, RelayServeState, ServeStatus } from '../../src/host/tailscale.ts'
import {
	exposeStorePath,
	FUNNEL_PORTS,
	freeServePort,
	magicDnsName,
	normalizeExposeMode,
	parseServeStatus,
	relayServeState,
	serveUrl,
	tailscaleBin,
	writeUrlHost
} from '../../src/host/tailscale.ts'
import { RELAY_PORT } from './environment.ts'
import { sleepSync } from './launch-agent.ts'

/**
 * Resolve the expose mode. Precedence: `EXPOSE` env (public|funnel / tailnet|serve|private) > persisted
 * choice > 'public' default. An explicit env value is persisted so re-deploys don't silently flip posture.
 * (The read-only counterpart used by the runtime watchdog is readExposeMode() in src/host/tailscale.ts.)
 */
export function resolveExposeMode(): ExposeMode {
	const fromEnv = normalizeExposeMode(process.env.EXPOSE)
	if (fromEnv) {
		try {
			const file = exposeStorePath()
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, fromEnv)
		} catch {
			// persistence is a convenience; ignore failures
		}
		return fromEnv
	}
	if (process.env.EXPOSE) console.info(`  ⚠ unrecognized EXPOSE=${process.env.EXPOSE} — expected public|tailnet.`)
	try {
		const saved = normalizeExposeMode(fs.readFileSync(exposeStorePath(), 'utf8'))
		if (saved) return saved
	} catch {
		// no saved choice yet
	}
	return 'public'
}

/**
 * Live serve/funnel state for this node as it concerns the relay: the HTTPS port fronting it (any port, not
 * only :443), whether that port is public, and which ports carry mounts that are not the relay's. A status
 * that cannot be read counts as nothing fronting — the same answer the old reader gave, and one that only
 * ever leads to a mount on a port nobody holds.
 */
export function tailscaleState(bin: string, port: string = RELAY_PORT): RelayServeState {
	try {
		const out = execFileSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: 'pipe' })
		return relayServeState(parseServeStatus(out), port)
	} catch {
		return relayServeState({}, port)
	}
}

export function rawTailscaleStatus(bin: string): ServeStatus {
	try {
		return parseServeStatus(execFileSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: 'pipe' }))
	} catch {
		return {}
	}
}

/**
 * The one Tailscale write here: `tailscale <serve|funnel> --bg --https=<port> <relay port>`. Always scoped
 * to a port the relay owns outright or nobody holds — the callers check, this does not. Serving a port
 * Funnel currently exposes drops that port's Funnel flag and touches no other port, which is what made
 * the old `funnel reset` (every mount on the node, gone) unnecessary. Returns the CLI's error, or null.
 */
export function mountRelay(bin: string, kind: 'serve' | 'funnel', port: number): string | null {
	try {
		execFileSync(bin, [kind, '--bg', '--yes', `--https=${port}`, RELAY_PORT], { stdio: 'pipe' })
		return null
	} catch (err) {
		return err instanceof Error ? err.message.trim() : String(err)
	}
}

function byHand(kind: 'serve' | 'funnel', port: number | string): string {
	return `tailscale ${kind} --bg --yes --https=${port} ${RELAY_PORT}`
}

function describeTaken(state: RelayServeState, port: number): string {
	return (state.taken.get(port) ?? []).join(', ')
}

/** A port the relay shares is left exactly as found: Funnel is per port, so a change would drag the rest along. */
function leaveShared(url: string, state: RelayServeState, want: 'public' | 'tailnet-only'): void {
	console.info(`\n  ⚠ ${url} fronts the relay, but :${state.port} also carries ${state.shared.join(', ')}.`)
	console.info(`    Funnel is per port, so making the relay ${want} would take those mounts along. Left as is.`)
	console.info(
		`    To change it, move the relay to a port of its own:  ${byHand(want === 'public' ? 'funnel' : 'serve', '<port>')}`
	)
}

function refuseNoPort(state: RelayServeState, candidates: number[]): void {
	const held = candidates.map(p => `:${p} → ${describeTaken(state, p)}`).join('; ')
	console.info(`\n  ⚠ every port the relay could take already carries another service (${held}). Not touching them.`)
	console.info(`    Free one, then run \`yarn deploy\` again — or mount by hand:  ${byHand('serve', '<port>')}`)
}

/**
 * Assert a tailnet-only `serve` proxy in front of the relay — tailnet mode, and the fallback when Funnel is
 * refused. Non-destructive by construction: a mapping is kept wherever it already lives (:443 or not), a
 * shared port is reported rather than rewritten, and a fresh mount steps around any port someone else holds.
 * The order of candidates is 443 (the default, unchanged), then the relay's own port number — the memorable
 * choice, and it leaves 8443/10000 for services that need Funnel — then the remaining Funnel ports.
 */
function ensureServeOnly(bin: string, dns: string | null, state: RelayServeState): void {
	const host = dns ?? '<node>'
	if (state.port !== null) {
		const url = serveUrl(host, state.port)
		if (!state.funnelOn) {
			console.info(`✓ tailscale serve fronts ${url} → 127.0.0.1:${RELAY_PORT} (tailnet-only)`)
			return
		}
		if (state.shared.length) {
			leaveShared(url, state, 'tailnet-only')
			return
		}
		const failed = mountRelay(bin, 'serve', state.port)
		if (failed) {
			console.info(
				`\n  ⚠ could not take Funnel off ${url} (${failed}). Run by hand:\n      ${byHand('serve', state.port)}`
			)
			return
		}
		console.info(`✓ tailscale serve → ${url} is tailnet-only again → 127.0.0.1:${RELAY_PORT}`)
		return
	}
	const candidates = [443, Number(RELAY_PORT), ...FUNNEL_PORTS.filter(p => p !== 443)]
	const port = freeServePort(state, candidates)
	if (port === null) {
		refuseNoPort(state, candidates)
		return
	}
	if (port !== 443) console.info(`  :443 carries ${describeTaken(state, 443)}, so the relay goes on :${port} instead.`)
	const url = serveUrl(host, port)
	const failed = mountRelay(bin, 'serve', port)
	if (failed) {
		console.info(`\n  ⚠ could not configure tailscale serve (${failed}). Run by hand:\n      ${byHand('serve', port)}`)
		return
	}
	console.info(`✓ tailscale serve → ${url} proxies 127.0.0.1:${RELAY_PORT} (tailnet-only)`)
}

/**
 * Persist a stable Tailscale device name so this node's MagicDNS URL — the origin the installed PWA is
 * bolted to — can't drift out from under it. Tailscale otherwise *derives* the name from the Mac's
 * LocalHostName, which a macOS update or a network/settings reset can silently clear; the name then moves
 * (e.g. `mac` → `macbook-pro`), the URL changes, and every home-screen PWA pinned to the old origin dies
 * with an unexplained "failed to fetch". We pin `--hostname`/`RELAY_HOSTNAME` when given (also the way to
 * *rename* — `--hostname mac` restores a drifted node), else re-pin whatever name the node already has: a
 * no-op on today's URL, but it turns an auto-derived name into an explicit one Tailscale won't re-derive.
 * Best-effort — a failure just leaves the name auto-derived, exactly as before this ran.
 */
function pinHostname(bin: string): void {
	const label = (dns: string | null): string => (dns ?? '').split('.')[0]
	const current = label(magicDnsName(bin))
	const desired = (process.env.RELAY_HOSTNAME ?? '').trim() || current
	if (!desired) return // node name unknown and none requested — nothing to pin
	try {
		execFileSync(bin, ['set', `--hostname=${desired}`], { stdio: 'pipe' })
	} catch (err) {
		console.info(
			`  ⚠ could not pin tailscale hostname to "${desired}" (${err instanceof Error ? err.message.trim() : err}) — name stays auto-derived.`
		)
		return
	}
	if (desired === current) {
		console.info(`✓ tailscale device name pinned to "${desired}" (won't drift on an OS hostname change)`)
		return
	}
	// A rename: wait briefly for MagicDNS to reflect it, so the URL and Funnel cert below use the new name.
	for (let i = 0; i < 12 && label(magicDnsName(bin)) !== desired; i++) sleepSync(500)
	const actual = label(magicDnsName(bin))
	if (actual === desired)
		console.info(`✓ tailscale device renamed "${current || '<derived>'}" → "${desired}" and pinned`)
	else
		console.info(
			`  ⚠ requested hostname "${desired}" but the tailnet assigned "${actual}" (name likely already taken) — your URL is https://${actual}.…`
		)
}

/**
 * Front the loopback relay with a stable HTTPS URL, either publicly (`tailscale funnel`, the default) or
 * tailnet-only (`tailscale serve`), per resolveExposeMode(). Idempotent — flips Funnel off when switching
 * back to tailnet — and non-fatal: the relay binds loopback regardless, so a failure here just means the
 * phone URL isn't wired yet and we print how to do it by hand. Real TLS also satisfies the PWA's
 * secure-context requirement (a service worker won't register over plain http on a 100.x IP).
 *
 * PUBLIC IS INTERNET-FACING: the 128-bit token on every /api/* request is the only gate. Funnel must be
 * enabled for the tailnet (Admin console) or the funnel command fails — we then fall back to tailnet-only.
 */
export function ensureTailscale(): void {
	const bin = tailscaleBin()
	if (!bin) {
		console.info('\n  ⚠ tailscale CLI not found — skipped URL setup. Once Tailscale is installed, run:')
		console.info(`      tailscale funnel --bg ${RELAY_PORT}   # public, or \`serve\` for tailnet-only`)
		return
	}
	pinHostname(bin)
	const dns = magicDnsName(bin)
	if (dns) writeUrlHost(dns) // baseline for drift detection (server startup + `service status` compare against this)
	const host = dns ?? '<node>'
	const mode = resolveExposeMode()
	const state = tailscaleState(bin)

	if (mode === 'tailnet') {
		ensureServeOnly(bin, dns, state)
		return
	}

	// public (Funnel)
	if (state.port !== null) {
		const url = serveUrl(host, state.port)
		if (state.funnelOn) {
			console.info(`✓ tailscale funnel already exposes ${url} → 127.0.0.1:${RELAY_PORT} (public, token-gated)`)
			return
		}
		if (state.shared.length) {
			leaveShared(url, state, 'public')
			return
		}
		if (!FUNNEL_PORTS.includes(state.port)) {
			console.info(`\n  ⚠ the relay is fronted tailnet-only at ${url}, and Funnel cannot listen on :${state.port}`)
			console.info(
				`    (only ${FUNNEL_PORTS.join(', ')}). Left as is — \`conductor-remote config\` will show the mismatch.`
			)
			console.info(`    To go public, move it to a Funnel port by hand:  ${byHand('funnel', '<443|8443|10000>')}`)
			return
		}
		const failed = mountRelay(bin, 'funnel', state.port)
		if (failed) {
			funnelRefused(failed)
			ensureServeOnly(bin, dns, state)
			return
		}
		console.info(`✓ tailscale funnel → ${url} now public over the internet (token-gated) → 127.0.0.1:${RELAY_PORT}`)
		return
	}
	const port = freeServePort(state, FUNNEL_PORTS)
	if (port === null) {
		refuseNoPort(state, FUNNEL_PORTS)
		return
	}
	if (port !== 443) console.info(`  :443 carries ${describeTaken(state, 443)}, so the relay goes on :${port} instead.`)
	const failed = mountRelay(bin, 'funnel', port)
	if (failed) {
		funnelRefused(failed)
		ensureServeOnly(bin, dns, state)
		return
	}
	console.info(
		`✓ tailscale funnel → ${serveUrl(host, port)} now public over the internet (token-gated) → 127.0.0.1:${RELAY_PORT}`
	)
}

function funnelRefused(error: string): void {
	console.info(`\n  ⚠ could not enable Funnel (${error}).`)
	console.info('    Funnel must be enabled for this tailnet: open the URL Tailscale printed above, or add the')
	console.info('    "funnel" nodeAttr in Admin console ▸ Access controls. Falling back to tailnet-only for now.')
}
