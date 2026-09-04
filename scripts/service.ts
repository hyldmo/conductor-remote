/**
 * Deploy the relay as a macOS LaunchAgent — the only "deployment" this app has, since it must run
 * on the Mac that runs Conductor (local SQLite DB, git worktrees, and the sidecar unix socket all
 * live there). Installs a per-user agent that starts the relay on login and keeps it alive.
 *
 *   node scripts/service.ts <install|uninstall|status|restart>
 *   (or, once installed globally: `conductor-remote service <...>`)
 *
 * `yarn deploy` builds dist/ first, then runs `install`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installedServiceEnvironment, serviceEnvironmentWithSetting } from '../src/config.ts'
import { packageRoot } from '../src/pkg-root.ts'
import type { ExposeMode, RelayServeState, ServeStatus } from '../src/tailscale.ts'
import {
	driftWarningLines,
	exposeStorePath,
	FUNNEL_PORTS,
	freeServePort,
	magicDnsName,
	normalizeExposeMode,
	parseServeStatus,
	relayPort,
	relayServeState,
	serveUrl,
	tailscaleBin,
	writeUrlHost
} from '../src/tailscale.ts'
import { readVoiceConfig, setVoiceSetting, VOICE_SETTING_NAMES } from '../src/voice/config.ts'
import {
	inspectVoiceFunnel,
	readVoiceFunnelReceipt,
	type VoiceFunnelReceipt,
	voiceFunnelReceiptPath,
	writeVoiceFunnelReceipt
} from '../src/voice/funnel.ts'
import { qrLines } from './qr.ts'

const LABEL = 'no.adluna.conductor-remote'
const projectDir = packageRoot(import.meta.dirname)
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'conductor-remote')
const uid = process.getuid?.() ?? 0
const domain = `gui/${uid}`

/**
 * Install-time knobs are accepted as documented CLI flags OR the matching env var — a flag wins over the
 * ambient env. Parsed flags are folded back into process.env so everything downstream (and the plist we
 * bake) keeps reading a single source. Runs before any module-level env read below.
 */
const FLAG_ENV: Record<string, string> = {
	'--expose': 'EXPOSE',
	'--port': 'RELAY_PORT',
	'--voice-port': 'VOICE_PORT',
	'--host': 'RELAY_HOST',
	'--hostname': 'RELAY_HOSTNAME',
	'--token': 'RELAY_TOKEN',
	'--write-strategy': 'WRITE_STRATEGY',
	'--prevent-screen-lock': 'PREVENT_SCREEN_LOCK',
	'--auto-update': 'AUTO_UPDATE',
	'--auto-update-interval': 'AUTO_UPDATE_INTERVAL_MINUTES',
	'--funnel-watchdog': 'FUNNEL_WATCHDOG',
	'--funnel-watchdog-interval': 'FUNNEL_WATCHDOG_INTERVAL_SECONDS',
	'--db': 'CONDUCTOR_DB',
	'--workspaces': 'CONDUCTOR_WORKSPACES'
}

function applyFlags(argv: string[]): void {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--')) continue
		const eq = arg.indexOf('=')
		const name = eq === -1 ? arg : arg.slice(0, eq)
		const envKey = FLAG_ENV[name]
		if (!envKey) {
			console.error(`unknown flag: ${name}\n  known: ${Object.keys(FLAG_ENV).join(', ')}`)
			process.exit(1)
		}
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
		if (value === undefined) {
			console.error(`flag ${name} needs a value (e.g. ${name} <value>)`)
			process.exit(1)
		}
		if (name === '--prevent-screen-lock' && value !== 'on' && value !== 'off') {
			console.error(`flag ${name} must be on or off`)
			process.exit(1)
		}
		process.env[envKey] = value
	}
}

// argv[2] is the subcommand (see bottom); flags follow it. `logs` parses its own args (it takes -n /
// --no-follow, which applyFlags would reject as unknown flags), so skip the shared flag pass for it.
if ((process.argv[2] ?? 'status') !== 'logs') applyFlags(process.argv.slice(3))

function xml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Run launchctl, swallowing the exit code so "already-loaded"/"not-loaded" states aren't fatal. */
function launchctl(...args: string[]): void {
	try {
		execFileSync('launchctl', args, { stdio: 'pipe' })
	} catch {
		// non-zero is expected for bootout-when-absent etc.; state is asserted by the caller's sequence
	}
}

/** Block the main thread briefly — used to let launchd settle between bootout and bootstrap. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Is the agent currently bootstrapped into the user domain? */
function serviceLoaded(): boolean {
	try {
		execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

/**
 * Reload the agent from the freshly written plist. `bootout` of a *running* instance is asynchronous,
 * so we wait for it to fully unload before `bootstrap` — otherwise bootstrap races the teardown and
 * fails silently, leaving the relay down after a re-deploy. Bootstrap is retried and its failure is fatal.
 */
function reloadAgent(): void {
	launchctl('bootout', `${domain}/${LABEL}`)
	for (let i = 0; i < 30 && serviceLoaded(); i++) sleepSync(100)
	let bootstrapped = false
	for (let i = 0; i < 10 && !bootstrapped; i++) {
		try {
			execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' })
			bootstrapped = true
		} catch {
			sleepSync(150)
		}
	}
	if (!bootstrapped) {
		console.error(`✗ launchctl bootstrap failed for ${plistPath}`)
		console.error(`  Inspect with: launchctl print ${domain}/${LABEL}`)
		process.exit(1)
	}
	launchctl('enable', `${domain}/${LABEL}`)
	launchctl('kickstart', '-k', `${domain}/${LABEL}`)
}

/** Node runs the relay via the flag-free CLI shim; the absolute execPath is baked at install time. */
function buildPlist(): string {
	const node = xml(process.execPath)
	const proj = xml(projectDir)
	const out = xml(path.join(logDir, 'relay.log'))
	const err = xml(path.join(logDir, 'relay.err.log'))
	// node's own dir leads so the daemon can find `npm` (adjacent to node) for self-update under launchd's
	// bare PATH; Homebrew's bin is appended for tailscale/node on Apple Silicon.
	const nodeDir = path.dirname(process.execPath)
	const daemonPath = `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`
	// MANAGED marks this as the launchd-supervised instance: autoupdate.ts only self-restarts (exit →
	// KeepAlive respawn) when it sees this, so a dev `yarn start` or worktree run never auto-updates.
	const envEntries: Array<[string, string]> = [
		['PATH', daemonPath],
		['CONDUCTOR_REMOTE_MANAGED', '1']
	]
	// EXPOSE belongs here with the other runtime knobs, and leaving it out was a real bug. The daemon
	// reads its posture on every boot (the funnel watchdog only arms itself for `public`), but install()
	// reloads launchd *before* ensureTailscale() persists the choice — so a fresh `--expose tailnet`
	// daemon came up reading the old posture, armed the watchdog against a Funnel that was about to be
	// switched off, and ~3 failed probes later healed it straight back to public. Baking the resolved
	// value makes the daemon's own environment the answer, so nothing depends on write ordering.
	if (process.env.EXPOSE) envEntries.push(['EXPOSE', process.env.EXPOSE])
	if (process.env.WRITE_STRATEGY) envEntries.push(['WRITE_STRATEGY', process.env.WRITE_STRATEGY])
	if (process.env.PREVENT_SCREEN_LOCK) envEntries.push(['PREVENT_SCREEN_LOCK', process.env.PREVENT_SCREEN_LOCK])
	if (process.env.RELAY_HOST) envEntries.push(['RELAY_HOST', process.env.RELAY_HOST])
	if (process.env.RELAY_PORT) envEntries.push(['RELAY_PORT', process.env.RELAY_PORT])
	if (process.env.VOICE_PORT) envEntries.push(['VOICE_PORT', process.env.VOICE_PORT])
	if (process.env.AUTO_UPDATE) envEntries.push(['AUTO_UPDATE', process.env.AUTO_UPDATE])
	if (process.env.AUTO_UPDATE_INTERVAL_MINUTES)
		envEntries.push(['AUTO_UPDATE_INTERVAL_MINUTES', process.env.AUTO_UPDATE_INTERVAL_MINUTES])
	if (process.env.FUNNEL_WATCHDOG) envEntries.push(['FUNNEL_WATCHDOG', process.env.FUNNEL_WATCHDOG])
	if (process.env.FUNNEL_WATCHDOG_INTERVAL_SECONDS)
		envEntries.push(['FUNNEL_WATCHDOG_INTERVAL_SECONDS', process.env.FUNNEL_WATCHDOG_INTERVAL_SECONDS])
	if (process.env.CONDUCTOR_DB) envEntries.push(['CONDUCTOR_DB', process.env.CONDUCTOR_DB])
	if (process.env.CONDUCTOR_WORKSPACES) envEntries.push(['CONDUCTOR_WORKSPACES', process.env.CONDUCTOR_WORKSPACES])
	const envXml = envEntries.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${node}</string>
		<string>${proj}/bin/cli.js</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${proj}</string>
	<key>EnvironmentVariables</key>
	<dict>
${envXml}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${out}</string>
	<key>StandardErrorPath</key>
	<string>${err}</string>
</dict>
</plist>
`
}

function distBuilt(): boolean {
	return fs.existsSync(path.join(projectDir, 'dist', 'index.html'))
}

function tokenStorePath(): string {
	return path.join(os.homedir(), 'Library', 'Application Support', 'conductor-remote', 'token')
}

/** Read the persisted token (or env override) purely to print the phone URL — never mints one. */
function currentToken(): string | null {
	if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN
	try {
		return fs.readFileSync(tokenStorePath(), 'utf8').trim() || null
	} catch {
		return null
	}
}

/**
 * A pinned token (`--token` / `RELAY_TOKEN`) is persisted to the token file, not baked into the plist —
 * the launchd daemon has no such env, so it resolves the secret from this file (config.ts ▸ resolveToken).
 * Writing it here keeps the daemon, the printed URL, and later `status` all in agreement.
 */
function persistPinnedToken(): void {
	const token = process.env.RELAY_TOKEN
	if (!token) return
	try {
		fs.mkdirSync(path.dirname(tokenStorePath()), { recursive: true })
		fs.writeFileSync(tokenStorePath(), token, { mode: 0o600 })
	} catch (err) {
		console.info(`  ⚠ could not persist --token (${err instanceof Error ? err.message : err})`)
	}
}

const RELAY_PORT = relayPort()
const VOICE_PORT = String(process.env.VOICE_PORT ?? 8788)

/**
 * Resolve the expose mode. Precedence: `EXPOSE` env (public|funnel / tailnet|serve|private) > persisted
 * choice > 'public' default. An explicit env value is persisted so re-deploys don't silently flip posture.
 * (The read-only counterpart used by the runtime watchdog is readExposeMode() in src/tailscale.ts.)
 */
function resolveExposeMode(): ExposeMode {
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
function tailscaleState(bin: string, port: string = RELAY_PORT): RelayServeState {
	try {
		const out = execFileSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: 'pipe' })
		return relayServeState(parseServeStatus(out), port)
	} catch {
		return relayServeState({}, port)
	}
}

function rawTailscaleStatus(bin: string): ServeStatus {
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
function mountRelay(bin: string, kind: 'serve' | 'funnel', port: number): string | null {
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
function ensureTailscale(): void {
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

/**
 * Give OpenAI the only public route it needs while keeping the control panel tailnet-only.
 * Port-wide changes happen only when every live handler is either the relay root or the exact
 * voice target named by our receipt; a foreign or merely manual mount is left untouched.
 */
function ensureVoiceFunnel(): void {
	const voice = readVoiceConfig()
	const bin = tailscaleBin()
	if (!voice.publicBaseUrl) {
		const receipt = readVoiceFunnelReceipt()
		if (!bin || !receipt) return
		const inspected = inspectVoiceFunnel(rawTailscaleStatus(bin), VOICE_PORT, RELAY_PORT, receipt)
		if (!inspected.owned || inspected.relayAtRoot || inspected.conflicts.length) return
		try {
			execFileSync(bin, ['serve', '--yes', '--https=443', 'off'], { stdio: 'pipe' })
			fs.rmSync(voiceFunnelReceiptPath())
			console.info('✓ removed the receipt-owned voice Funnel mount')
		} catch (error) {
			console.info(
				`  ⚠ could not remove the receipt-owned voice Funnel (${error instanceof Error ? error.message : error})`
			)
		}
		return
	}
	if (!bin) {
		console.info(`\n  ⚠ voice is configured but Tailscale is unavailable. Mount by hand:`)
		console.info(`      tailscale funnel --bg --yes --https=443 --set-path=/voice ${VOICE_PORT}`)
		return
	}
	const dns = magicDnsName(bin)
	if (!dns) {
		console.info('\n  ⚠ voice is configured but this node has no MagicDNS name; Funnel was not changed.')
		return
	}
	let configuredHost: string
	try {
		configuredHost = new URL(voice.publicBaseUrl).hostname
	} catch {
		console.info('\n  ⚠ voice.public-url is invalid; Funnel was not changed.')
		return
	}
	if (configuredHost !== dns) {
		console.info(`\n  ⚠ voice.public-url names ${configuredHost}, but this node is ${dns}; Funnel was not changed.`)
		console.info(`    Fix with: conductor-remote config set voice.public-url https://${dns}/voice`)
		return
	}

	let status = rawTailscaleStatus(bin)
	const oldReceipt = readVoiceFunnelReceipt()
	let inspected = inspectVoiceFunnel(status, VOICE_PORT, RELAY_PORT, oldReceipt)
	if (inspected.conflicts.length) {
		console.info(`\n  ⚠ :443 carries ${inspected.conflicts.join(', ')}. It is not owned by this receipt; left as is.`)
		return
	}
	if (inspected.owned && inspected.targetMatches && inspected.funnelOn && !inspected.relayAtRoot) {
		console.info(`✓ voice Funnel already exposes https://${dns}/voice → 127.0.0.1:${VOICE_PORT}`)
		return
	}

	if (inspected.relayAtRoot) {
		const state = relayServeState(status, RELAY_PORT)
		const candidates = [Number(RELAY_PORT), 8443, 10000].filter(
			(port, index, all) => Number.isInteger(port) && port !== 443 && all.indexOf(port) === index
		)
		const destination = freeServePort(state, candidates)
		if (destination === null) {
			console.info(
				`\n  ⚠ the relay must leave :443 for voice, but ${candidates.map(p => `:${p}`).join(', ')} are occupied.`
			)
			return
		}
		const failed = mountRelay(bin, 'serve', destination)
		if (failed) {
			console.info(`\n  ⚠ could not move the relay to tailnet-only :${destination} (${failed}). Voice was not changed.`)
			return
		}
		try {
			execFileSync(bin, ['serve', '--yes', '--https=443', 'off'], { stdio: 'pipe' })
		} catch (error) {
			console.info(
				`\n  ⚠ relay moved, but :443 could not be cleared (${error instanceof Error ? error.message : error}).`
			)
			return
		}
		console.info(`✓ relay moved to https://${dns}:${destination}/ (tailnet-only) so voice can own :443`)
	}

	try {
		execFileSync(bin, ['funnel', '--bg', '--yes', '--https=443', '--set-path=/voice', VOICE_PORT], {
			stdio: 'pipe'
		})
	} catch (error) {
		console.info(`\n  ⚠ could not mount voice Funnel (${error instanceof Error ? error.message : error}).`)
		console.info(`    Run by hand: tailscale funnel --bg --yes --https=443 --set-path=/voice ${VOICE_PORT}`)
		return
	}
	const receipt: VoiceFunnelReceipt = {
		version: 1,
		host: dns,
		path: '/voice',
		target: `http://127.0.0.1:${VOICE_PORT}`
	}
	status = rawTailscaleStatus(bin)
	inspected = inspectVoiceFunnel(status, VOICE_PORT, RELAY_PORT, receipt)
	if (!inspected.owned || !inspected.targetMatches || !inspected.funnelOn || inspected.relayAtRoot) {
		console.info('\n  ⚠ Tailscale accepted the voice command, but the isolated public mount could not be verified.')
		return
	}
	writeVoiceFunnelReceipt(receipt)
	console.info(`✓ voice Funnel exposes https://${dns}/voice → 127.0.0.1:${VOICE_PORT} (receipt recorded)`)
}

function funnelRefused(error: string): void {
	console.info(`\n  ⚠ could not enable Funnel (${error}).`)
	console.info('    Funnel must be enabled for this tailnet: open the URL Tailscale printed above, or add the')
	console.info('    "funnel" nodeAttr in Admin console ▸ Access controls. Falling back to tailnet-only for now.')
}

/** Print a scannable QR of `url` (theme-independent black-on-white). Never fatal — QR is a convenience. */
function printQr(url: string): void {
	try {
		console.info(`\n${qrLines(url).join('\n')}`)
	} catch (err) {
		console.info(`  (QR skipped: ${err instanceof Error ? err.message : err})`)
	}
}

function printUrl(loopbackPort: string = RELAY_PORT): void {
	const token = currentToken()
	const frag = `#token=${token ?? '<starts on first run>'}`
	const bin = tailscaleBin()
	if (bin) {
		const drift = driftWarningLines(bin)
		if (drift.length) console.info(`\n${drift.join('\n')}`)
	}
	const dns = bin ? magicDnsName(bin) : null
	const state = bin ? tailscaleState(bin, loopbackPort) : relayServeState({}, loopbackPort)
	if (dns && state.port !== null) {
		const scope = state.funnelOn ? 'public — any browser, token-gated' : 'same Tailnet only'
		const url = `${serveUrl(dns, state.port)}${frag}`
		console.info(`\n  Phone URL (HTTPS, ${scope}):\n    ${url}`)
		if (token) {
			console.info('\n  Scan to open on your phone:')
			printQr(url)
		}
		return
	}
	// Nothing fronting yet — the relay is only on loopback.
	console.info(`\n  Local URL:\n    http://127.0.0.1:${loopbackPort}/${frag}`)
	console.info(
		`\n  ⚠ Not reachable from your phone yet. Run \`yarn deploy\` (it picks a free port), or by hand \`tailscale funnel --bg ${loopbackPort}\` (public) / \`tailscale serve --bg ${loopbackPort}\` (tailnet)${dns ? ` → https://${dns}/` : ''}, then \`yarn service status\`.`
	)
}

/** Report the public voice path independently of the relay's tailnet-only phone URL. */
function printVoiceRoute(loopbackPort: string, listenerPort: string): void {
	const voice = readVoiceConfig()
	if (!voice.publicBaseUrl) {
		console.info('voice:     disabled (set voice.public-url to enable)')
		return
	}
	const bin = tailscaleBin()
	if (!bin) {
		console.info(`voice:     configured at ${voice.publicBaseUrl}, but Tailscale is unavailable`)
		return
	}
	const inspected = inspectVoiceFunnel(rawTailscaleStatus(bin), listenerPort, loopbackPort, readVoiceFunnelReceipt())
	if (inspected.owned && inspected.targetMatches && inspected.funnelOn && !inspected.relayAtRoot) {
		console.info(`voice:     ${voice.publicBaseUrl} (public) → 127.0.0.1:${listenerPort}`)
		return
	}
	console.info(`voice:     ${voice.publicBaseUrl} configured, but its isolated Funnel mount is not live`)
}

/** npx unpacks into a throwaway cache that gets purged; a LaunchAgent baked against it would rot. */
function isEphemeralInstall(dir: string): boolean {
	return /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_npx[\\/]/.test(dir)
}

function install(): void {
	if (isEphemeralInstall(projectDir)) {
		console.error(
			`✗ refusing to install from an npx cache path:\n    ${projectDir}\n` +
				'  That directory is temporary and gets purged, which would break the LaunchAgent.\n' +
				'  Install globally first: `npm i -g conductor-remote`, then `conductor-remote service install`.'
		)
		process.exit(1)
	}
	if (!distBuilt()) {
		console.error('✗ dist/ not built. Run `yarn build` first (or use `yarn deploy`, which builds).')
		process.exit(1)
	}
	persistPinnedToken()
	// Resolve (and persist) the expose posture *before* the plist is written and launchd is reloaded, so
	// the daemon starts with an explicit EXPOSE in its own environment rather than racing the file
	// ensureTailscale() writes further down. Folding it back into process.env is how every other knob
	// travels here (see applyFlags), and it keeps ensureTailscale()'s own resolve a no-op re-read.
	const requestedExpose = resolveExposeMode()
	if (readVoiceConfig().publicBaseUrl) {
		if (requestedExpose !== 'tailnet')
			console.info('  voice requires the relay itself to stay tailnet-only; forcing EXPOSE=tailnet.')
		process.env.EXPOSE = 'tailnet'
		try {
			fs.mkdirSync(path.dirname(exposeStorePath()), { recursive: true })
			fs.writeFileSync(exposeStorePath(), 'tailnet')
		} catch {
			// The plist still carries the safe posture; this file is only the next install's default.
		}
	} else {
		process.env.EXPOSE = requestedExpose
	}
	fs.mkdirSync(path.dirname(plistPath), { recursive: true })
	fs.mkdirSync(logDir, { recursive: true })
	fs.writeFileSync(plistPath, buildPlist())
	reloadAgent()
	const changedSetting = process.env.CONDUCTOR_REMOTE_CONFIG_SET
	if (changedSetting) {
		if (
			changedSetting === 'expose' ||
			changedSetting === 'port' ||
			changedSetting === 'voice-port' ||
			changedSetting === 'hostname' ||
			changedSetting.startsWith('voice.')
		) {
			ensureTailscale()
			ensureVoiceFunnel()
		}
		console.info(`✓ set ${changedSetting}; the relay restarted with the new value.`)
		console.info('  Check it with: conductor-remote config')
		return
	}
	console.info(`✓ installed LaunchAgent ${LABEL}`)
	console.info(`  plist: ${plistPath}`)
	console.info(`  logs:  ${logDir}/relay.log`)
	console.info(`  node:  ${process.execPath}`)
	ensureTailscale()
	ensureVoiceFunnel()
	printUrl()
	console.info(
		'\n  Note: a node version change (nvm) invalidates the baked path — re-run `yarn deploy` after upgrading node.'
	)
	console.info(
		'  Note: the AppleScript write path needs Accessibility permission granted to this node binary (System Settings ▸ Privacy).'
	)
}

function uninstall(): void {
	launchctl('bootout', `${domain}/${LABEL}`)
	try {
		fs.rmSync(plistPath)
	} catch {
		// already gone
	}
	console.info(`✓ removed LaunchAgent ${LABEL}`)
}

function restart(): void {
	launchctl('kickstart', '-k', `${domain}/${LABEL}`)
	console.info(`✓ restarted ${LABEL}`)
	const env = readPlistEnv()
	const relayPort = env.RELAY_PORT ?? '8787'
	printUrl(relayPort)
	printVoiceRoute(relayPort, env.VOICE_PORT ?? '8788')
}

/**
 * The daemon's environment, read back out of the plist it was installed with.
 *
 * This is the whole point of `config`: `process.env` here belongs to *your shell*, and the daemon
 * runs under launchd with whatever `buildPlist()` baked in. Reading the shell's env to report the
 * daemon's configuration is how a posture change can look applied while the running relay still
 * believes something else — which is exactly the bug that made EXPOSE a plist entry.
 */
function readPlistEnv(): Record<string, string> {
	return installedServiceEnvironment()
}

interface Knob {
	/** The `--flag` name, so the fix is copy-pasteable. */
	name: string
	env: string
	/** Value when nothing is set, written the way the runtime actually resolves it. */
	fallback: (env: Record<string, string>) => string
	/** Where `fallback` came from, when it is not a plain default. */
	fallbackSource?: (env: Record<string, string>) => string
}

const CONFIG_KEYS = new Map(Object.entries(FLAG_ENV).map(([flag, env]) => [flag.slice(2), env]))

const HOME = os.homedir()
const tilde = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)

const KNOBS: Knob[] = [
	{
		name: 'expose',
		env: 'EXPOSE',
		// The runtime's own precedence (src/tailscale.ts ▸ readExposeMode): env, then the persisted
		// file, then public. Reported the same way so this can never describe a posture the relay
		// isn't running.
		fallback: () => {
			try {
				return normalizeExposeMode(fs.readFileSync(exposeStorePath(), 'utf8')) ?? 'public'
			} catch {
				return 'public'
			}
		},
		fallbackSource: () => (fs.existsSync(exposeStorePath()) ? 'expose file' : 'default')
	},
	{ name: 'port', env: 'RELAY_PORT', fallback: () => '8787' },
	{ name: 'voice-port', env: 'VOICE_PORT', fallback: () => '8788' },
	{ name: 'host', env: 'RELAY_HOST', fallback: () => '127.0.0.1' },
	{ name: 'write-strategy', env: 'WRITE_STRATEGY', fallback: () => 'applescript' },
	{ name: 'prevent-screen-lock', env: 'PREVENT_SCREEN_LOCK', fallback: () => 'on' },
	{ name: 'auto-update', env: 'AUTO_UPDATE', fallback: () => 'auto' },
	{ name: 'auto-update-interval', env: 'AUTO_UPDATE_INTERVAL_MINUTES', fallback: () => '5 (minutes)' },
	{
		name: 'funnel-watchdog',
		env: 'FUNNEL_WATCHDOG',
		// Two gates, not one: it defaults on for the managed daemon and then stands down unless the
		// posture is public (src/funnel-watchdog.ts ▸ wantEnabled + startFunnelWatchdog).
		fallback: env => (env.CONDUCTOR_REMOTE_MANAGED === '1' ? 'on (managed daemon)' : 'off (not managed)')
	},
	{ name: 'funnel-watchdog-interval', env: 'FUNNEL_WATCHDOG_INTERVAL_SECONDS', fallback: () => '60 (seconds)' },
	{
		name: 'db',
		env: 'CONDUCTOR_DB',
		fallback: () => tilde(path.join(HOME, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db'))
	},
	{
		name: 'workspaces',
		env: 'CONDUCTOR_WORKSPACES',
		fallback: () => tilde(path.join(HOME, 'conductor', 'workspaces'))
	}
]

/** Set one daemon knob while preserving every other value already baked into the plist. */
function setConfig(args: string[]): void {
	const [name, value, ...extra] = args
	const envKey = name ? CONFIG_KEYS.get(name) : undefined
	if (!name || value === undefined || extra.length > 0) {
		console.error('usage: conductor-remote config set <setting> <value>')
		process.exit(1)
	}
	if (name && (VOICE_SETTING_NAMES as readonly string[]).includes(name)) {
		try {
			setVoiceSetting(name, value)
		} catch (error) {
			console.error(`config set: ${error instanceof Error ? error.message : error}`)
			process.exit(1)
		}
		if (!fs.existsSync(plistPath)) {
			console.info(`✓ set ${name}. Install the service to start the voice listener.`)
			return
		}
		const childEnv = { ...process.env, ...readPlistEnv(), CONDUCTOR_REMOTE_CONFIG_SET: name }
		const cli = path.join(projectDir, 'bin', 'cli.js')
		const result = spawnSync(process.execPath, [cli, 'service', 'install'], { env: childEnv, stdio: 'inherit' })
		if (result.error) console.error(`config set: could not restart the service (${result.error.message})`)
		process.exit(result.status ?? 1)
	}
	if (!envKey) {
		console.error(
			`config set: unknown setting "${name}"\n  known: ${[...CONFIG_KEYS.keys(), ...VOICE_SETTING_NAMES].join(', ')}`
		)
		process.exit(1)
	}
	if (name === 'prevent-screen-lock' && value !== 'on' && value !== 'off') {
		console.error('config set: prevent-screen-lock must be on or off')
		process.exit(1)
	}
	if (!fs.existsSync(plistPath)) {
		console.error('config set: the service is not installed. Run `conductor-remote service install` first.')
		process.exit(1)
	}

	// Re-run install in a fresh process so module-level values such as RELAY_PORT see
	// the new environment. Start from the plist, which protects unrelated settings
	// from ambient shell variables and from being reset to defaults.
	const childEnv = serviceEnvironmentWithSetting(process.env, readPlistEnv(), CONFIG_KEYS.values(), envKey, value)
	childEnv.CONDUCTOR_REMOTE_CONFIG_SET = name
	const cli = path.join(projectDir, 'bin', 'cli.js')
	const result = spawnSync(process.execPath, [cli, 'service', 'install'], { env: childEnv, stdio: 'inherit' })
	if (result.error) console.error(`config set: could not restart the service (${result.error.message})`)
	process.exit(result.status ?? 1)
}

/** What the daemon is configured with, where values came from, and an optional setter. */
function config(): void {
	if (process.argv[3] === 'set') {
		setConfig(process.argv.slice(4))
		return
	}
	if (process.argv[3] !== undefined) {
		console.error('usage: conductor-remote config [set <setting> <value>]')
		process.exit(1)
	}
	if (!fs.existsSync(plistPath)) {
		console.info(`plist:  (not installed)\n\nRun \`conductor-remote service install\` first.`)
		return
	}
	const env = readPlistEnv()
	console.info(`plist:  ${tilde(plistPath)}`)
	console.info(`state:  ${tilde(path.dirname(exposeStorePath()))}`)
	try {
		const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8', stdio: 'pipe' })
		console.info(
			`daemon: ${out.match(/state = (\S+)/)?.[1] ?? 'unknown'}  (pid ${out.match(/pid = (\d+)/)?.[1] ?? '—'})`
		)
	} catch {
		console.info('daemon: loaded but not running (check `conductor-remote logs`)')
	}

	const rows = KNOBS.map(k => {
		const set = env[k.env]
		return {
			name: k.name,
			value: set ?? k.fallback(env),
			source: set ? 'plist' : (k.fallbackSource?.(env) ?? 'default')
		}
	})
	// The token is deliberately not a row above: it never rides in the plist, and this output is the
	// kind of thing that gets pasted into an issue. Shown truncated, like every other log surface here.
	let token = '(none yet — minted on first start)'
	try {
		const raw = fs.readFileSync(path.join(path.dirname(exposeStorePath()), 'token'), 'utf8').trim()
		if (raw) token = `${raw.slice(0, 4)}…${raw.slice(-4)}`
	} catch {
		// no token file yet
	}
	rows.push({ name: 'token', value: token, source: 'token file' })
	const voice = readVoiceConfig()
	rows.push(
		{ name: 'voice.openai-key', value: voice.openaiKey ? '(set)' : '(unset)', source: 'voice file' },
		{ name: 'voice.webhook-secret', value: voice.webhookSecret ? '(set)' : '(unset)', source: 'voice file' },
		{ name: 'voice.twilio-auth-token', value: voice.twilioAuthToken ? '(set)' : '(unset)', source: 'voice file' },
		{
			name: 'voice.allowed-callers',
			value: voice.allowedCallers.length ? `${voice.allowedCallers.length} set` : '(unset)',
			source: 'voice file'
		},
		{ name: 'voice.pin', value: voice.pin ? '(set)' : '(unset)', source: 'voice file' },
		{ name: 'voice.project-id', value: voice.projectId ? '(set)' : '(unset)', source: 'voice file' },
		{ name: 'voice.public-url', value: voice.publicBaseUrl ?? '(unset)', source: 'voice file' },
		{ name: 'voice.model', value: voice.model, source: 'voice file' },
		{ name: 'voice.voice', value: voice.voice, source: 'voice file' },
		{ name: 'voice.sip-host', value: voice.sipHost, source: 'voice file' }
	)
	// The HTTPS port is a live Tailscale fact, not a plist knob: :443 by default, elsewhere once another
	// service holds :443 (see ensureServeOnly), and the phone URL carries whichever it is. Read against the
	// daemon's own port, since this shell's RELAY_PORT is not the one the relay listens on.
	const bin = tailscaleBin()
	const livePort = env.RELAY_PORT ?? '8787'
	const live = bin ? tailscaleState(bin, livePort) : relayServeState({}, livePort)
	rows.push({
		name: 'https-port',
		value: live.port === null ? '(not fronted)' : String(live.port),
		source: 'tailscale serve'
	})

	const width = Math.max(...rows.map(r => r.name.length))
	const valueWidth = Math.max(...rows.map(r => r.value.length))
	console.info('')
	for (const r of rows) {
		console.info(`  ${r.name.padEnd(width)}  ${r.value.padEnd(valueWidth)}  ${r.source}`)
	}
	console.info('\n  (values come from the daemon\u2019s own plist environment, not this shell\u2019s)')
	console.info('  change one with: conductor-remote config set <setting> <value>')

	// The cross-check worth having. A posture the relay believes and a Tailscale that is doing something
	// else is invisible in every other command, and it is self-healing in the wrong direction: the funnel
	// watchdog only runs for `public`, so a relay that thinks it is public will re-register Funnel.
	const configured = rows.find(r => r.name === 'expose')?.value
	if (!bin || !configured) return
	const liveMode = live.funnelOn ? 'public' : live.port !== null ? 'tailnet' : null
	const where = live.port !== null && live.port !== 443 ? ` on :${live.port}` : ''
	const funnelable = live.port === null || FUNNEL_PORTS.includes(live.port)
	console.info('')
	if (liveMode === null) {
		console.info(`  \u26a0 tailscale is not fronting 127.0.0.1:${livePort} at all — the phone URL is not wired.`)
		console.info('    Fix with: conductor-remote service install')
	} else if (liveMode === configured) {
		console.info(
			`  \u2713 tailscale agrees: ${liveMode === 'public' ? 'Funnel on (internet-facing)' : 'serve only (tailnet)'}${where}`
		)
	} else {
		console.info(
			`  \u26a0 tailscale says ${liveMode}${where}, the daemon is configured ${configured}. They must match:`
		)
		console.info(`    the funnel watchdog only runs for \`public\`, so the two can heal each other apart.`)
		if (configured === 'public' && !funnelable) {
			console.info(
				`    Funnel cannot listen on :${live.port} (only ${FUNNEL_PORTS.join(', ')}), so either move the relay by hand`
			)
			console.info(`    (tailscale funnel --bg --yes --https=<443|8443|10000> ${livePort}) or match the daemon to it:`)
			console.info('    conductor-remote service install --expose tailnet')
		} else {
			console.info(`    Fix with: conductor-remote service install --expose ${configured}`)
		}
	}
}

function status(): void {
	const installed = fs.existsSync(plistPath)
	console.info(`plist:     ${installed ? plistPath : '(not installed)'}`)
	if (!installed) return
	try {
		const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8', stdio: 'pipe' })
		const state = out.match(/state = (\S+)/)?.[1] ?? 'unknown'
		const pid = out.match(/pid = (\d+)/)?.[1] ?? '—'
		console.info(`state:     ${state}  (pid ${pid})`)
	} catch {
		console.info('state:     loaded but not running (check logs)')
	}
	const env = readPlistEnv()
	const relayPort = env.RELAY_PORT ?? '8787'
	printUrl(relayPort)
	printVoiceRoute(relayPort, env.VOICE_PORT ?? '8788')
}

/**
 * Stream the LaunchAgent's stdout+stderr logs (the same files the plist points at). Follows both by default
 * — `--no-follow` for a one-shot tail, `-n N` for depth. Pure `tail` passthrough so Ctrl-C just detaches.
 */
function logs(): void {
	const files = ['relay.log', 'relay.err.log'].map(f => path.join(logDir, f)).filter(f => fs.existsSync(f))
	if (files.length === 0) {
		console.info(
			`no logs yet in ${logDir}/ — the relay writes there once the LaunchAgent is running (\`conductor-remote service install\`).`
		)
		return
	}
	const argv = process.argv.slice(3)
	const follow = !argv.includes('--no-follow')
	const nAt = argv.indexOf('-n')
	const count = nAt !== -1 && argv[nAt + 1] ? argv[nAt + 1] : '200'
	const args = ['-n', count, ...(follow ? ['-F'] : []), ...files]
	const res = spawnSync('tail', args, { stdio: 'inherit' })
	// tail exits 0 normally; Ctrl-C kills it via SIGINT (null status). Only surface a genuine non-zero exit.
	if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status)
}

const cmd = process.argv[2] ?? 'status'
switch (cmd) {
	case 'install':
		install()
		break
	case 'uninstall':
		uninstall()
		break
	case 'restart':
		restart()
		break
	case 'status':
		status()
		break
	case 'config':
		config()
		break
	case 'logs':
		logs()
		break
	default:
		console.error(
			`unknown command: ${cmd}\n` +
				'usage: service.ts <install|uninstall|restart|status|config|logs> [flags]\n' +
				`  flags (install): ${Object.keys(FLAG_ENV).join(', ')}`
		)
		process.exit(1)
}
