// `conductor-remote nosleep [duration]` — keep this Mac fully awake, including with
// the lid closed, so the relay stays reachable and AppleScript sends can reach
// Conductor while you're away from the desk.
//
// The lever is `pmset -a disablesleep 1` (root): unlike a `caffeinate` idle
// assertion — which does NOT prevent lid-close/clamshell sleep on battery — this
// keeps the system genuinely awake with the lid shut. It needs sudo, so this is a
// FOREGROUND command (sudo prompts for your password on this terminal); the
// background LaunchAgent has no TTY and can't do it. The whole awake window runs
// inside one root shell whose EXIT/INT/TERM trap restores `disablesleep 0`, so
// Ctrl-C, a timeout, or a crash can't leave the Mac unable to sleep.
//
// Caveat: keeping the system awake lid-closed is necessary but may not be
// sufficient for AppleScript *delivery* — a closed lid with no display can leave
// the window server non-drivable (fix: a virtual/dummy display), and a locked
// screen blocks `activate`. If a send still doesn't land with nosleep on, that's
// the graphics surface, not power. Strip-clean (plain-node type-stripping),
// stdlib-only — see CLAUDE.md.

import { spawn } from 'node:child_process'

/** Parse `90m` / `2h` / `30s` / bare seconds into seconds; null = run until Ctrl-C. */
function parseDuration(raw: string | undefined): number | null {
	if (!raw) return null
	const m = raw.match(/^(\d+)(s|m|h)?$/)
	if (!m) {
		console.error(`nosleep: bad duration "${raw}" — use e.g. 90m, 2h, 30s, or a number of seconds`)
		process.exit(1)
	}
	const n = Number(m[1])
	const unit = m[2] ?? 's'
	return unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
}

function main(): void {
	if (process.platform !== 'darwin') {
		console.error('nosleep: macOS only (uses pmset).')
		process.exit(1)
	}

	const arg = process.argv[2]
	const seconds = parseDuration(arg)

	// Do everything as a single root shell: set the keep-awake, then either sleep for
	// the duration or idle forever, and ALWAYS restore on exit via the trap. One sudo
	// prompt covers set + restore, and the trap fires even on Ctrl-C / kill. Mirror the
	// proven battery setup — disablesleep + standby + Power Nap off — so the system
	// stays genuinely awake (not just idle-awake) with the lid shut.
	const sleepStep = seconds !== null ? `sleep ${seconds}` : 'while :; do sleep 86400; done'
	const set = 'pmset -a disablesleep 1 standby 0 powernap 0'
	const restore = 'pmset -a disablesleep 0 standby 1 powernap 1'
	const script = `${set} && trap '${restore}' EXIT INT TERM && ${sleepStep}`

	console.info('conductor-remote nosleep — keeping this Mac awake (incl. lid-closed system sleep).')
	console.info(seconds !== null ? `Duration: ${arg} — Ctrl-C to stop early.` : 'Runs until you press Ctrl-C.')
	// Be honest: this handles sleep only. It does NOT enable sending with the lid shut
	// on its own — that also needs the screen lock off (System Settings ▸ Lock Screen;
	// yours is set to lock immediately) and possibly a virtual display.
	console.info('Note: sleep only — lid-closed *sending* also needs the screen lock off.')
	console.info('sudo will ask for your password…\n')

	const child = spawn('sudo', ['sh', '-c', script], { stdio: 'inherit' })

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

main()
