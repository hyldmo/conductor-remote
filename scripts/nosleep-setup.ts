// `conductor-remote nosleep setup` — pay the sudo password once, so `nosleep`
// never asks again. Called from scripts/nosleep.ts; not an entrypoint of its own.
//
// Why this exists: `pmset disablesleep` is the only lever that keeps a Mac awake
// with the lid shut, it needs root, and the login LaunchAgent has no TTY to prompt
// on. So the relay can never arm it, and neither can a phone. This installs the one
// thing that fixes both — a root-owned helper plus a sudoers rule naming it — and
// nothing else changes on the machine.
//
// The three ways a rule like this becomes a root hole, and what is done about each:
//
//   1. A helper anyone can rewrite is passwordless root for everything. `/usr/local/bin`
//      is group-writable by admin on a stock Mac, so the helper goes in a
//      root-owned `/usr/local/libexec` this creates, mode 0755, and the install
//      reads the file back to confirm what actually landed.
//   2. A helper inside the package is a supply-chain root hole: conductor-remote
//      self-updates and npm runs as you, so a rule pointing into node_modules hands
//      root to every future version. The helper is COPIED out once and never
//      re-copied on its own; drift is reported and re-installing is a deliberate act.
//   3. A wildcard in the rule ("pmset *") grants far more than the one thing wanted.
//      The rule names an absolute path with no argument pattern, and the helper
//      validates its own arguments.
//
// A broken /etc/sudoers.d entry can cost you sudo entirely, so the drop-in is
// checked with `visudo -cf` as a draft, and the whole assembled set is re-checked
// after install with the drop-in removed again on failure.
//
// Strip-clean (plain-node type-stripping), stdlib-only — see CLAUDE.md.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	HELPER_PATH,
	helperFile,
	helperReady,
	installedHelper,
	SUDOERS_PATH,
	sudoersFile
} from '../src/host/nosleep-helper.ts'

const LIBEXEC_DIR = path.dirname(HELPER_PATH)

/**
 * Every directory between `/` and the helper, root first. The sudoers rule is only as
 * strong as the weakest link in this chain: write access to any one of them means write
 * access to the path the rule names, and so passwordless root for whoever has it.
 */
const ANCESTORS = (() => {
	const out: string[] = []
	for (let dir = LIBEXEC_DIR; ; dir = path.dirname(dir)) {
		out.unshift(dir)
		if (dir === path.dirname(dir)) break
	}
	return out
})()

/** The account the rule names. Under `sudo` that is the human behind it, never root. */
function targetUser(): string {
	const raw = process.getuid?.() === 0 ? process.env.SUDO_USER : os.userInfo().username
	if (!raw || raw === 'root') {
		console.error(
			'nosleep setup: run it as yourself, not as root — the rule has to name your account.\n' +
				'It asks for your password on its own.'
		)
		process.exit(1)
	}
	// A username is interpolated straight into sudoers; anything exotic would either
	// break the file or widen the rule, and visudo would reject it later anyway.
	if (!/^[a-z_][a-z0-9._-]*$/i.test(raw)) {
		console.error(`nosleep setup: refusing to write a sudoers rule for the unusual username "${raw}".`)
		process.exit(1)
	}
	return raw
}

function runRoot(script: string, args: string[]): number {
	const res = spawnSync('sudo', ['sh', '-c', script, 'nosleep-setup', ...args], { stdio: 'inherit' })
	if (res.error) {
		console.error(`nosleep setup: could not run sudo (${res.error.message})`)
		return 1
	}
	return res.status ?? 1
}

/** Whether sleep is blocked *right now*, independent of who blocked it. */
function sleepDisabled(): boolean | null {
	try {
		const out = execFileSync('pmset', ['-g'], { encoding: 'utf8', timeout: 5000 })
		const m = out.match(/SleepDisabled\s+(\d)/)
		return m ? m[1] === '1' : null
	} catch {
		return null
	}
}

/** `nosleep status` — what is installed, whether it actually works, and the live state. */
export async function status(): Promise<void> {
	const installed = installedHelper()
	const ready = await helperReady()
	const current = installed !== null && installed === helperFile()
	const blocked = sleepDisabled()

	console.info(`sleep    ${blocked === null ? 'unknown' : blocked ? 'BLOCKED right now' : 'normal'}`)
	console.info(`helper   ${HELPER_PATH}`)
	console.info(
		`         ${installed === null ? 'not installed' : current ? 'installed, current' : 'installed, OUT OF DATE'}`
	)
	console.info(`sudoers  ${SUDOERS_PATH}`)
	console.info(`         ${fs.existsSync(SUDOERS_PATH) ? 'present' : 'not installed'}`)
	console.info('')
	console.info(
		ready
			? '✓ nosleep runs without a password.'
			: '✗ nosleep still asks for your password. Run: conductor-remote nosleep setup'
	)
	if (ready && !current)
		console.info('  The installed helper differs from this version — re-run `nosleep setup` to refresh it.')
	if (blocked && !ready)
		console.info('  Sleep is blocked but not by an installed helper — check for a `nosleep` running elsewhere.')
}

export async function install(): Promise<void> {
	const user = targetUser()
	// 0700 and owned by us, so the drafts root is about to read can't be swapped by
	// another account between writing them and installing them.
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-nosleep-'))
	const helperDraft = path.join(staging, 'helper')
	const sudoersDraft = path.join(staging, 'sudoers')
	const wanted = helperFile()
	fs.writeFileSync(helperDraft, wanted, { mode: 0o600 })
	fs.writeFileSync(sudoersDraft, sudoersFile(user), { mode: 0o600 })

	const script = [
		'set -e',
		`install -d -o root -g wheel -m 755 ${LIBEXEC_DIR}`,
		// A root-owned helper inside a directory someone else can rename is still someone
		// else's helper: replacing any ancestor replaces the path the rule names. Only the
		// leaf is fixed above, so check the whole chain and refuse rather than half-secure
		// the machine. This bites on Intel Macs, where Homebrew leaves /usr/local root:admin
		// and group-writable — the same reason /usr/local/bin was disqualified to begin with.
		`bad=$(find ${ANCESTORS.join(' ')} -maxdepth 0 \\( ! -user root -o -perm -0020 -o -perm -0002 \\) 2>/dev/null)`,
		`if [ -n "$bad" ]; then`,
		`\techo "nosleep setup: refusing — these are writable by someone other than root, so ${HELPER_PATH} could be swapped:" >&2`,
		'\techo "$bad" >&2',
		'\techo "Fix the ownership (sudo chown root:wheel <dir>; sudo chmod go-w <dir>) and run setup again." >&2',
		'\texit 1',
		'fi',
		`install -o root -g wheel -m 755 "$1" ${HELPER_PATH}`,
		// Validate the draft before it can affect anything.
		'visudo -cf "$2" >/dev/null',
		`install -o root -g wheel -m 440 "$2" ${SUDOERS_PATH}`,
		// And validate the assembled set, backing the drop-in out if it broke sudo.
		`if ! visudo -c >/dev/null; then rm -f ${SUDOERS_PATH}; echo 'nosleep setup: sudoers rejected the drop-in — removed it again, nothing changed.' >&2; exit 1; fi`
	].join('\n')

	console.info('conductor-remote nosleep setup — one-time install, so nosleep stops asking for a password.')
	console.info(`  ${HELPER_PATH}   (root-owned helper)`)
	console.info(`  ${SUDOERS_PATH}          (NOPASSWD for that one command, as ${user})`)
	console.info('sudo will ask for your password…\n')

	const code = runRoot(script, [helperDraft, sudoersDraft])
	fs.rmSync(staging, { recursive: true, force: true })
	if (code !== 0) {
		console.error('\nnosleep setup: install failed — nothing was left behind.')
		process.exit(code)
	}

	// Read back rather than trust the exit code: this is the file about to hold
	// passwordless root, so confirm the bytes that landed are the bytes we wrote.
	if (installedHelper() !== wanted) {
		console.error(`\nnosleep setup: ${HELPER_PATH} does not match what was installed. Refusing to call this done.`)
		process.exit(1)
	}
	if (!(await helperReady())) {
		console.error(
			'\nnosleep setup: the files are in place but sudo still wants a password.\n' +
				`Check that ${SUDOERS_PATH} is mode 0440 root:wheel, and that /etc/sudoers includes /etc/sudoers.d.`
		)
		process.exit(1)
	}
	console.info('\n✓ Done. `conductor-remote nosleep 2h` now runs with no prompt.')
	console.info('  Undo any time: conductor-remote nosleep setup --uninstall')
}

export function uninstall(): void {
	if (installedHelper() === null && !fs.existsSync(SUDOERS_PATH)) {
		console.info('nosleep setup: nothing installed.')
		return
	}
	// The grant goes first: a failure part-way should never leave a rule pointing at
	// a path that no longer exists (or worse, one something else could create).
	const script = ['set -e', `rm -f ${SUDOERS_PATH}`, `rm -f ${HELPER_PATH}`, 'visudo -c >/dev/null'].join('\n')
	console.info('Removing the nosleep helper and its sudoers rule. sudo will ask for your password…\n')
	const code = runRoot(script, [])
	if (code !== 0) process.exit(code)
	console.info('\n✓ Removed. `nosleep` will ask for your password again.')
}

/** `nosleep setup [--uninstall]`. */
export async function setup(flag: string | undefined): Promise<void> {
	if (flag === undefined) {
		await install()
		return
	}
	if (flag === '--uninstall' || flag === 'uninstall') {
		uninstall()
		return
	}
	console.error(`nosleep setup: unknown option "${flag}" — the only one is --uninstall.`)
	process.exit(1)
}
