import fs from 'node:fs'
import path from 'node:path'
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
	readPlistEnv
} from './environment.ts'
import { buildPlist, launchctl, reloadAgent } from './launch-agent.ts'
import { ensureTailscale, resolveExposeMode } from './network.ts'
import { printUrl, printVoiceRoute } from './presentation.ts'
import { ensureVoiceFunnel } from './voice.ts'

/** npx unpacks into a throwaway cache that gets purged; a LaunchAgent baked against it would rot. */
function isEphemeralInstall(dir: string): boolean {
	return /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_npx[\\/]/.test(dir)
}

export function install(): void {
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
