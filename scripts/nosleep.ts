// `conductor-remote nosleep [duration | setup | status]` — keep this Mac fully
// awake and block its automatic screen lock, so the relay stays reachable and
// AppleScript sends can reach Conductor while you're away from the desk.
//
// The lever is `pmset -a disablesleep 1` (root): unlike a `caffeinate` idle
// assertion — which does NOT prevent lid-close/clamshell sleep on battery — this
// keeps the system genuinely awake with the lid shut. Root is why the command is
// normally FOREGROUND: sudo prompts on this terminal, and the background
// LaunchAgent has no TTY to prompt on. `nosleep setup` (nosleep-setup.ts) is what
// lifts that, and the only reason it exists. The whole awake window runs inside one
// root shell whose EXIT trap restores the captured values, so Ctrl-C, a timeout, or
// a crash can't leave the Mac unable to sleep.
//
// The helper also owns a process-scoped `caffeinate -d` assertion by default.
// ScreenSaverDaemon checks that assertion before starting the idle screen saver
// that locks the session. An explicit lock or lid close can still lock macOS;
// those sends park in `src/parked.ts` until the next unlock. Strip-clean
// (plain-node type-stripping), stdlib-only — see CLAUDE.md.

import { spawn } from 'node:child_process'
import { installedServiceEnvironment, preventScreenLockEnabled } from '../src/config.ts'
import { HELPER_PATH, helperFile, helperReady, installedHelper, NOSLEEP_BODY } from '../src/nosleep-helper.ts'
import { parseDurationSeconds } from '../src/shared.ts'
import { setup, status } from './nosleep-setup.ts'

/** Parse `90m` / `2h` / `30s` / bare seconds into seconds; null = run until Ctrl-C. */
function parseDuration(raw: string | undefined): number | null {
	if (!raw) return null
	const seconds = parseDurationSeconds(raw)
	if (seconds === null) {
		console.error(
			`nosleep: bad duration "${raw}" — use e.g. 90m, 2h, 30s, or a number of seconds.\n` +
				'Subcommands: `nosleep setup [--uninstall]`, `nosleep status`.'
		)
		process.exit(1)
	}
	return seconds
}

async function main(): Promise<void> {
	if (process.platform !== 'darwin') {
		console.error('nosleep: macOS only (uses pmset).')
		process.exit(1)
	}

	// Subcommands sit in the same slot as the duration, which they can never collide
	// with: a duration is digits with an optional s/m/h, so anything alphabetic here
	// is either a subcommand or a typo parseDuration rejects by name.
	const arg = process.argv[2]
	if (arg === 'setup') {
		await setup(process.argv[3])
		return
	}
	if (arg === 'status') {
		await status()
		return
	}

	const seconds = parseDuration(arg)
	const configuredMode = process.env.PREVENT_SCREEN_LOCK ?? installedServiceEnvironment().PREVENT_SCREEN_LOCK
	const preventScreenLock = preventScreenLockEnabled(configuredMode)
	// The shared body reads its window from an argument (0 = until killed) rather than
	// having one interpolated in, because the installed helper is a fixed file the
	// sudoers rule names — see nosleep-helper.ts. `label` is only echoed back, and the
	// script re-validates it, so the two paths print the same confirmation.
	const args = [String(seconds ?? 0), arg ?? '', preventScreenLock ? '1' : '0']

	console.info('conductor-remote nosleep — keeping this Mac awake (incl. lid-closed system sleep).')
	console.info(seconds !== null ? `Duration: ${arg} — Ctrl-C to stop early.` : 'Runs until you press Ctrl-C.')
	console.info(
		preventScreenLock
			? 'Automatic screen lock: blocked for this window.'
			: 'Automatic screen lock: allowed by config (prevent-screen-lock=off).'
	)

	// Prefer the root-owned helper `nosleep setup` installs: same script, no prompt, and
	// it is the only path a TTY-less caller (the LaunchAgent, and so the phone) can take.
	// Fall back to piping the body through `sudo sh -c`, which is the un-installed
	// experience and asks for a password.
	const viaHelper = await helperReady()
	if (viaHelper && installedHelper() !== helperFile()) {
		console.error(`✗ ${HELPER_PATH} is out of date — run \`conductor-remote nosleep setup\`, then try again.`)
		process.exit(1)
	}
	if (!viaHelper) {
		console.info('Tip: `conductor-remote nosleep setup` installs this once so it stops asking.')
		console.info('sudo will ask for your password…')
	}
	console.info('')

	const child = viaHelper
		? spawn('sudo', ['-n', HELPER_PATH, ...args], { stdio: 'inherit' })
		: spawn('sudo', ['sh', '-c', NOSLEEP_BODY, 'nosleep', ...args], { stdio: 'inherit' })

	// Forward Ctrl-C / termination so the root shell's trap restores sleep before we go.
	const forward = (sig: NodeJS.Signals) => () => child.kill(sig)
	process.on('SIGINT', forward('SIGINT'))
	process.on('SIGTERM', forward('SIGTERM'))

	child.on('exit', (code, signal) => {
		if (code === 0 || signal) console.info('\nSleep restored — the Mac can sleep normally again.')
		else
			console.error(`\nnosleep exited with code ${code}. If sleep is still disabled, run: sudo pmset -a disablesleep 0`)
		process.exit(code ?? 0)
	})
}

main().catch((err: unknown) => {
	console.error(`nosleep: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
})
