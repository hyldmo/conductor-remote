// The root half of `nosleep`, in one place.
//
// The same POSIX-sh body runs two ways: piped to `sudo sh -c` (asks for your
// password) or as the root-owned helper `nosleep setup` installs (doesn't). Keeping
// one copy is what stops those two paths from drifting into different restore
// behaviour, which is the half that matters — an un-restored `disablesleep` leaves
// a Mac that can never sleep again.
//
// It reads its arguments rather than having them interpolated in, because the
// installed helper is a fixed file that a sudoers rule names: the duration has to
// arrive at run time, and the rule grants the path with no argument pattern. So the
// script validates its own input (digits only) instead of trusting the caller.
//
// Strip-clean (plain-node type-stripping), stdlib-only — see CLAUDE.md.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the shell body is full of POSIX parameter expansions (${1:-0}, ${sb:-1}) in ordinary strings — that is the point, not a mis-typed template literal.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Absolute path of the root-owned helper. Must sit in a directory only root can write. */
export const HELPER_PATH = '/usr/local/libexec/conductor-remote-nosleep'

/**
 * Where the armed window records itself: `<pid> <expiry-epoch> <start-token> <prevent-lock>`
 * (expiry 0 = until killed). Written by root, mode 0644, because the relay has to *read* it on
 * every status poll and a sudo round-trip per poll would be absurd. It is the lock as
 * well as the record — see the one-owner note on NOSLEEP_BODY.
 *
 * The third field is the process's own start time with the spaces squeezed out, and it
 * is what makes the pid trustworthy. A pid alone is not an identity: a window killed
 * with SIGKILL leaves this file behind, macOS recycles pids freely, and the helper runs
 * as root — so `kill -0` succeeds against whatever inherited the number, and `--stop`
 * would then SIGTERM an unrelated root process. Readers that only want the pid and the
 * expiry (`src/host/nosleep.ts` ▸ readPidfile) can ignore it; a two-field file from an older
 * version still parses, and skips the check. The fourth field records whether this
 * window also holds the display assertion that blocks the automatic screen lock.
 */
export const PIDFILE_PATH = '/var/run/conductor-remote-nosleep.pid'

/**
 * sudo's `@includedir` skips any drop-in whose name contains a dot or ends in `~`,
 * silently — so this filename has neither, and adding an extension would install a
 * file that reads fine and never takes effect.
 */
export const SUDOERS_PATH = '/etc/sudoers.d/conductor-remote'
/** Fixed absolute path because this body runs through a passwordless root helper. */
export const CAFFEINATE_PATH = '/usr/bin/caffeinate'

/**
 * `$1` = seconds to stay awake, 0 = until killed, or one of `--check` / `--stop`.
 * `$2` = optional display label ("90m") echoed back in the confirmation, validated to
 * the same charset the CLI accepts so nothing arbitrary reaches the terminal.
 * `$3` = 1 to block the automatic screen lock for the window, 0 to allow it.
 *
 * Restore is on the EXIT trap only; INT/TERM/HUP just `exit`, so a signal can't run
 * the restore twice. The captured values are read *before* anything changes and put
 * back verbatim — never defaults, or a `standby 0` somebody set on purpose gets
 * clobbered. `sleep` runs in the background with an explicit `wait` because a
 * foreground `sleep` makes the shell defer its trap until the sleep ends, which for
 * a 2h window means SIGTERM does nothing for 2h.
 *
 * **Exactly one window may be armed**, and arming takes over rather than refusing.
 * Capture-and-restore is only correct for a single owner: a second window would
 * capture the *first* one's already-flipped values (standby 0, disablesleep 1) and
 * "restore" those on its way out, leaving a Mac that can never sleep again. So a new
 * arm signals the incumbent and waits for its restore to land before capturing. That
 * is also why the phone arming a window kills one you left running in a terminal —
 * intended, and the reason `--stop` exists rather than a plain `kill`, since the
 * armed process runs as root and you can't signal it yourself.
 *
 * **That wait is bounded, so it must fail closed.** Waiting forever would hang the
 * relay's arm request; capturing anyway is the one move that produces the permanent
 * failure above, and it is reachable — an incumbent stuck in `pmset`, or a pid that
 * was recycled while the record went stale, never answers the signal. So the wait
 * expiring is an error (exit 75, EX_TEMPFAIL), not a green light. Refusing to arm
 * costs a phone tap. Capturing the flipped values costs a Mac that cannot sleep,
 * silently, with nothing armed to point at.
 */
export const NOSLEEP_BODY = [
	'set -u',
	'',
	`pidfile=${PIDFILE_PATH}`,
	'',
	// A pid is not an identity — see the PIDFILE_PATH note. Squeezing the spaces out of
	// `lstart` makes it one whitespace-delimited token, so the record stays a single
	// awk-readable line and a stale pid that has been recycled fails to match.
	'procStart() { ps -p "$1" -o lstart= 2>/dev/null | tr -d \' \\n\'; }',
	'',
	'# The pid of the armed window, or empty when nothing valid is recorded.',
	'armedPid() {',
	'\t[ -f "$pidfile" ] || return 0',
	'\tset -- $(awk \'NR==1{print $1, $2, $3}\' "$pidfile" 2>/dev/null)',
	'\tp=${1:-}',
	'\ttok=${3:-}',
	'\tcase "$p" in \'\' | *[!0-9]*) return 0 ;; esac',
	'\tkill -0 "$p" 2>/dev/null || return 0',
	// No token means a record from an older version: fall back to the pid alone rather
	// than treating a live window as absent, which would let a second one arm alongside it.
	'\tif [ -n "$tok" ] && [ "$(procStart "$p")" != "$tok" ]; then return 0; fi',
	'\techo "$p"',
	'}',
	'',
	'arg=${1:-0}',
	// The probe `helperReady()` runs. It has to be the real path under the real sudo
	// rule — the files being present proves nothing, since a drop-in with the wrong
	// mode or a name includedir skips sits there looking installed and does nothing.
	'if [ "$arg" = --check ]; then echo ok; exit 0; fi',
	// Disarm. Root-only by necessity: the armed process runs as root, so nothing the
	// relay does as itself can signal it. Reached through the same sudoers rule.
	'if [ "$arg" = --stop ]; then',
	'\tp=$(armedPid)',
	'\tif [ -n "$p" ]; then kill -TERM "$p" 2>/dev/null; echo stopped; else rm -f "$pidfile"; echo idle; fi',
	'\texit 0',
	'fi',
	'secs=$arg',
	'label=${2:-}',
	'preventlock=${3:-1}',
	"case \"$secs\" in '' | *[!0-9]*) echo 'nosleep: seconds must be digits (0 = until killed)' >&2; exit 64 ;; esac",
	'case "$label" in *[!0-9smh]*) label=\'\' ;; esac',
	'case "$preventlock" in 0 | 1) ;; *) echo \'nosleep: prevent-screen-lock must be 0 or 1\' >&2; exit 64 ;; esac',
	'',
	'# Take over from any incumbent BEFORE capturing, or we would capture its flipped',
	'# values and restore those — the one way this leaves a Mac unable to sleep.',
	'old=$(armedPid)',
	'if [ -n "$old" ] && [ "$old" != "$$" ]; then',
	'\tkill -TERM "$old" 2>/dev/null',
	'\tn=0',
	'\twhile kill -0 "$old" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done',
	// Fail closed. Capturing now would read the incumbent's flipped values and "restore"
	// those on the way out, which is the permanent no-sleep this whole block exists to stop.
	'\tif kill -0 "$old" 2>/dev/null; then',
	'\t\techo "nosleep: the armed window ($old) did not stop within 5s; refusing to arm" >&2',
	'\t\texit 75',
	'\tfi',
	'fi',
	'',
	'# Per-source values live in the Battery Power block; disablesleep is global.',
	'battval() { pmset -g custom | awk -v k="$1" \'/^Battery Power:/{b=1;next} /^AC Power:/{b=0} b&&$1==k{print $2;exit}\'; }',
	'sb=$(battval standby)',
	'pn=$(battval powernap)',
	"ds=$(pmset -g | awk '/SleepDisabled/{print $2;exit}')",
	'',
	"sleeper=''",
	"displaykeeper=''",
	'cleanup() {',
	'\tif [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null || true; fi',
	'\tif [ -n "$displaykeeper" ]; then kill "$displaykeeper" 2>/dev/null || true; wait "$displaykeeper" 2>/dev/null || true; fi',
	'\tpmset -b standby "${sb:-1}" powernap "${pn:-1}"',
	'\tpmset -a disablesleep "${ds:-0}"',
	// Only clear the record if it is still ours: a successor that already took over
	// has written its own, and wiping that would strand it as invisible.
	'\tif [ "$(awk \'NR==1{print $1}\' "$pidfile" 2>/dev/null)" = "$$" ]; then rm -f "$pidfile"; fi',
	'}',
	'# Armed before anything changes, so even a pmset that fails half-way reverts.',
	'trap cleanup EXIT',
	"trap 'exit 130' INT",
	"trap 'exit 143' TERM HUP",
	'',
	'pmset -b standby 0 powernap 0',
	'pmset -a disablesleep 1',
	'',
	'# ScreenSaverDaemon consults PreventUserIdleDisplaySleep before starting the idle',
	'# screen saver that locks the session. The assertion is process-scoped, so macOS',
	'# drops it even if the helper is killed before its EXIT trap can run.',
	'if [ "$preventlock" = 1 ]; then',
	`\t${CAFFEINATE_PATH} -d -w "$$" &`,
	'\tdisplaykeeper=$!',
	'\tsleep 0.1',
	'\tif ! kill -0 "$displaykeeper" 2>/dev/null; then echo "nosleep: could not block the automatic screen lock" >&2; exit 69; fi',
	'fi',
	'',
	'until=0',
	'if [ "$secs" -gt 0 ]; then until=$(( $(date +%s) + secs )); fi',
	// 0644 so the relay can poll the state without a sudo round-trip per tick.
	'printf \'%s %s %s %s\\n\' "$$" "$until" "$(procStart $$)" "$preventlock" > "$pidfile" && chmod 644 "$pidfile"',
	'',
	'# A long window is ambiguous without the weekday: "until 15:45" reads as today.',
	'clock() {',
	'\tif [ "$(date -r "$1" \'+%j\')" = "$(date \'+%j\')" ]; then date -r "$1" \'+%H:%M\'; else date -r "$1" \'+%a %H:%M\'; fi',
	'}',
	'',
	// Printed from in here, after pmset applies: it is the only signal that the
	// password landed and the setting actually took. The clock starts here too, not
	// when the command was typed.
	"echo ''",
	'if [ "$secs" -gt 0 ]; then',
	'\tsuffix=""',
	'\tif [ -n "$label" ]; then suffix="$label, "; fi',
	'\techo "✓ Sleep disabled until $(clock "$until") (${suffix}incl. lid closed). Ctrl-C to restore."',
	'\tsleep "$secs" &',
	'else',
	'\techo "✓ Sleep disabled at $(date \'+%H:%M\') (incl. lid closed) — until you press Ctrl-C."',
	'\tsleep 2147483647 &',
	'fi',
	'if [ "$preventlock" = 1 ]; then',
	'\techo "⚠ Automatic screen lock is disabled for this window. Anyone with physical access can use this Mac."',
	'else',
	'\techo "Automatic screen lock remains enabled (prevent-screen-lock=off)."',
	'fi',
	'sleeper=$!',
	'wait "$sleeper"'
].join('\n')

/** The helper as installed: the shared body with a shebang and a note on where it came from. */
export function helperFile(): string {
	return [
		'#!/bin/sh',
		'# conductor-remote nosleep helper — installed by `conductor-remote nosleep setup`.',
		'#',
		`# Runs as root via a scoped NOPASSWD rule in ${SUDOERS_PATH}. That rule is only`,
		'# as safe as this file: it MUST stay root-owned and non-writable by anyone else, or',
		'# granting it passwordless root grants passwordless root to everything.',
		'# Remove both with `conductor-remote nosleep setup --uninstall`.',
		'',
		NOSLEEP_BODY,
		''
	].join('\n')
}

/**
 * The helper as it exists on disk, or null when it isn't installed. Compared against
 * `helperFile()` to catch the copy going stale: the package self-updates and this
 * file deliberately does not follow, so drift is a thing to report, never to fix
 * behind the user's back (see the supply-chain note in nosleep-setup.ts).
 */
export function installedHelper(): string | null {
	try {
		return fs.readFileSync(HELPER_PATH, 'utf8')
	} catch {
		return null
	}
}

/**
 * True when the helper will actually run as root without a password.
 *
 * It runs the real command under the real rule, because every cheaper check lies.
 * `sudo -l <cmd>` answers "may this user run it", which is yes for anyone holding
 * blanket `(ALL) ALL` whether or not NOPASSWD applies (measured on this Mac: an
 * unlisted `/usr/bin/pmset` still listed clean). `-k` is what makes the answer
 * about the rule instead of a warm timestamp: it ignores cached credentials for
 * this call only, without clearing them, so probing doesn't cost the user a
 * re-prompt. `--check` exits before touching pmset, so the probe has no effect.
 *
 * Async because it sits behind two token-gated routes and the relay is one thread. A
 * synchronous `sudo` here stops every poll on the phone for as long as it takes, and the
 * 5s ceiling is the whole budget when sudo is slow to answer.
 */
export async function helperReady(): Promise<boolean> {
	try {
		const { stdout } = await execFileP('sudo', ['-n', '-k', HELPER_PATH, '--check'], {
			encoding: 'utf8',
			timeout: 5000
		})
		return stdout.trim() === 'ok'
	} catch {
		return false
	}
}

/**
 * The sudoers drop-in. One command, named absolutely, no argument wildcard — the
 * helper validates its own arguments, and a wildcard here would be the usual way
 * this kind of rule turns into a root shell.
 */
export function sudoersFile(user: string): string {
	return [
		'# conductor-remote — installed by `conductor-remote nosleep setup`.',
		'#',
		`# Lets ${user} arm and restore lid-closed sleep with no password, which is what`,
		'# lets the relay do it: the login LaunchAgent has no TTY to prompt on.',
		'# Scoped to exactly one root-owned command. Undo: `conductor-remote nosleep setup --uninstall`.',
		`Cmnd_Alias CONDUCTOR_REMOTE_NOSLEEP = ${HELPER_PATH}`,
		`${user} ALL=(root) NOPASSWD: CONDUCTOR_REMOTE_NOSLEEP`,
		''
	].join('\n')
}
