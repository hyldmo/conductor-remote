import { describe, expect, test } from 'vitest'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { databaseFile, relay, startExisting } from './fixtures.ts'

describe('OrchestrationDb relay ownership and global UI mutex', () => {
	test('keeps a shared lease gated until its caller persists the external process identity', async () => {
		const owner = relay('shared-provider', 490)
		let externalAlive = true
		const db = new OrchestrationDb(databaseFile(), {
			processProbe: identity => (identity.pid === 492 ? externalAlive : true)
		})
		db.registerRelayInstance(owner)
		const provider = db.createSharedUiLeaseProvider(owner, { leaseMs: 5_000 })

		const lease = await provider.acquire({ priority: 'background', actionId: 'gated-wrapper' })
		expect(db.getUiLeaseOwner()).toMatchObject({ actionId: 'gated-wrapper', mayExecute: false })
		await lease.markMayExecute({ pid: 491, processStartedAt: 'wrapper-start', processGroup: 491 })
		expect(db.getUiLeaseOwner()).toMatchObject({
			actionId: 'gated-wrapper',
			mayExecute: true,
			externalProcess: { pid: 491, processStartedAt: 'wrapper-start', processGroup: 491 }
		})
		await lease.markMayExecute({ pid: 492, processStartedAt: 'wrapper-without-group' })
		expect(db.getUiLeaseOwner()?.externalProcess).toEqual({
			pid: 492,
			processStartedAt: 'wrapper-without-group'
		})
		expect(() => lease.release()).toThrow('external process is still live')
		expect(db.getUiLeaseOwner()).toMatchObject({ actionId: 'gated-wrapper', mayExecute: true })
		externalAlive = false
		await lease.release()
		expect(db.getUiLeaseOwner()).toBeUndefined()
		db.close()
	})

	test('does not steal a live paused owner and checks nonce plus process-start identity on release', () => {
		const file = databaseFile()
		const alive = new Set(['501:start-501', '502:start-502'])
		const processProbe = ({ pid, processStartedAt }: { pid: number; processStartedAt: string }) =>
			alive.has(`${pid}:${processStartedAt}`)
		const db1 = new OrchestrationDb(file, { processProbe })
		const db2 = new OrchestrationDb(file, { processProbe })
		const owner = relay('relay-owner', 501)
		const contender = relay('relay-contender', 502)
		expect(() =>
			db1.acquireUiLease({
				owner,
				actionId: 'unregistered',
				deadlineAt: 1,
				priority: 'background'
			})
		).toThrow('not registered')
		db1.registerRelayInstance(owner)
		db2.registerRelayInstance(contender)

		const acquired = db1.acquireUiLease({
			owner,
			actionId: 'ordinary-send:1',
			deadlineAt: 1,
			priority: 'background',
			nonce: 'owner-nonce'
		})
		expect(acquired.status).toBe('acquired')
		const busy = db2.acquireUiLease({
			owner: contender,
			actionId: 'ordinary-send:2',
			deadlineAt: 2,
			priority: 'interactive'
		})
		expect(busy).toMatchObject({ status: 'busy', reason: 'owner_alive' })

		if (acquired.status !== 'acquired') throw new Error('expected lease')
		expect(db1.releaseUiLease({ ...acquired.lease, nonce: 'wrong-nonce' })).toBe(false)
		expect(db1.getUiLeaseOwner()?.nonce).toBe('owner-nonce')

		// A reused PID with a different start identity does not keep the old lease alive.
		alive.delete('501:start-501')
		alive.add('501:reused-start')
		const reclaimed = db2.acquireUiLease({
			owner: contender,
			actionId: 'ordinary-send:2',
			deadlineAt: 3,
			priority: 'interactive',
			nonce: 'contender-nonce'
		})
		expect(reclaimed).toMatchObject({
			status: 'acquired',
			reclaimed: { instanceId: 'relay-owner', processStartedAt: 'start-501', nonce: 'owner-nonce' }
		})
		if (reclaimed.status !== 'acquired') throw new Error('expected reclaimed lease')
		expect(db1.releaseUiLease(acquired.lease)).toBe(false)
		expect(db2.releaseUiLease(reclaimed.lease)).toBe(true)
		db1.close()
		db2.close()
	})

	test('waits for a live external process, then persistently quarantines potentially emitted work', () => {
		const file = databaseFile()
		const alive = new Set(['601:start-601', '602:start-602', '701:external-701'])
		let groupChildAlive = true
		const processProbe = ({
			pid,
			processStartedAt,
			processGroup
		}: {
			pid: number
			processStartedAt: string
			processGroup?: number
		}) => alive.has(`${pid}:${processStartedAt}`) || (processGroup === 701 && groupChildAlive)
		const owner = relay('relay-owner', 601)
		const contender = relay('relay-contender', 602)
		const db1 = new OrchestrationDb(file, { processProbe })
		const db2 = new OrchestrationDb(file, { processProbe })
		const run = startExisting(db1).run
		db1.registerRelayInstance(owner)
		db2.registerRelayInstance(contender)
		const acquired = db1.acquireUiLease({
			owner,
			actionId: 'open-child',
			effectId: 'effect-1',
			deadlineAt: 10,
			priority: 'background'
		})
		if (acquired.status !== 'acquired') throw new Error('expected lease')
		expect(
			db1.markUiLeaseMayExecute(acquired.lease, {
				pid: 701,
				processStartedAt: 'external-701',
				processGroup: 701
			})
		).toBe(true)
		alive.delete('601:start-601')

		expect(
			db2.acquireUiLease({
				owner: contender,
				actionId: 'next-effect',
				deadlineAt: 20,
				priority: 'background'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })

		alive.delete('701:external-701')
		expect(
			db2.acquireUiLease({
				owner: contender,
				actionId: 'next-effect',
				deadlineAt: 20,
				priority: 'background'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })
		groupChildAlive = false
		const held = db2.acquireUiLease({
			owner: contender,
			actionId: 'next-effect',
			deadlineAt: 20,
			priority: 'background'
		})
		expect(held).toMatchObject({
			status: 'quarantined',
			quarantine: { active: true, actionId: 'open-child', effectId: 'effect-1' }
		})
		db2.cancelWorkflowRun(run.id, 'cancel-does-not-clear-quarantine')
		expect(db2.getUiQuarantine()).toMatchObject({ active: true, actionId: 'open-child' })
		db1.close()
		db2.close()

		const restarted = new OrchestrationDb(file, { processProbe })
		expect(restarted.getUiQuarantine()).toMatchObject({ active: true, actionId: 'open-child' })
		const interactive = restarted.acquireUiLease({
			owner: contender,
			actionId: 'phone-recovery',
			deadlineAt: 30,
			priority: 'interactive'
		})
		expect(interactive.status).toBe('acquired')
		if (interactive.status !== 'acquired') throw new Error('expected phone recovery lease')
		expect(restarted.releaseUiLease(interactive.lease)).toBe(true)
		expect(restarted.clearUiQuarantine('phone-client-id')).toBe(true)
		expect(restarted.getUiQuarantine().active).toBe(false)
		restarted.close()
	})

	test('restarts acquisition when the owner persists an external process during the liveness probe', () => {
		const file = databaseFile()
		const owner = relay('lease-race-owner', 750)
		const contender = relay('lease-race-contender', 751)
		let externalAlive = true
		const ownerDb = new OrchestrationDb(file, {
			processProbe: identity => identity.pid !== 752 || externalAlive
		})
		ownerDb.registerRelayInstance(owner)
		ownerDb.registerRelayInstance(contender)
		const acquired = ownerDb.acquireUiLease({
			owner,
			actionId: 'race-effect',
			effectId: 'race-effect-id',
			deadlineAt: 1,
			priority: 'background',
			nonce: 'race-owner-nonce'
		})
		if (acquired.status !== 'acquired') throw new Error('expected owner lease')

		let injected = false
		const contenderDb = new OrchestrationDb(file, {
			processProbe: identity => {
				if (identity.pid === owner.pid && !injected) {
					injected = true
					expect(
						ownerDb.markUiLeaseMayExecute(acquired.lease, {
							pid: 752,
							processStartedAt: 'external-during-probe',
							processGroup: 752
						})
					).toBe(true)
					return false
				}
				return identity.pid === 752
			}
		})
		expect(
			contenderDb.acquireUiLease({
				owner: contender,
				actionId: 'interactive-recovery',
				deadlineAt: 2,
				priority: 'interactive'
			})
		).toMatchObject({ status: 'busy', reason: 'changed' })
		expect(
			contenderDb.acquireUiLease({
				owner: contender,
				actionId: 'interactive-recovery',
				deadlineAt: 3,
				priority: 'interactive'
			})
		).toMatchObject({ status: 'busy', reason: 'external_process_alive' })
		externalAlive = false
		expect(ownerDb.releaseUiLease(acquired.lease)).toBe(true)
		ownerDb.close()
		contenderDb.close()
	})

	test('reports only live, UI-capable registrations on another protocol as incompatible', () => {
		const alive = new Set(['801:start-801', '802:start-802', '803:start-803'])
		const db = new OrchestrationDb(databaseFile(), {
			processProbe: process => alive.has(`${process.pid}:${process.processStartedAt}`)
		})
		const current = relay('current', 801)
		db.registerRelayInstance(current)
		db.registerRelayInstance({ ...relay('old-live', 802), protocolVersion: 0 })
		db.registerRelayInstance({ ...relay('old-read-only', 803), protocolVersion: 0, canDriveUi: false })
		db.registerRelayInstance(relay('same-protocol', 804))

		expect(db.findIncompatibleRelayInstances(current).map(instance => instance.instanceId)).toEqual(['old-live'])
		alive.delete('802:start-802')
		expect(db.findIncompatibleRelayInstances(current)).toEqual([])
		db.close()
	})
})
