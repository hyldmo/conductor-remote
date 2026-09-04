import type { OrchestrationDb, ProcessIdentity, ProcessProbe, RelayIdentity, UiLeaseOwner } from './orchestration-db.ts'
import {
	processIdentityAlive,
	type RecordedProcessGroup,
	type TerminateRecordedProcessGroupOptions,
	terminateRecordedProcessGroup
} from './relay-processes.ts'

const DEFAULT_SETTLE_MS = 750
const DEFAULT_RECOVERY_LEASE_MS = 10_000

export type UiLeaseWatchdogResult =
	| { status: 'idle' | 'not_expired' }
	| { status: 'owner_alive'; owner: UiLeaseOwner }
	| { status: 'external_process_alive'; owner: UiLeaseOwner }
	| { status: 'owned_external_terminated'; owner: UiLeaseOwner }
	| { status: 'changed'; owner: UiLeaseOwner }
	| { status: 'reclaimed'; owner: UiLeaseOwner; quarantined: boolean }

export interface UiLeaseWatchdogOptions {
	now?: () => number
	processProbe?: ProcessProbe
	terminateGroup?: (identity: RecordedProcessGroup, options?: TerminateRecordedProcessGroupOptions) => Promise<boolean>
	terminateOptions?: TerminateRecordedProcessGroupOptions
	settleMs?: number
	recoveryLeaseMs?: number
	sleep?: (ms: number) => Promise<void>
}

function probeAlive(probe: ProcessProbe, identity: ProcessIdentity & { processGroup?: number }): boolean {
	try {
		return probe(identity)
	} catch {
		// A failed inspection cannot prove that a process is gone.
		return true
	}
}

function sameRelay(left: UiLeaseOwner, right: RelayIdentity): boolean {
	return (
		left.instanceId === right.instanceId &&
		left.pid === right.pid &&
		left.processStartedAt === right.processStartedAt &&
		left.protocolVersion === right.protocolVersion
	)
}

function recordedGroup(identity: ProcessIdentity & { processGroup?: number }): RecordedProcessGroup | undefined {
	if (identity.processGroup === undefined) return undefined
	return { pid: identity.pid, processStartedAt: identity.processStartedAt, processGroup: identity.processGroup }
}

/**
 * Recover one expired process-shared UI lease without ever using time as proof
 * that its owner or detached helper is dead.
 *
 * A live owner is never stolen. This relay may terminate its own overdue helper,
 * while a successor may terminate a proven helper only after the relay owner is
 * dead. Reclamation then uses the database CAS path, which creates persistent
 * quarantine for a lease that crossed mayExecute. The temporary recovery lease
 * is intentionally interactive: it performs no UI work, and this lets it clear a
 * stale mutex even when that same crash already created the global quarantine.
 */
export async function recoverExpiredUiLease(
	db: OrchestrationDb,
	relay: RelayIdentity,
	options: UiLeaseWatchdogOptions = {}
): Promise<UiLeaseWatchdogResult> {
	const now = options.now ?? Date.now
	const probe = options.processProbe ?? processIdentityAlive
	const terminate = options.terminateGroup ?? terminateRecordedProcessGroup
	const pause = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
	const settleMs = Math.max(0, Math.floor(options.settleMs ?? DEFAULT_SETTLE_MS))
	const recoveryLeaseMs = Math.max(1_000, Math.floor(options.recoveryLeaseMs ?? DEFAULT_RECOVERY_LEASE_MS))

	const observed = db.getUiLeaseOwner()
	if (!observed) return { status: 'idle' }
	if (observed.deadlineAt > now()) return { status: 'not_expired' }

	const ownerAlive = probeAlive(probe, observed)
	const ownedHere = sameRelay(observed, relay)
	if (ownerAlive && !ownedHere) return { status: 'owner_alive', owner: observed }

	let terminatedExternal = false
	if (observed.externalProcess && probeAlive(probe, observed.externalProcess)) {
		const group = recordedGroup(observed.externalProcess)
		if (!group || !(await terminate(group, options.terminateOptions))) {
			return { status: 'external_process_alive', owner: observed }
		}
		terminatedExternal = true
	}

	// The live owning relay will observe its helper's exit, reconcile the effect,
	// and release its own nonce. A watchdog must never steal even from itself.
	if (ownerAlive) {
		if (terminatedExternal && settleMs > 0) await pause(settleMs)
		return terminatedExternal
			? { status: 'owned_external_terminated', owner: observed }
			: { status: 'owner_alive', owner: observed }
	}

	// An external action can outlive its wrapper by a short interval. Delay the
	// receipt decision, but retain the old mutex throughout this window.
	if (observed.mayExecute && settleMs > 0) await pause(settleMs)

	const acquired = db.acquireUiLease({
		owner: relay,
		actionId: `ui-recovery:${observed.nonce}`,
		deadlineAt: now() + recoveryLeaseMs,
		priority: 'interactive'
	})
	if (acquired.status !== 'acquired') {
		return { status: 'changed', owner: observed }
	}
	try {
		const quarantine = db.getUiQuarantine()
		return {
			status: 'reclaimed',
			owner: observed,
			quarantined:
				quarantine.active &&
				(quarantine.actionId === observed.actionId ||
					(observed.effectId !== undefined && quarantine.effectId === observed.effectId))
		}
	} finally {
		db.releaseUiLease(acquired.lease)
	}
}
