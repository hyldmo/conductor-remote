import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { preventScreenLockEnabled } from '../../src/config.ts'
import { CAFFEINATE_PATH, NOSLEEP_BODY, PIDFILE_PATH } from '../../src/host/nosleep-helper.ts'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'check-nosleep-'))
const statePath = path.join(sandbox, 'pmset-state')
const pidfile = path.join(sandbox, 'pid')
const binDirectory = path.join(sandbox, 'bin')
const caffeinatePath = path.join(binDirectory, 'caffeinate')
const caffeinateLog = path.join(sandbox, 'caffeinate-log')
const originalState = 'standby=1\npowernap=1\nsleepdisabled=0\n'
const flippedState = 'standby=0\npowernap=0\nsleepdisabled=1\n'
const spawnedPids = new Set<number>()

fs.mkdirSync(binDirectory)
fs.writeFileSync(
	path.join(binDirectory, 'pmset'),
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
fs.writeFileSync(
	caffeinatePath,
	[
		'#!/bin/sh',
		'printf \'start %s\\n\' "$*" >> "$CAFFEINATE_LOG"',
		`trap 'echo stop >> "$CAFFEINATE_LOG"; exit 0' TERM INT HUP`,
		'while :; do sleep 0.1; done',
		''
	].join('\n'),
	{ mode: 0o755 }
)

const helperPath = path.join(sandbox, 'helper')
fs.writeFileSync(
	helperPath,
	`#!/bin/sh\n${NOSLEEP_BODY.replace(PIDFILE_PATH, pidfile).replace(CAFFEINATE_PATH, caffeinatePath)}\n`,
	{ mode: 0o755 }
)

const environment = {
	...process.env,
	PMSET_STATE: statePath,
	CAFFEINATE_LOG: caffeinateLog,
	PATH: `${binDirectory}:${process.env.PATH ?? ''}`
}

function reset(): void {
	fs.writeFileSync(statePath, originalState)
	fs.rmSync(pidfile, { force: true })
	fs.rmSync(caffeinateLog, { force: true })
}

function state(): string {
	return fs.readFileSync(statePath, 'utf8')
}

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
	const result = spawnSync('sh', [helperPath, ...args], { env: environment, encoding: 'utf8', timeout: 60_000 })
	return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function startToken(pid: number): string {
	return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).replace(/[\s]/g, '')
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function ghost(): number {
	const child = spawnSync('sh', ['-c', 'sh -c \'trap "" TERM; exec sleep 60\' >/dev/null 2>&1 & echo $!'], {
		encoding: 'utf8'
	})
	const pid = Number(child.stdout.trim())
	spawnedPids.add(pid)
	return pid
}

function kill(pid: number): void {
	if (isAlive(pid)) process.kill(pid, 'SIGKILL')
	spawnedPids.delete(pid)
}

beforeEach(reset)

afterEach(() => {
	for (const pid of spawnedPids) kill(pid)
})

afterAll(() => {
	fs.rmSync(sandbox, { recursive: true, force: true })
})

describe.sequential('nosleep shell helper', () => {
	test('defaults screen-lock prevention on and accepts the CLI opt-out', () => {
		expect(preventScreenLockEnabled(undefined)).toBe(true)
		expect(preventScreenLockEnabled('off')).toBe(false)
	})

	test('answers its readiness probe without changing power settings', () => {
		const result = run('--check')
		expect(result).toMatchObject({ code: 0, stdout: 'ok\n' })
		expect(state()).toBe(originalState)
	})

	test('rejects a non-numeric window before changing power settings', () => {
		const result = run('90m')
		expect(result.code).toBe(64)
		expect(state()).toBe(originalState)
	})

	test('arms an ordinary window and restores every captured setting', () => {
		const result = run('1', '1s')
		const log = fs.existsSync(caffeinateLog) ? fs.readFileSync(caffeinateLog, 'utf8') : ''
		expect(result.code).toBe(0)
		expect(log).toMatch(/start -d -w \d+/)
		expect(result.stdout).toMatch(/Anyone with physical access/)
		expect(log).toMatch(/stop/)
		expect(state()).toBe(originalState)
		expect(fs.existsSync(pidfile)).toBe(false)
	})

	test('leaves automatic screen locking enabled when explicitly opted out', () => {
		const result = run('1', '1s', '0')
		expect(result.code).toBe(0)
		expect(fs.existsSync(caffeinateLog)).toBe(false)
		expect(result.stdout).toMatch(/remains enabled/)
		expect(state()).toBe(originalState)
	})

	test('rejects unknown screen-lock modes before root actions', () => {
		const result = run('1', '1s', 'maybe')
		expect(result.code).toBe(64)
		expect(state()).toBe(originalState)
		expect(fs.existsSync(caffeinateLog)).toBe(false)
	})

	test('takes over a live window and restores the original values', () => {
		spawnSync('sh', ['-c', '"$1" 60 1m >/dev/null 2>&1 & sleep 1.5', 'x', helperPath], {
			env: environment,
			encoding: 'utf8'
		})
		expect(state()).toBe(flippedState)
		const incumbentPid = Number(fs.readFileSync(pidfile, 'utf8').trim().split(/\s+/)[0])
		spawnedPids.add(incumbentPid)

		const result = run('1', '1s')
		expect(result.code).toBe(0)
		expect(isAlive(incumbentPid)).toBe(false)
		spawnedPids.delete(incumbentPid)
		expect(state()).toBe(originalState)
	})

	test('refuses to capture settings while a recorded process ignores termination', () => {
		fs.writeFileSync(statePath, flippedState)
		const pid = ghost()
		fs.writeFileSync(pidfile, `${pid} 0 ${startToken(pid)}\n`)

		const result = run('1', '1s')
		expect(result.code).toBe(75)
		expect(state()).toBe(flippedState)
		expect(result.stderr).toMatch(/did not stop/)
		kill(pid)
	})

	test('does not signal an unrelated process that reused a stale PID', () => {
		const pid = ghost()
		fs.writeFileSync(pidfile, `${pid} 0 NotTheProcessThatWroteThis\n`)

		const result = run('1', '1s')
		expect(result.code).toBe(0)
		expect(isAlive(pid)).toBe(true)
		expect(state()).toBe(originalState)
		kill(pid)
	})

	test('stops a live window and restores its captured settings', () => {
		spawnSync('sh', ['-c', '"$1" 60 1m >/dev/null 2>&1 & sleep 1.5', 'x', helperPath], {
			env: environment,
			encoding: 'utf8'
		})
		expect(state()).toBe(flippedState)
		const armedPid = Number(fs.readFileSync(pidfile, 'utf8').trim().split(/\s+/)[0])
		spawnedPids.add(armedPid)

		const result = run('--stop')
		expect(result).toMatchObject({ code: 0, stdout: 'stopped\n' })
		const deadline = Date.now() + 5_000
		while (isAlive(armedPid) && Date.now() < deadline) spawnSync('sleep', ['0.1'])
		expect(isAlive(armedPid)).toBe(false)
		spawnedPids.delete(armedPid)
		expect(state()).toBe(originalState)
		expect(fs.existsSync(pidfile)).toBe(false)
	})

	test('reports idle without signalling a stranger from a stale stop record', () => {
		const pid = ghost()
		fs.writeFileSync(pidfile, `${pid} 0 NotTheProcessThatWroteThis\n`)

		const result = run('--stop')
		expect(result.stdout).toBe('idle\n')
		expect(isAlive(pid)).toBe(true)
		kill(pid)
	})
})
