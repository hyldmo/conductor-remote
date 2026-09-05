/**
 * Keeps the phone's public URL actually reachable.
 *
 * Tailscale Funnel exposes the loopback relay to the internet by having tailscaled hold a registration
 * with Tailscale's Funnel *ingress* relays; public clients hit those relays, which forward the TLS stream
 * to this node. That registration goes STALE after a network transition (Wi-Fi ⇄ iPhone hotspot, a new
 * DHCP lease, sleep/wake) — especially behind the symmetric NAT common at offices, where the node's
 * public endpoint keeps moving. When it does, `tailscale funnel status` still cheerfully reports "Funnel
 * on" and tailscaled keeps its local :443 listener up, but the ingress can no longer reach the node: the
 * phone (and any desktop tab) sits on "Offline — retrying" until someone manually re-runs `funnel reset`.
 * Nothing self-heals it. (See FINDINGS / the funnel-ingress-stale note.)
 *
 * So this watchdog does NOT trust any local funnel status. It probes the REAL public path end-to-end —
 * resolving the node's MagicDNS name against a *public* resolver to get the ingress IPs (never the tailnet
 * 100.x address, which would mask the break exactly like a `--resolve` to the node does), then an HTTPS
 * GET /health pinned to an ingress IP with the node's SNI. A healthy funnel answers; a stale one fails the
 * TLS/HTTP exchange entirely. After a few consecutive failures — and only when the ingress is TCP-reachable,
 * so a plain internet outage doesn't trigger a pointless reset — it re-registers with
 * `tailscale funnel reset && tailscale funnel --bg --yes <port>`, then waits for propagation. The periodic
 * probe doubles as keepalive traffic through the ingress, which also helps hold the mapping open.
 *
 * Gated like the self-updater: only the launchd-managed daemon (`CONDUCTOR_REMOTE_MANAGED=1`) in public
 * (Funnel) posture runs it. `FUNNEL_WATCHDOG=off` disables; `on` forces it where a tailscale CLI + Funnel
 * posture exist. Stdlib + global fetch/dns/https only — no runtime deps, strip-clean.
 */
import { execFile } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { promisify } from 'node:util'
import { readSettings } from '../settings.ts'
import { joinInstantHotspot } from '../writes/system.ts'
import {
	magicDnsName,
	parseServeStatus,
	readExposeMode,
	relayPort,
	relayServeState,
	tailscaleBin
} from './tailscale.ts'
import { hasDefaultRoute, joinNetwork, preferredNetworks } from './wifi.ts'

const execFileP = promisify(execFile)

const PROBE_PATH = '/health' // unauthenticated 200 on the relay — no token needed to prove reachability
const PROBE_TIMEOUT_MS = 8000
const TCP_TIMEOUT_MS = 4000
const FIRST_DELAY_MS = 20 * 1000 // let the relay + funnel settle after a (re)start before the first probe
// Consecutive failed probes before we re-register. A single miss is often a transient blip; a stale ingress
// stays broken until reset, so waiting for N in a row costs a little detection latency to avoid a needless
// funnel reset (which itself briefly drops clients). ~N×interval of confirmed-down before acting.
const FAIL_THRESHOLD = 3
const HEAL_COOLDOWN_MS = 120 * 1000 // min gap between re-registrations, so a persistent fault can't hammer funnel
const POST_HEAL_MS = 60 * 1000 // after a reset, give the control plane time to propagate before re-probing

/** Probe cadence. Frequent enough to detect a stale ingress within a couple minutes and to keep the mapping warm. */
function resolveIntervalMs(): number {
	const raw = Number(process.env.FUNNEL_WATCHDOG_INTERVAL_SECONDS)
	const seconds = Number.isFinite(raw) && raw > 0 ? raw : 60
	return Math.max(seconds, 15) * 1000
}

function log(msg: string): void {
	console.info(`[funnel-watchdog] ${msg}`)
}

function wantEnabled(): boolean {
	const raw = process.env.FUNNEL_WATCHDOG?.trim().toLowerCase()
	if (raw === 'off' || raw === 'false' || raw === '0') return false
	if (raw === 'on' || raw === 'true' || raw === '1') return true
	return process.env.CONDUCTOR_REMOTE_MANAGED === '1' // default: only the managed daemon
}

/**
 * Public A records for `host` — the Funnel ingress IPs. Queried against public resolvers so MagicDNS on
 * this node can't answer with the tailnet 100.x address (which would make every probe hit the node directly
 * and never see an ingress break). Falls back to the system resolver only if the public query fails.
 */
async function ingressIps(host: string): Promise<string[]> {
	try {
		const r = new Resolver({ timeout: 4000, tries: 2 })
		r.setServers(['1.1.1.1', '8.8.8.8'])
		const ips = await r.resolve4(host)
		if (ips.length) return ips
	} catch {
		// public resolver blocked/unreachable — fall through to the system resolver
	}
	try {
		const { lookup } = await import('node:dns/promises')
		const all = await lookup(host, { all: true, family: 4 })
		return all.map(a => a.address)
	} catch {
		return []
	}
}

/** GET https://host<PROBE_PATH> but pinned to `ip` (an ingress relay) with SNI=host. Resolves the HTTP status
 *  code; rejects if the TLS/HTTP exchange never completes — the signature of a stale ingress. */
function probeVia(ip: string, host: string, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: ip,
				port: 443,
				servername: host, // SNI so the ingress routes to this node and the node's cert validates
				path: PROBE_PATH,
				method: 'GET',
				headers: { host, 'user-agent': 'conductor-remote-funnel-watchdog' },
				timeout: timeoutMs
			},
			res => {
				res.resume() // drain so the socket can close
				resolve(res.statusCode ?? 0)
			}
		)
		req.on('timeout', () => req.destroy(new Error('probe timeout')))
		req.on('error', reject)
		req.end()
	})
}

/** True if a bare TCP connection to `ip:port` opens — i.e. the internet + ingress are reachable, isolating
 *  "stale funnel stream" (heal-worthy) from "no connectivity" (nothing to fix, don't churn). */
function tcpOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host: ip, port })
		const finish = (ok: boolean) => {
			socket.destroy()
			resolve(ok)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

/**
 * The heal is `funnel reset` + `funnel --bg <port>`, which mounts the relay on :443. That is refused when
 * :443 carries a mount that is not the relay's, or the relay is served on another port — the arrangement
 * once another service needs :443 (OpenAI's cloud dials nothing else, measured 2026-09-02, so the voice
 * listener holds :443 and the relay sits tailnet-only on :8787). The probe above was never reaching the
 * relay in that case, and the heal would delete the mount it did reach. Fails closed: a status that cannot
 * be read blocks the heal, never allows it.
 */
async function reRegisterBlocked(bin: string, port: string): Promise<string | null> {
	try {
		const { stdout } = await execFileP(bin, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 })
		const state = relayServeState(parseServeStatus(stdout), port)
		const foreign = state.taken.get(443)
		if (foreign?.length) return `:443 carries ${foreign.join(', ')}`
		if (state.port !== null && state.port !== 443) return `the relay is served on :${state.port}, not :443`
		return null
	} catch (err) {
		return `could not read tailscale serve status (${err instanceof Error ? err.message.trim() : String(err)})`
	}
}

async function reRegisterFunnel(bin: string, port: string): Promise<void> {
	const blocked = await reRegisterBlocked(bin, port)
	if (blocked) throw new Error(`not re-registering, ${blocked}`)
	await execFileP(bin, ['funnel', 'reset'], { timeout: 15_000 })
	await execFileP(bin, ['funnel', '--bg', '--yes', port], { timeout: 20_000 })
}

/**
 * Move to a fallback network and, if that worked, re-register Funnel — a new network means
 * a new public endpoint, which is the exact condition that leaves the old ingress stale.
 * Resets the fail count so the next tick judges the new link on its own merits.
 */
async function rejoinAndReRegister(bin: string, port: string): Promise<void> {
	if (!(await tryRejoin())) return
	try {
		await reRegisterFunnel(bin, port)
		lastHealAt = Date.now()
		fails = 0
		dnsFails = 0
		log('re-registered funnel on the new network')
	} catch (err) {
		log(`funnel re-register after rejoin failed: ${err instanceof Error ? err.message.trim() : String(err)}`)
	}
}

/**
 * Two counters, because they answer different questions and only one of them may spend a
 * funnel reset. `fails` counts probes that reached DNS and still failed — the evidence a
 * re-registration needs, and the reason the threshold is 3 rather than 1, since a reset
 * briefly drops every client. `dnsFails` counts ticks where the name wouldn't resolve at
 * all, which proves nothing about the funnel and only ever feeds the rejoin branch.
 * Sharing one counter let two unresolvable ticks plus a single failed probe buy a reset.
 */
let fails = 0
let dnsFails = 0
let lastHealAt = 0
let lastRejoinAt = 0
let blockedLogged: string | null = null

const REJOIN_COOLDOWN_MS = 5 * 60 * 1000 // a network switch is disruptive; never churn on one
const REJOIN_SETTLE_MS = 12 * 1000 // DHCP + tailscaled noticing the new endpoint
// An Instant Hotspot press has the phone's Bluetooth wake + hotspot spin-up in front of the
// same DHCP wait, so it gets a longer leash than a plain join before the tick gives up on it.
const HOTSPOT_SETTLE_MS = 30 * 1000

/** Poll for the default route instead of one fixed sleep — a join that lands early returns early. */
async function routeAppeared(waitMs: number): Promise<boolean> {
	const until = Date.now() + waitMs
	while (Date.now() < until) {
		if (await hasDefaultRoute()) return true
		await new Promise(r => setTimeout(r, 3000))
	}
	return hasDefaultRoute()
}

/**
 * Last resort when the probe is down: this Mac has no link at all, so move it onto a
 * configured fallback (your phone's hotspot) and re-register Funnel, whose ingress a
 * change of public endpoint invalidates anyway.
 *
 * The guards matter more than the action. Switching Wi-Fi networks can take a working
 * Mac off a working network, so this borrows the shape of `serverWindowCount()`'s veto in
 * src/writes/applescript/window.applescript: **a probe that can't answer must prevent the action, never cause it.**
 *  - Opt-in only (`autoRejoin`), and only with somewhere to go.
 *  - Only when `hasDefaultRoute()` is definitively false. That probe needs no permission
 *    grant, unlike reading the SSID, which macOS refuses without Location Services and
 *    which therefore can never gate anything here.
 *  - Only into a network macOS already holds credentials for, so no password is stored
 *    or passed; an SSID that isn't in the preferred list is named in the log, not tried.
 *  - Behind a cooldown, so a Mac that is simply off the air doesn't cycle its Wi-Fi.
 *
 * Two ways in, tried in order. `networksetup` first — cheap, no UI — and when it answers
 * "Could not find network" (a hotspot doesn't broadcast until asked), the Accessibility
 * press on the Wi-Fi menu's own row (`joinInstantHotspot` in src/writes/system.ts), which wakes the
 * phone's hotspot over Continuity exactly like clicking it. The press needs an unlocked
 * screen — the lock hides the session from Accessibility, and the failure names that —
 * so a lid-closed Mac still wants macOS's own Auto-Join Hotspot set to Automatic as the
 * layer below this one.
 *
 * Returns true if a join reported success, meaning the caller should re-register rather
 * than treat this tick as an ordinary failure.
 */
async function tryRejoin(): Promise<boolean> {
	const { autoRejoin, fallbackSsids } = readSettings()
	if (!autoRejoin || fallbackSsids.length === 0) return false
	if (Date.now() - lastRejoinAt < REJOIN_COOLDOWN_MS) return false
	if (await hasDefaultRoute()) return false // link is up; whatever is broken, it isn't this

	const known = new Set(await preferredNetworks())
	const candidates = fallbackSsids.filter(s => known.has(s))
	const skipped = fallbackSsids.filter(s => !known.has(s))
	if (skipped.length) log(`fallback SSID(s) this Mac has no saved credentials for, skipping: ${skipped.join(', ')}`)
	if (candidates.length === 0) return false

	lastRejoinAt = Date.now()
	for (const ssid of candidates) {
		log(`no default route — joining fallback network "${ssid}"`)
		let settleMs = REJOIN_SETTLE_MS
		const joined = await joinNetwork(ssid)
		if (!joined.ok) {
			log(`join "${ssid}" failed: ${joined.error}`)
			// networksetup can only join a network that is broadcasting, and a personal
			// hotspot usually isn't — its row in the Wi-Fi menu arrives over Continuity,
			// and pressing it wakes the hotspot the way clicking it by hand does. Tried
			// for every failed candidate rather than only hotspot-looking names: the
			// name heuristic never decides anything (see looksLikeHotspot), and for an
			// ordinary network that's simply out of range the press fails in words
			// ("not in the Wi-Fi menu") that cost one popover flash.
			log(`pressing the Wi-Fi menu's "${ssid}" row instead (Instant Hotspot)`)
			const pressed = await joinInstantHotspot(ssid)
			if (!pressed.ok) {
				log(`Instant Hotspot press for "${ssid}" failed: ${pressed.error}`)
				continue
			}
			settleMs = HOTSPOT_SETTLE_MS
		}
		if (await routeAppeared(settleMs)) {
			log(`joined "${ssid}" and the link is up`)
			return true
		}
		log(`joined "${ssid}" but no default route appeared after ${settleMs / 1000}s`)
	}
	return false
}

function schedule(fn: () => void, delayMs: number): void {
	setTimeout(fn, delayMs).unref()
}

async function tick(host: string, bin: string, port: string, intervalMs: number): Promise<void> {
	const again = (delay: number) => schedule(() => void tick(host, bin, port, intervalMs), delay)
	const ips = await ingressIps(host)
	if (ips.length === 0) {
		// Can't resolve the ingress at all — can't confirm a *funnel* fault, so never heal.
		// But a dead link looks exactly like this, and that is fixable: tryRejoin decides for
		// itself, starting from whether there is genuinely no route off this Mac. Counted
		// apart from `fails`, which is the evidence a funnel reset spends.
		dnsFails++
		if (dnsFails >= FAIL_THRESHOLD) await rejoinAndReRegister(bin, port)
		return again(intervalMs)
	}
	dnsFails = 0
	const ip = ips[0]

	let healthy = false
	try {
		const status = await probeVia(ip, host, PROBE_TIMEOUT_MS)
		healthy = status > 0 && status < 500 // any real HTTP answer means the ingress reached the node
	} catch {
		healthy = false
	}

	if (healthy) {
		if (fails > 0) log(`ingress healthy again after ${fails} failed probe(s)`)
		fails = 0
		return again(intervalMs)
	}

	fails++
	if (fails < FAIL_THRESHOLD) return again(intervalMs)

	// Confirmed down. Only re-register if the ingress is actually reachable (internet up) — otherwise it's a
	// connectivity outage that will clear on its own, and a funnel reset would just churn.
	const reachable = await tcpOpen(ip, 443, TCP_TIMEOUT_MS)
	if (!reachable) {
		log(`ingress ${ip} unreachable after ${fails} probes — looks offline, not re-registering`)
		// "Offline" is the one funnel-reset can't fix and a rejoin sometimes can.
		await rejoinAndReRegister(bin, port)
		return again(intervalMs)
	}
	if (Date.now() - lastHealAt < HEAL_COOLDOWN_MS) return again(intervalMs)

	// A block is a standing fact, so it is logged when it changes and not once a minute for as long as it holds.
	const blocked = await reRegisterBlocked(bin, port)
	if (blocked) {
		if (blocked !== blockedLogged) log(`ingress probe failing (${fails}), but not re-registering: ${blocked}`)
		blockedLogged = blocked
		return again(intervalMs)
	}
	blockedLogged = null

	log(
		`funnel ingress stale (${fails} failed probes, ingress TCP-reachable) — re-registering: funnel reset && funnel --bg ${port}`
	)
	try {
		await reRegisterFunnel(bin, port)
		lastHealAt = Date.now()
		fails = 0
		log(`re-registered funnel; waiting ${POST_HEAL_MS / 1000}s for the ingress to propagate`)
		return again(POST_HEAL_MS)
	} catch (err) {
		log(`funnel re-register failed: ${err instanceof Error ? err.message.trim() : String(err)} — will retry`)
		return again(intervalMs)
	}
}

/** Start the funnel watchdog. Safe to call unconditionally — no-ops unless the gates pass. */
export function startFunnelWatchdog(): void {
	if (!wantEnabled()) return
	if (readExposeMode() !== 'public') {
		// Funnel-specific: in tailnet (serve) posture there's no public ingress to keep alive.
		if (process.env.FUNNEL_WATCHDOG) log('skipped: expose posture is tailnet (serve), not public (funnel)')
		return
	}
	const bin = tailscaleBin()
	if (!bin) {
		log('skipped: tailscale CLI not found')
		return
	}
	const host = magicDnsName(bin)
	if (!host) {
		log('skipped: no MagicDNS name for this node')
		return
	}
	const port = relayPort()
	const intervalMs = resolveIntervalMs()
	log(
		`enabled; probing https://${host}${PROBE_PATH} via the public ingress every ${intervalMs / 1000}s (heal after ${FAIL_THRESHOLD} fails)`
	)
	schedule(() => void tick(host, bin, port, intervalMs), FIRST_DELAY_MS)
}
