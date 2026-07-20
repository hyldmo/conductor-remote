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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageRoot } from '../src/pkg-root.ts'
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
	'--host': 'RELAY_HOST',
	'--token': 'RELAY_TOKEN',
	'--write-strategy': 'WRITE_STRATEGY',
	'--auto-update': 'AUTO_UPDATE',
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
		process.env[envKey] = value
	}
}

// argv[2] is the subcommand (see bottom); flags follow it.
applyFlags(process.argv.slice(3))

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
	if (process.env.WRITE_STRATEGY) envEntries.push(['WRITE_STRATEGY', process.env.WRITE_STRATEGY])
	if (process.env.RELAY_HOST) envEntries.push(['RELAY_HOST', process.env.RELAY_HOST])
	if (process.env.RELAY_PORT) envEntries.push(['RELAY_PORT', process.env.RELAY_PORT])
	if (process.env.AUTO_UPDATE) envEntries.push(['AUTO_UPDATE', process.env.AUTO_UPDATE])
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

const RELAY_PORT = process.env.RELAY_PORT ?? '8787'

/** Locate the tailscale CLI: PATH first, then the common macOS install locations. Null if absent. */
function tailscaleBin(): string | null {
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

/** This node's MagicDNS name without the trailing dot, e.g. `mac.taila6dcd6.ts.net`. */
function magicDnsName(bin: string): string | null {
	try {
		const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: 'pipe' })
		return (JSON.parse(out)?.Self?.DNSName ?? '').replace(/\.$/, '') || null
	} catch {
		return null
	}
}

/**
 * How the stable HTTPS URL is fronted:
 *   'public'  → `tailscale funnel` — reachable from ANY browser on the internet (token-gated).
 *   'tailnet' → `tailscale serve`  — reachable only by devices logged into this tailnet.
 */
type ExposeMode = 'public' | 'tailnet'

/** Where the chosen expose mode is persisted so a later bare `yarn deploy` keeps the same posture. */
function exposeStorePath(): string {
	return path.join(os.homedir(), 'Library', 'Application Support', 'conductor-remote', 'expose')
}

function normalizeMode(raw: string | undefined): ExposeMode | null {
	const v = raw?.trim().toLowerCase()
	if (v === 'public' || v === 'funnel') return 'public'
	if (v === 'tailnet' || v === 'serve' || v === 'private') return 'tailnet'
	return null
}

/**
 * Resolve the expose mode. Precedence: `EXPOSE` env (public|funnel / tailnet|serve|private) > persisted
 * choice > 'public' default. An explicit env value is persisted so re-deploys don't silently flip posture.
 */
function resolveExposeMode(): ExposeMode {
	const fromEnv = normalizeMode(process.env.EXPOSE)
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
		const saved = normalizeMode(fs.readFileSync(exposeStorePath(), 'utf8'))
		if (saved) return saved
	} catch {
		// no saved choice yet
	}
	return 'public'
}

/** Live serve/funnel state for this node: is the loopback proxy wired, and is Funnel (public) on? */
function tailscaleState(bin: string, dns: string | null): { proxyOk: boolean; funnelOn: boolean } {
	if (!dns) return { proxyOk: false, funnelOn: false }
	try {
		const out = execFileSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: 'pipe' })
		const cfg = JSON.parse(out)
		const key = `${dns}:443`
		const proxyOk = cfg?.Web?.[key]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${RELAY_PORT}`
		return { proxyOk, funnelOn: Boolean(cfg?.AllowFunnel?.[key]) }
	} catch {
		return { proxyOk: false, funnelOn: false }
	}
}

/** Assert the tailnet-only `serve` proxy — used for tailnet mode and as the Funnel fallback. */
function ensureServeOnly(bin: string, url: string, state: { proxyOk: boolean; funnelOn: boolean }): void {
	if (state.proxyOk && !state.funnelOn) {
		console.info(`✓ tailscale serve fronts ${url} → 127.0.0.1:${RELAY_PORT} (tailnet-only)`)
		return
	}
	try {
		execFileSync(bin, ['serve', '--bg', RELAY_PORT], { stdio: 'pipe' })
		console.info(`✓ tailscale serve → ${url} proxies 127.0.0.1:${RELAY_PORT} (tailnet-only)`)
	} catch (err) {
		console.info(
			`\n  ⚠ could not configure tailscale serve (${err instanceof Error ? err.message : err}). Run by hand:`
		)
		console.info(`      tailscale serve --bg ${RELAY_PORT}`)
	}
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
	const dns = magicDnsName(bin)
	const url = `https://${dns ?? '<node>'}/`
	const mode = resolveExposeMode()
	const state = tailscaleState(bin, dns)

	if (mode === 'tailnet') {
		if (state.funnelOn) {
			try {
				execFileSync(bin, ['funnel', 'reset'], { stdio: 'pipe' })
			} catch {
				// best-effort; ensureServeOnly re-asserts the proxy below
			}
			ensureServeOnly(bin, url, { proxyOk: false, funnelOn: false })
		} else {
			ensureServeOnly(bin, url, state)
		}
		return
	}

	// public (Funnel)
	if (state.proxyOk && state.funnelOn) {
		console.info(`✓ tailscale funnel already exposes ${url} → 127.0.0.1:${RELAY_PORT} (public, token-gated)`)
		return
	}
	try {
		execFileSync(bin, ['funnel', '--bg', '--yes', RELAY_PORT], { stdio: 'pipe' })
		console.info(`✓ tailscale funnel → ${url} now public over the internet (token-gated) → 127.0.0.1:${RELAY_PORT}`)
	} catch (err) {
		console.info(`\n  ⚠ could not enable Funnel (${err instanceof Error ? err.message.trim() : err}).`)
		console.info('    Funnel must be enabled for this tailnet: open the URL Tailscale printed above, or add the')
		console.info('    "funnel" nodeAttr in Admin console ▸ Access controls. Falling back to tailnet-only for now.')
		ensureServeOnly(bin, url, state)
	}
}

/** Print a scannable QR of `url` (theme-independent black-on-white). Never fatal — QR is a convenience. */
function printQr(url: string): void {
	try {
		console.info(`\n${qrLines(url).join('\n')}`)
	} catch (err) {
		console.info(`  (QR skipped: ${err instanceof Error ? err.message : err})`)
	}
}

function printUrl(): void {
	const token = currentToken()
	const frag = `#token=${token ?? '<starts on first run>'}`
	const bin = tailscaleBin()
	const dns = bin ? magicDnsName(bin) : null
	const state = bin ? tailscaleState(bin, dns) : { proxyOk: false, funnelOn: false }
	if (dns && state.proxyOk) {
		const scope = state.funnelOn ? 'public — any browser, token-gated' : 'same Tailnet only'
		const url = `https://${dns}/${frag}`
		console.info(`\n  Phone URL (HTTPS, ${scope}):\n    ${url}`)
		if (token) {
			console.info('\n  Scan to open on your phone:')
			printQr(url)
		}
		return
	}
	// Nothing fronting yet — the relay is only on loopback.
	console.info(`\n  Local URL:\n    http://127.0.0.1:${RELAY_PORT}/${frag}`)
	console.info(
		`\n  ⚠ Not reachable from your phone yet. Run \`tailscale funnel --bg ${RELAY_PORT}\` (public) or \`tailscale serve --bg ${RELAY_PORT}\` (tailnet)${dns ? ` → https://${dns}/` : ''}, then \`yarn service status\`.`
	)
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
	fs.mkdirSync(path.dirname(plistPath), { recursive: true })
	fs.mkdirSync(logDir, { recursive: true })
	fs.writeFileSync(plistPath, buildPlist())
	reloadAgent()
	console.info(`✓ installed LaunchAgent ${LABEL}`)
	console.info(`  plist: ${plistPath}`)
	console.info(`  logs:  ${logDir}/relay.log`)
	console.info(`  node:  ${process.execPath}`)
	ensureTailscale()
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
	printUrl()
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
	printUrl()
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
	default:
		console.error(
			`unknown command: ${cmd}\n` +
				'usage: service.ts <install|uninstall|restart|status> [flags]\n' +
				`  flags (install): ${Object.keys(FLAG_ENV).join(', ')}`
		)
		process.exit(1)
}
