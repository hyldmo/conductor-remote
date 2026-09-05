/**
 * Install-time knobs are accepted as documented CLI flags OR the matching env var — a flag wins over the
 * ambient env. Parsed flags are folded back into process.env so everything downstream (and the plist we
 * bake) keeps reading a single source. Runs before any module-level env read below.
 */
export const FLAG_ENV: Record<string, string> = {
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

export function applyFlags(argv: string[]): void {
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
