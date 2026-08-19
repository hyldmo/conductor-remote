/**
 * Run the nosleep shell body against a stub `pmset` and assert it always puts the
 * power settings back.
 *
 * `NOSLEEP_BODY` (src/nosleep-helper.ts) is a shell script living inside a TypeScript
 * string, so `tsc` sees a string and Biome sees a string. Nothing in this repo reads it
 * as code. It also carries the one bug class here that costs something real: get the
 * capture-and-restore wrong and the Mac is left with `disablesleep 1` and no armed
 * process, which looks like nothing is wrong and has no fix on the phone. That is worth
 * a test even in a repo whose rule is "verify by curling the relay".
 *
 * Everything runs in a temp directory. `pmset` is a stub that keeps its state in a file,
 * the pidfile is repointed out of `/var/run`, and nothing here needs root or touches this
 * machine's power settings.
 *
 * Portable to the ubuntu CI job on purpose: POSIX sh, `ps -o lstart=`, and the stub. The
 * body's real dependency, `pmset`, is exactly what is being faked.
 *
 * Strip-clean (plain-node type-stripping), stdlib-only — see CLAUDE.md.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOSLEEP_BODY, PIDFILE_PATH } from '../src/nosleep-helper.ts'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'check-nosleep-'))
const statePath = path.join(sandbox, 'pmset-state')
const pidfile = path.join(sandbox, 'pid')
const binDir = path.join(sandbox, 'bin')
const ORIGINAL = 'standby=1\npowernap=1\nsleepdisabled=0\n'
const FLIPPED = 'standby=0\npowernap=0\nsleepdisabled=1\n'

fs.mkdirSync(binDir)
fs.writeFileSync(
	path.join(binDir, 'pmset'),
	[
		'#!/bin/sh',
		'. "$PMSET_STATE"',
		'if [ "$1" = -g ] && [ "$2" = custom ]; then',
		'\tprintf \'Battery Power:\\n standby %s\\n powernap %s\\nAC Power:\\n standby 1\\n powernap 1\\n\' "$standby" "$powernap"',
		'\texit 0',
		'fi',
		'if [ "$1" = -g ]; then printf \' SleepDisabled\\t\\t%s\\n\' "$sleepdisabled"; exit 0; fi',
		'shift',
		'while [ $# -gt 0 ]; do',
		'\tcase "$1" in',
		'\t\tstandby) standby=$2; shift 2 ;;',
		'\t\tpowernap) powernap=$2; shift 2 ;;',
		'\t\tdisablesleep) sleepdisabled=$2; shift 2 ;;',
		'\t\t*) shift ;;',
		'\tesac',
		'done',
		'printf \'standby=%s\\npowernap=%s\\nsleepdisabled=%s\\n\' "$standby" "$powernap" "$sleepdisabled" > "$PMSET_STATE"',
		''
	].join('\n'),
	{ mode: 0o755 }
)

/**
 * The shipped body, with only its pidfile moved somewhere this test may write. Written to
 * a file rather than passed to `sh -c`, because the takeover case has to background a whole
 * armed window and `&` binds to one command — `sh -c "$body" &` backgrounds the body's last
 * line and runs the rest in the foreground, which quietly tests nothing.
 */
const helperPath = path.join(sandbox, 'helper')
fs.writeFileSync(helperPath, `#!/bin/sh\n${NOSLEEP_BODY.replace(PIDFILE_PATH, pidfile)}\n`, { mode: 0o755 })
const env = { ...process.env, PMSET_STATE: statePath, PATH: `${binDir}:${process.env.PATH ?? ''}` }

function reset(): void {
	fs.writeFileSync(statePath, ORIGINAL)
	fs.rmSync(pidfile, { force: true })
}

function state(): string {
	return fs.readFileSync(statePath, 'utf8')
}

/** Run the body to completion and hand back its exit code plus stderr. */
function run(...args: string[]): { code: number; stdout: string; stderr: string } {
	const res = spawnSync('sh', [helperPath, ...args], { env, encoding: 'utf8', timeout: 60_000 })
	return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** `ps` start time with the spaces squeezed out — the identity token the body writes. */
function startToken(pid: number): string {
	return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).replace(/[\s]/g, '')
}

const failures: string[] = []
function check(name: string, ok: boolean, detail: string): void {
	if (ok) {
		console.info(`  ok    ${name}`)
		return
	}
	console.error(`  FAIL  ${name}: ${detail}`)
	failures.push(name)
}

// --- `--check` is the probe helperReady() runs; it must not touch pmset -----------------
reset()
{
	const r = run('--check')
	check(
		'--check answers ok',
		r.code === 0 && r.stdout.trim() === 'ok',
		`exit ${r.code}, stdout ${JSON.stringify(r.stdout)}`
	)
	check('--check leaves power settings alone', state() === ORIGINAL, state())
}

// --- a non-numeric window is refused before anything is flipped ------------------------
reset()
{
	const r = run('90m')
	check('non-digit seconds refused', r.code === 64, `exit ${r.code}`)
	check('refusal leaves power settings alone', state() === ORIGINAL, state())
}

// --- the ordinary window: flip, then restore what was captured -------------------------
reset()
{
	const r = run('1', '1s')
	check('a 1s window exits clean', r.code === 0, `exit ${r.code}, stderr ${r.stderr.trim()}`)
	check('a finished window restores the captured values', state() === ORIGINAL, state())
	check('a finished window clears its pidfile', !fs.existsSync(pidfile), 'pidfile still present')
}

// --- takeover from a live incumbent still restores the ORIGINAL values -----------------
// The regression this guards: a successor that captures while the incumbent is still
// armed reads standby=0/powernap=0/disablesleep=1 and "restores" those on its way out.
reset()
{
	// Orphan the incumbent the way the relay's detached spawn does, so it outlives the
	// shell that started it and is still armed when the successor arrives.
	spawnSync('sh', ['-c', '"$1" 60 1m >/dev/null 2>&1 & sleep 1.5', 'x', helperPath], { env, encoding: 'utf8' })
	check('incumbent armed and flipped the values', state() === FLIPPED, state())
	const incumbentPid = Number(fs.readFileSync(pidfile, 'utf8').trim().split(/\s+/)[0])

	const r = run('1', '1s')
	check('successor arms over the incumbent', r.code === 0, `exit ${r.code}, stderr ${r.stderr.trim()}`)
	check('the incumbent was stopped', !isAlive(incumbentPid), `pid ${incumbentPid} still alive`)
	check('takeover restores the ORIGINAL values, not the flipped ones', state() === ORIGINAL, state())
}

// --- an incumbent that will not stop must refuse the arm, never capture ----------------
// A window killed with SIGKILL leaves the record behind with the values still flipped.
// If the recorded process is alive and ignores SIGTERM, capturing would bake the flipped
// values in permanently. Refusing costs a phone tap; capturing costs a Mac that cannot sleep.
{
	fs.writeFileSync(statePath, FLIPPED)
	const ghost = spawnSync('sh', ['-c', 'sh -c \'trap "" TERM; exec sleep 60\' >/dev/null 2>&1 & echo $!'], {
		encoding: 'utf8'
	})
	const ghostPid = Number(ghost.stdout.trim())
	fs.writeFileSync(pidfile, `${ghostPid} 0 ${startToken(ghostPid)}\n`)

	const r = run('1', '1s')
	check('arm refuses when the armed window will not stop', r.code === 75, `exit ${r.code}`)
	check('refusal did not "restore" the flipped values', state() === FLIPPED, state())
	check('refusal names the reason', /did not stop/.test(r.stderr), JSON.stringify(r.stderr))
	process.kill(ghostPid, 'SIGKILL')
}

// --- a recycled pid is not an armed window --------------------------------------------
// Same stale record, but the process that inherited the pid is a stranger. Matching on the
// pid alone would SIGTERM it (as root, in production) and treat it as the incumbent.
reset()
{
	const ghost = spawnSync('sh', ['-c', 'sh -c \'trap "" TERM; exec sleep 60\' >/dev/null 2>&1 & echo $!'], {
		encoding: 'utf8'
	})
	const ghostPid = Number(ghost.stdout.trim())
	fs.writeFileSync(pidfile, `${ghostPid} 0 NotTheProcessThatWroteThis\n`)

	const r = run('1', '1s')
	check('a recycled pid does not block arming', r.code === 0, `exit ${r.code}, stderr ${r.stderr.trim()}`)
	check('the stranger was not signalled', isAlive(ghostPid), 'the unrelated process was killed')
	check('arming over a stale record still restores cleanly', state() === ORIGINAL, state())
	process.kill(ghostPid, 'SIGKILL')
}

// --- --stop against a live armed window — the phone's "Let it sleep" path ---------------
// The relay TERMs through the helper and then polls the pidfile away. What it is owed is
// the same property as every other exit: the captured values restored, the record cleared.
reset()
{
	spawnSync('sh', ['-c', '"$1" 60 1m >/dev/null 2>&1 & sleep 1.5', 'x', helperPath], { env, encoding: 'utf8' })
	check('window armed before --stop', state() === FLIPPED, state())
	const armedPid = Number(fs.readFileSync(pidfile, 'utf8').trim().split(/\s+/)[0])

	const r = run('--stop')
	check(
		'--stop answers stopped',
		r.code === 0 && r.stdout.trim() === 'stopped',
		`exit ${r.code}, stdout ${JSON.stringify(r.stdout)}`
	)
	// The TERM lands asynchronously — give the window's trap a moment to run its restore.
	const deadline = Date.now() + 5000
	while (isAlive(armedPid) && Date.now() < deadline) spawnSync('sleep', ['0.1'])
	check('--stop stops the armed window', !isAlive(armedPid), `pid ${armedPid} still alive`)
	check('--stop restores the captured values', state() === ORIGINAL, state())
	check('--stop clears the pidfile', !fs.existsSync(pidfile), 'pidfile still present')
}

// --- --stop on a stale record must not signal a stranger either ------------------------
reset()
{
	const ghost = spawnSync('sh', ['-c', 'sh -c \'trap "" TERM; exec sleep 60\' >/dev/null 2>&1 & echo $!'], {
		encoding: 'utf8'
	})
	const ghostPid = Number(ghost.stdout.trim())
	fs.writeFileSync(pidfile, `${ghostPid} 0 NotTheProcessThatWroteThis\n`)

	const r = run('--stop')
	check('--stop reports idle for a stale record', r.stdout.trim() === 'idle', JSON.stringify(r.stdout))
	check('--stop did not signal the stranger', isAlive(ghostPid), 'the unrelated process was killed')
	process.kill(ghostPid, 'SIGKILL')
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length) {
	console.error(`\nnosleep: ${failures.length} check(s) failed — ${failures.join(', ')}`)
	process.exit(1)
}
console.info('nosleep: shell body ok')
