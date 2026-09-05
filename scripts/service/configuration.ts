import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serviceEnvironmentWithSetting } from '../../src/config.ts'
import {
	exposeStorePath,
	FUNNEL_PORTS,
	normalizeExposeMode,
	relayServeState,
	tailscaleBin
} from '../../src/host/tailscale.ts'
import { readVoiceConfig, setVoiceSetting, VOICE_SETTING_NAMES } from '../../src/voice/config.ts'
import { domain, LABEL, plistPath, projectDir, readPlistEnv } from './environment.ts'
import { FLAG_ENV } from './flags.ts'
import { tailscaleState } from './network.ts'

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
		// The runtime's own precedence (src/host/tailscale.ts ▸ readExposeMode): env, then the persisted
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
		// posture is public (src/host/funnel-watchdog.ts ▸ wantEnabled + startFunnelWatchdog).
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
export function config(): void {
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
		{ name: 'voice.reasoning-effort', value: voice.reasoningEffort, source: 'voice file' },
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
