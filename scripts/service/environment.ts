import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installedServiceEnvironment } from '../../src/config.ts'
import { relayPort } from '../../src/host/tailscale.ts'
import { packageRoot } from '../../src/pkg-root.ts'

export const LABEL = 'no.adluna.conductor-remote'

export const projectDir = packageRoot(import.meta.dirname)

export const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

export const logDir = path.join(os.homedir(), 'Library', 'Logs', 'conductor-remote')

const uid = process.getuid?.() ?? 0

export const domain = `gui/${uid}`

export function distBuilt(): boolean {
	return fs.existsSync(path.join(projectDir, 'dist', 'index.html'))
}

function tokenStorePath(): string {
	return path.join(os.homedir(), 'Library', 'Application Support', 'conductor-remote', 'token')
}

/** Read the persisted token (or env override) purely to print the phone URL — never mints one. */
export function currentToken(): string | null {
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
export function persistPinnedToken(): void {
	const token = process.env.RELAY_TOKEN
	if (!token) return
	try {
		fs.mkdirSync(path.dirname(tokenStorePath()), { recursive: true })
		fs.writeFileSync(tokenStorePath(), token, { mode: 0o600 })
	} catch (err) {
		console.info(`  ⚠ could not persist --token (${err instanceof Error ? err.message : err})`)
	}
}

export const RELAY_PORT = relayPort()

export const VOICE_PORT = String(process.env.VOICE_PORT ?? 8788)

/**
 * The daemon's environment, read back out of the plist it was installed with.
 *
 * This is the whole point of `config`: `process.env` here belongs to *your shell*, and the daemon
 * runs under launchd with whatever `buildPlist()` baked in. Reading the shell's env to report the
 * daemon's configuration is how a posture change can look applied while the running relay still
 * believes something else — which is exactly the bug that made EXPOSE a plist entry.
 */
export function readPlistEnv(): Record<string, string> {
	return installedServiceEnvironment()
}
