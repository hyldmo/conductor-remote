import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
	currentProcessStartIdentity,
	incompatibleRelayProcesses,
	isUiCapableRelayArgs,
	parseUiCapableRelayProcesses,
	processIdentityAlive,
	terminateRecordedProcessGroup
} from '../../src/host/relay-processes.ts'

const processGroups = new Set<number>()
const directories = new Set<string>()

afterEach(() => {
	for (const processGroup of processGroups) {
		try {
			process.kill(-processGroup, 'SIGKILL')
		} catch (error) {
			if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error
		}
	}
	processGroups.clear()
	for (const directory of directories) rmSync(directory, { force: true, recursive: true })
	directories.clear()
})

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(message)
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

function detachedGroup(script: string, args: readonly string[] = []): { pid: number; processStartedAt: string } {
	const child = spawn(process.execPath, ['-e', script, ...args], {
		detached: true,
		stdio: 'ignore'
	})
	if (!child.pid) throw new Error('test process group exposed no leader PID')
	const pid = child.pid
	processGroups.add(pid)
	const processStartedAt = currentProcessStartIdentity(pid)
	child.unref()
	return { pid, processStartedAt }
}

describe('relay process detection', () => {
	test('recognizes installed and development UI-driving relays', () => {
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node /opt/lib/node_modules/conductor-remote/bin/cli.js')).toBe(true)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node --watch /tmp/repo/bin/cli.js')).toBe(true)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node /tmp/repo/src/server.ts')).toBe(true)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node --watch bin/cli.js')).toBe(true)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node src/server.ts')).toBe(true)
	})

	test('does not mistake MCP proxies or utility commands for UI owners', () => {
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node /opt/lib/node_modules/conductor-remote/bin/cli.js mcp')).toBe(
			false
		)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node /opt/conductor-remote/bin/cli.js service status')).toBe(false)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node bin/cli.js mcp')).toBe(false)
		expect(isUiCapableRelayArgs('/opt/homebrew/bin/node bin/cli.js service status')).toBe(false)
		expect(isUiCapableRelayArgs('/bin/zsh -c conductor-remote')).toBe(false)
	})

	test('retains process start identity and excludes this process', () => {
		const output = [
			' 101 Thu Sep  4 10:01:02 2026 /opt/homebrew/bin/node /opt/conductor-remote/bin/cli.js',
			' 102 Thu Sep  4 10:01:03 2026 /opt/homebrew/bin/node /opt/conductor-remote/bin/cli.js mcp',
			' 103 Thu Sep  4 10:01:04 2026 /opt/homebrew/bin/node --watch /tmp/repo/bin/cli.js'
		].join('\n')
		expect(parseUiCapableRelayProcesses(output, 103)).toEqual([
			{
				pid: 101,
				processStartIdentity: 'Thu Sep 4 10:01:02 2026',
				args: '/opt/homebrew/bin/node /opt/conductor-remote/bin/cli.js'
			}
		])
	})

	test('blocks unregistered, reused-PID, and old-protocol relay processes', () => {
		const processes = parseUiCapableRelayProcesses(
			[
				' 101 Thu Sep  4 10:01:02 2026 /opt/homebrew/bin/node /opt/conductor-remote/bin/cli.js',
				' 103 Thu Sep  4 10:01:04 2026 /opt/homebrew/bin/node --watch /tmp/repo/bin/cli.js'
			].join('\n'),
			999
		)
		const compatible = {
			pid: 101,
			processStartedAt: 'Thu Sep 4 10:01:02 2026',
			protocolVersion: 1,
			canDriveUi: true
		}
		expect(incompatibleRelayProcesses(processes, [compatible], 1).map(process => process.pid)).toEqual([103])
		expect(incompatibleRelayProcesses(processes, [{ ...compatible, protocolVersion: 0 }], 1).map(p => p.pid)).toEqual([
			101, 103
		])
		expect(
			incompatibleRelayProcesses(processes, [{ ...compatible, processStartedAt: 'Thu Sep 4 09:00:00 2026' }], 1).map(
				p => p.pid
			)
		).toEqual([101, 103])
	})
})

describe('recorded process-group recovery', () => {
	test('keeps an identity alive while a descendant remains in its recorded group', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-process-group-'))
		directories.add(directory)
		const marker = join(directory, 'child-pid')
		const release = join(directory, 'release-leader')
		const leader = detachedGroup(
			`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const marker = process.argv[1];
const release = process.argv[2];
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(marker, String(child.pid));
const timer = setInterval(() => {
  if (fs.existsSync(release)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 5);
`,
			[marker, release]
		)
		await waitFor(() => existsSync(marker), 'group child was not created')
		const childPid = Number(readFileSync(marker, 'utf8'))
		expect(Number.isSafeInteger(childPid)).toBe(true)
		writeFileSync(release, '')
		await waitFor(() => !processIdentityAlive(leader), 'recorded process-group leader did not exit')

		expect(processIdentityAlive({ ...leader, processGroup: leader.pid })).toBe(true)
	})

	test('never signals a group when the recorded leader start identity does not match', async () => {
		const leader = detachedGroup(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`)
		const provenDead = await terminateRecordedProcessGroup(
			{ ...leader, processStartedAt: `${leader.processStartedAt} reused`, processGroup: leader.pid },
			{ termGraceMs: 20, killWaitMs: 100, pollIntervalMs: 5 }
		)

		expect(provenDead).toBe(false)
		expect(processIdentityAlive({ ...leader, processGroup: leader.pid })).toBe(true)
	})

	test('does not report success when the exact leader is outside the recorded group', async () => {
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
		if (!child.pid) throw new Error('test process exposed no PID')
		const processStartedAt = currentProcessStartIdentity(child.pid)
		try {
			const provenDead = await terminateRecordedProcessGroup(
				{ pid: child.pid, processStartedAt, processGroup: child.pid },
				{ termGraceMs: 20, killWaitMs: 100, pollIntervalMs: 5 }
			)

			expect(provenDead).toBe(false)
			expect(processIdentityAlive({ pid: child.pid, processStartedAt })).toBe(true)
		} finally {
			child.kill('SIGKILL')
		}
	})

	test('terminates a proven recorded group and waits until every member is dead', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-process-group-'))
		directories.add(directory)
		const marker = join(directory, 'child-pid')
		const leader = detachedGroup(
			`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  stdio: 'ignore'
});
fs.writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);
`,
			[marker]
		)
		await waitFor(() => existsSync(marker), 'SIGTERM-resistant group child was not created')

		const provenDead = await terminateRecordedProcessGroup(
			{ ...leader, processGroup: leader.pid },
			{ termGraceMs: 30, killWaitMs: 2_000, pollIntervalMs: 10 }
		)

		expect(provenDead).toBe(true)
		expect(processIdentityAlive({ ...leader, processGroup: leader.pid })).toBe(false)
		processGroups.delete(leader.pid)
	})
})
