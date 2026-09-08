import fs from 'node:fs'
import path from 'node:path'
import { bindFailureLines, listenersOn, parsePortValue, probeListen } from '../../src/host/ports.ts'
import { exposeStorePath } from '../../src/host/tailscale.ts'
import { readVoiceConfig } from '../../src/voice/config.ts'
import {
	distBuilt,
	domain,
	LABEL,
	logDir,
	persistPinnedToken,
	plistPath,
	projectDir,
	RELAY_PORT,
	readPlistEnv,
	VOICE_PORT
} from './environment.ts'
import { agentPid, buildPlist, launchctl, reloadAgent } from './launch-agent.ts'
import { ensureTailscale, resolveExposeMode } from './network.ts'
import { printUrl, printVoiceRoute } from './presentation.ts'
import { ensureVoiceFunnel } from './voice.ts'

/** npx unpacks into a throwaway cache that gets purged; a LaunchAgent baked against it would rot. */
function isEphemeralInstall(dir: string): boolean {
	return /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_npx[\\/]/.test(dir)
}

/**
 * Refuse a port the relay cannot have, before the plist is written and launchd is reloaded.
 *
 * The alternative is the daemon's own crash: `server.listen` reaches launchd as an unhandled error
 * event, KeepAlive respawns it, and the loop's only trace is a stack trace in relay.err.log — while
 * install itself prints a success line, a phone URL and a QR code for a relay that is not running.
 * A port our own daemon holds is not a conflict; a re-install boots it out moments later.
 */
async function assertPortFree(what: string, host: string, port: number, setting: 'port' | 'voice-port'): Promise<void> {
	const code = await probeListen(host, port)
	if (code === null) return
	if (code === 'EADDRINUSE') {
		const ours = agentPid()
		const holders = listenersOn(port)
		if (ours !== null && holders.length > 0 && holders.every(holder => holder.pid === ours)) return
	}
	for (const line of bindFailureLines(what, host, port, code, setting)) console.error(line)
	process.exit(1)
}

/** Both ports, resolved from flags or the ambient environment, checked together and against the machine. */
async function assertPortsUsable(): Promise<void> {
	const relay = parsePortValue(RELAY_PORT)
	if (relay === null) {
		console.error(`✗ the relay port must be a whole number from 1 to 65535, not "${RELAY_PORT}".`)
		console.error('  Set it with `--port <n>` (or `conductor-remote config set port <n>`).')
		process.exit(1)
	}
	const voice = parsePortValue(VOICE_PORT)
	if (voice === null) {
		console.error(`✗ the voice port must be a whole number from 1 to 65535, not "${VOICE_PORT}".`)
		console.error('  Set it with `--voice-port <n>` (or `conductor-remote config set voice-port <n>`).')
		process.exit(1)
	}
	// The two servers live in one process, so equal ports are a collision the relay finds at boot rather
	// than a configuration the machine can report as busy. 8788 is the voice default and a habitual
	// second relay port, which is how this pair meets by accident.
	if (relay === voice) {
		console.error(`✗ the relay and the voice listener would both bind :${relay}.`)
		console.error('  They are two servers in one process; give them different ports.')
		process.exit(1)
	}
	await assertPortFree('the relay', process.env.RELAY_HOST ?? '127.0.0.1', relay, 'port')
	// The voice listener is loopback-only by construction (src/server.ts); Funnel is what publishes it.
	await assertPortFree('the voice listener', '127.0.0.1', voice, 'voice-port')
}

export async function install(): Promise<void> {
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
	await assertPortsUsable()
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

export function uninstall(): void {
	launchctl('bootout', `${domain}/${LABEL}`)
	try {
		fs.rmSync(plistPath)
	} catch {
		// already gone
	}
	console.info(`✓ removed LaunchAgent ${LABEL}`)
}

export function restart(): void {
	launchctl('kickstart', '-k', `${domain}/${LABEL}`)
	console.info(`✓ restarted ${LABEL}`)
	const env = readPlistEnv()
	const relayPort = env.RELAY_PORT ?? '8787'
	printUrl(relayPort)
	printVoiceRoute(relayPort, env.VOICE_PORT ?? '8788')
}
