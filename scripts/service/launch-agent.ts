import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { domain, LABEL, logDir, plistPath, projectDir } from './environment.ts'

function xml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Run launchctl, swallowing the exit code so "already-loaded"/"not-loaded" states aren't fatal. */
export function launchctl(...args: string[]): void {
	try {
		execFileSync('launchctl', args, { stdio: 'pipe' })
	} catch {
		// non-zero is expected for bootout-when-absent etc.; state is asserted by the caller's sequence
	}
}

/** Block the main thread briefly — used to let launchd settle between bootout and bootstrap. */
export function sleepSync(ms: number): void {
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
export function reloadAgent(): void {
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
export function buildPlist(): string {
	const node = xml(process.execPath)
	const proj = xml(projectDir)
	const out = xml(path.join(logDir, 'relay.log'))
	const err = xml(path.join(logDir, 'relay.err.log'))
	// node's own dir leads so the daemon can find `npm` (adjacent to node) for self-update under launchd's
	// bare PATH; Homebrew's bin is appended for tailscale/node on Apple Silicon.
	const nodeDir = path.dirname(process.execPath)
	const daemonPath = `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`
	// MANAGED marks this as the launchd-supervised instance: src/host/autoupdate.ts only self-restarts (exit →
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
