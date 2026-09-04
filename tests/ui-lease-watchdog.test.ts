import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ORCHESTRATION_PROTOCOL_VERSION, OrchestrationDb, type RelayIdentity } from '../src/orchestration-db.ts'
import { currentProcessStartIdentity, processIdentityAlive } from '../src/relay-processes.ts'
import { recoverExpiredUiLease } from '../src/ui-lease-watchdog.ts'

const directories = new Set<string>()
const processGroups = new Set<number>()

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

function databaseFile(): string {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-ui-watchdog-'))
	directories.add(directory)
	return join(directory, 'orchestration.db')
}

function relay(instanceId: string, pid: number, processStartedAt = `start-${pid}`): RelayIdentity {
	return { instanceId, pid, processStartedAt, protocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
}

function detachedGroup(): { pid: number; processStartedAt: string; processGroup: number } {
	const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: 'ignore'
	})
	if (!child.pid) throw new Error('test process group exposed no PID')
	processGroups.add(child.pid)
	const identity = {
		pid: child.pid,
		processStartedAt: currentProcessStartIdentity(child.pid),
		processGroup: child.pid
	}
	child.unref()
	return identity
}

describe('expired shared UI lease watchdog', () => {
	test('never steals from or terminates work owned by another live relay', async () => {
		const liveOwner = relay('live-owner', 91_001)
		const contender = relay('contender', 91_002)
		const external = { pid: 91_003, processStartedAt: 'external-live', processGroup: 91_003 }
		const alive = new Set([liveOwner.pid, contender.pid, external.pid])
		const probe = ({ pid }: { pid: number }) => alive.has(pid)
		const db = new OrchestrationDb(databaseFile(), { processProbe: probe })
		db.registerRelayInstance(liveOwner)
		db.registerRelayInstance(contender)
		const acquired = db.acquireUiLease({
			owner: liveOwner,
			actionId: 'live-effect',
			deadlineAt: 1,
			priority: 'background'
		})
		if (acquired.status !== 'acquired') throw new Error('expected live owner to acquire the test lease')
		db.markUiLeaseMayExecute(acquired.lease, external)
		const terminateGroup = vi.fn(async () => true)

		const result = await recoverExpiredUiLease(db, contender, {
			now: () => 2,
			processProbe: probe,
			terminateGroup,
			settleMs: 0
		})

		expect(result).toMatchObject({ status: 'owner_alive', owner: { nonce: acquired.lease.nonce } })
		expect(terminateGroup).not.toHaveBeenCalled()
		expect(db.getUiLeaseOwner()).toMatchObject({ nonce: acquired.lease.nonce, externalProcess: external })
		db.close()
	})

	test('kills a dead owner’s overdue process group, settles, and persists quarantine before reclaim', async () => {
		const owner = relay('dead-owner', 99_999_991)
		const contender = relay('watchdog', process.pid, currentProcessStartIdentity())
		const external = detachedGroup()
		const db = new OrchestrationDb(databaseFile(), { processProbe: processIdentityAlive })
		db.registerRelayInstance(owner)
		db.registerRelayInstance(contender)
		const acquired = db.acquireUiLease({
			owner,
			actionId: 'overdue-effect',
			effectId: 'effect-overdue',
			deadlineAt: 1,
			priority: 'background'
		})
		if (acquired.status !== 'acquired') throw new Error('expected dead owner to acquire the test lease')
		db.markUiLeaseMayExecute(acquired.lease, external)

		const result = await recoverExpiredUiLease(db, contender, {
			now: () => 2,
			settleMs: 1,
			terminateOptions: { termGraceMs: 20, killWaitMs: 2_000, pollIntervalMs: 10 }
		})

		expect(result).toMatchObject({
			status: 'reclaimed',
			quarantined: true,
			owner: { actionId: 'overdue-effect', effectId: 'effect-overdue' }
		})
		expect(processIdentityAlive(external)).toBe(false)
		expect(db.getUiLeaseOwner()).toBeUndefined()
		expect(db.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'overdue-effect',
			effectId: 'effect-overdue'
		})
		processGroups.delete(external.processGroup)
		db.close()
	})
})
