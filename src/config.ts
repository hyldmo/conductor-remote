import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageRoot } from './pkg-root.ts'
import type { WriteStrategy } from './writes/types.ts'

const home = os.homedir()

export interface Config {
	/** Path to Conductor's live SQLite state DB (read-only source of truth for reads). */
	dbPath: string
	/** Root under which Conductor lays out per-workspace git worktrees. */
	workspacesRoot: string
	/** TCP port the relay listens on. */
	port: number
	/** Host to bind. Loopback by default; the tailnet-facing URL is fronted by `tailscale serve`. Override with RELAY_HOST. */
	host: string
	/** Shared secret required on every /api/* request. Auto-generated if unset. */
	token: string
	/** Prompt delivery strategy: 'applescript' (default, focused session) or 'sidecar' (precise per-session IPC). */
	writeStrategy: WriteStrategy
	/** Block the automatic screen lock during phone-armed nosleep windows. */
	preventScreenLock: boolean
	/** Directory of built PWA assets to serve. */
	publicDir: string
	/**
	 * `yarn dev` only: the Vite dev server's port. Set, it means Vite serves the PWA and
	 * proxies /api here, so this process's own origin serves no app — the startup banner
	 * points at Vite's instead of at a URL that would 404.
	 */
	devWebPort?: number
}

/** The CLI and daemon share one on/off setting. Only `off` opts out. */
export function preventScreenLockEnabled(raw = process.env.PREVENT_SCREEN_LOCK): boolean {
	return raw?.trim().toLowerCase() !== 'off'
}

/**
 * The relay's own state directory — its token, its Funnel posture, its undelivered
 * first prompts. Never Conductor's: everything about Conductor is read from the DB.
 */
export function stateDir(): string {
	return path.join(home, 'Library', 'Application Support', 'conductor-remote')
}

/** The runtime configuration baked into the installed LaunchAgent, or an empty object. */
export function installedServiceEnvironment(): Record<string, string> {
	const plist = path.join(home, 'Library', 'LaunchAgents', 'no.adluna.conductor-remote.plist')
	try {
		const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], {
			encoding: 'utf8',
			stdio: 'pipe'
		})
		const env = JSON.parse(out)?.EnvironmentVariables
		return env && typeof env === 'object' ? (env as Record<string, string>) : {}
	} catch {
		return {}
	}
}

/** Build the environment for a one-setting service update without changing its other knobs. */
export function serviceEnvironmentWithSetting(
	ambient: NodeJS.ProcessEnv,
	installed: Record<string, string>,
	configKeys: Iterable<string>,
	key: string,
	value: string
): NodeJS.ProcessEnv {
	const next = { ...ambient }
	const known = new Set(configKeys)
	for (const configKey of known) delete next[configKey]
	for (const [installedKey, installedValue] of Object.entries(installed)) {
		if (known.has(installedKey)) next[installedKey] = installedValue
	}
	next[key] = value
	return next
}

/** Where a generated token is persisted so a phone's saved URL stays valid across relay restarts. */
function tokenStorePath(): string {
	return path.join(stateDir(), 'token')
}

/**
 * Stable shared secret. Explicit `RELAY_TOKEN` wins; otherwise reuse a persisted token (or mint and
 * persist one). Persistence matters for the daemon: a KeepAlive restart must not invalidate the URL
 * the user added to their home screen.
 */
function resolveToken(): string {
	if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN
	const file = tokenStorePath()
	try {
		const existing = fs.readFileSync(file, 'utf8').trim()
		if (existing) return existing
	} catch {
		// no persisted token yet — mint one below
	}
	const token = crypto.randomBytes(16).toString('hex')
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, token, { mode: 0o600 })
	} catch (err) {
		console.warn(`⚠ could not persist token (${err instanceof Error ? err.message : err}); it will rotate on restart`)
	}
	return token
}

/**
 * The relay serves the Vite build. Warn early if it hasn't been built yet — except under
 * `yarn dev`, where Vite serves the PWA from source on its own port and this process only
 * answers the /api calls proxied to it. `dist/` is untouched there, so the warning names a
 * build nobody needs and it fired on every dev start.
 */
function resolvePublicDir(devMode: boolean): string {
	const dist = path.join(packageRoot(import.meta.dirname), 'dist')
	if (!devMode && !fs.existsSync(path.join(dist, 'index.html'))) {
		console.warn(
			'⚠ dist/ not built — run `yarn build` (or `yarn preview`). The API works; the PWA will 404 until then.'
		)
	}
	return dist
}

export function loadConfig(): Config {
	// Bind loopback; `tailscale serve` (wired by `yarn deploy`) fronts it with a stable HTTPS tailnet URL.
	const host = process.env.RELAY_HOST ?? '127.0.0.1'
	// Both set by `numux.config.ts` — the dev orchestrator is the only thing that knows Vite's port.
	const devMode = Boolean(process.env.RELAY_DEV)
	const devWebPort = devMode ? Number(process.env.WEB_PORT) || undefined : undefined
	const writeStrategy: WriteStrategy = process.env.WRITE_STRATEGY === 'sidecar' ? 'sidecar' : 'applescript'
	return {
		dbPath:
			process.env.CONDUCTOR_DB ??
			path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db'),
		workspacesRoot: process.env.CONDUCTOR_WORKSPACES ?? path.join(home, 'conductor', 'workspaces'),
		port: Number(process.env.RELAY_PORT ?? 8787),
		host,
		token: resolveToken(),
		writeStrategy,
		preventScreenLock: preventScreenLockEnabled(),
		publicDir: resolvePublicDir(devMode),
		devWebPort
	}
}
