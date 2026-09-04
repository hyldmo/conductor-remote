import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RelayUiProcess {
	pid: number
	/** `ps lstart`, retained verbatim so PID reuse cannot impersonate a registration. */
	processStartIdentity: string
	args: string
}

export interface RelayProcessRegistration {
	pid: number
	processStartedAt: string
	protocolVersion: number
	canDriveUi: boolean
}

/**
 * Decide from argv only. Never ask `ps` for the environment: a Conductor child or
 * relay process can carry bearer tokens there.
 */
export function isUiCapableRelayArgs(args: string): boolean {
	const normalized = args.replace(/\s+/g, ' ').trim()
	if (!/(^|\/)node(?:\s|$)/.test(normalized)) return false
	if (/\bconductor-remote(?:\/bin\/cli\.js)?\s+(?:mcp|service|config|logs|nosleep)(?:\s|$)/.test(normalized)) {
		return false
	}
	// `yarn start` and the documented checkout command can leave the script path
	// relative in `ps` (for example `node bin/cli.js`). Treat a whitespace or path
	// separator as the same token boundary. Utility subcommands are excluded first
	// so a relative MCP proxy can never be mistaken for a UI-driving relay.
	if (/(?:^|\s|\/)(?:conductor-remote\/)?bin\/cli\.js\s+(?:mcp|service|config|logs|nosleep)(?:\s|$)/.test(normalized)) {
		return false
	}
	if (/(?:^|\s|\/)(?:src\/server\.ts|dist-node\/src\/server\.js)(?:\s|$)/.test(normalized)) return true
	if (/(?:^|\s|\/)(?:conductor-remote\/)?bin\/cli\.js(?:\s+(?:start))?(?:\s|$)/.test(normalized)) return true
	return /\bconductor-remote(?:\s+start)?(?:\s|$)/.test(normalized)
}

/** Parse macOS `ps -axo pid=,lstart=,args=` without depending on locale words. */
export function parseUiCapableRelayProcesses(output: string, ownPid = process.pid): RelayUiProcess[] {
	const found: RelayUiProcess[] = []
	for (const line of output.split('\n')) {
		// macOS lstart is five fields: weekday month day hh:mm:ss year. Capture by
		// fields rather than a byte width so single-digit days and locale spacing work.
		const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === ownPid) continue
		const args = match[3].trim()
		if (!isUiCapableRelayArgs(args)) continue
		found.push({ pid, processStartIdentity: match[2].replace(/\s+/g, ' '), args })
	}
	return found.sort((a, b) => a.pid - b.pid)
}

export async function listUiCapableRelayProcesses(ownPid = process.pid): Promise<RelayUiProcess[]> {
	const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,lstart=,args='], {
		encoding: 'utf8',
		timeout: 6_000,
		maxBuffer: 4 * 1024 * 1024
	})
	return parseUiCapableRelayProcesses(stdout, ownPid)
}

function normalizeStartIdentity(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

interface ProcessTableEntry {
	pid: number
	processGroup: number
	processStartedAt: string
}

const PROCESS_TABLE_ARGS = ['-axo', 'pid=,pgid=,lstart='] as const

function parseProcessTable(output: string): ProcessTableEntry[] {
	const entries: ProcessTableEntry[] = []
	for (const line of output.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		const processGroup = Number(match[2])
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(processGroup) || processGroup <= 0) {
			continue
		}
		entries.push({ pid, processGroup, processStartedAt: normalizeStartIdentity(match[3]) })
	}
	return entries
}

function readProcessTableSync(): ProcessTableEntry[] | null {
	try {
		const output = execFileSync('/bin/ps', [...PROCESS_TABLE_ARGS], {
			encoding: 'utf8',
			timeout: 2_000,
			maxBuffer: 4 * 1024 * 1024
		})
		return parseProcessTable(output)
	} catch {
		return null
	}
}

async function readProcessTable(): Promise<ProcessTableEntry[] | null> {
	try {
		const { stdout } = await execFileAsync('/bin/ps', [...PROCESS_TABLE_ARGS], {
			encoding: 'utf8',
			timeout: 2_000,
			maxBuffer: 4 * 1024 * 1024
		})
		return parseProcessTable(stdout)
	} catch {
		return null
	}
}

function exactLeader(entries: readonly ProcessTableEntry[], identity: ProcessIdentity): ProcessTableEntry | undefined {
	const expectedStart = normalizeStartIdentity(identity.processStartedAt)
	return entries.find(
		entry => entry.pid === identity.pid && normalizeStartIdentity(entry.processStartedAt) === expectedStart
	)
}

function validProcessGroup(processGroup: number): boolean {
	return Number.isSafeInteger(processGroup) && processGroup > 1
}

function groupAlive(entries: readonly ProcessTableEntry[], processGroup: number): boolean {
	return entries.some(entry => entry.processGroup === processGroup)
}

function sameProcess(left: ProcessTableEntry, right: ProcessTableEntry): boolean {
	return left.pid === right.pid && left.processStartedAt === right.processStartedAt
}

export interface ProcessIdentity {
	pid: number
	processStartedAt: string
	processGroup?: number
}

/**
 * Exact PID + process-start check, extended for a recorded detached wrapper.
 * A dead/reused leader is still conservatively alive while any member retains
 * its process group. Failure to read the process table also fails closed.
 */
export function processIdentityAlive(identity: ProcessIdentity): boolean {
	const entries = readProcessTableSync()
	if (!entries) return true
	if (exactLeader(entries, identity)) return true
	if (identity.processGroup === undefined) return false
	if (!validProcessGroup(identity.processGroup)) return true
	return groupAlive(entries, identity.processGroup)
}

export interface TerminateRecordedProcessGroupOptions {
	/** Time allowed for the group to exit after SIGTERM. */
	termGraceMs?: number
	/** Time allowed to prove the group empty after SIGKILL. */
	killWaitMs?: number
	pollIntervalMs?: number
}

export interface RecordedProcessGroup {
	pid: number
	processStartedAt: string
	processGroup: number
}

function duration(value: number | undefined, fallback: number, minimum: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.floor(value))
}

async function waitForGroupDeath(processGroup: number, waitMs: number, pollIntervalMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs
	for (;;) {
		const entries = await readProcessTable()
		if (!entries) return false
		if (!groupAlive(entries, processGroup)) return true
		const remaining = deadline - Date.now()
		if (remaining <= 0) return false
		await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
	}
}

function signalGroup(processGroup: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-processGroup, signal)
		return true
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true
		return false
	}
}

/**
 * Terminate a detached wrapper's process group without risking a reused PGID.
 *
 * The recorded leader must still have the exact PID/start identity, must still
 * lead the recorded group, and must not be this relay. Only then is SIGTERM sent.
 * SIGKILL follows when descendants survive the grace period, unless a reused
 * leader is observed. `true` means a later process-table snapshot proved that no
 * member of the recorded group remains; every inspection failure returns false.
 */
export async function terminateRecordedProcessGroup(
	identity: RecordedProcessGroup,
	options: TerminateRecordedProcessGroupOptions = {}
): Promise<boolean> {
	if (
		!Number.isSafeInteger(identity.pid) ||
		identity.pid <= 1 ||
		identity.pid === process.pid ||
		!validProcessGroup(identity.processGroup) ||
		identity.processGroup !== identity.pid ||
		!normalizeStartIdentity(identity.processStartedAt)
	) {
		return false
	}
	const termGraceMs = duration(options.termGraceMs, 500, 0)
	const killWaitMs = duration(options.killWaitMs, 2_000, 0)
	const pollIntervalMs = duration(options.pollIntervalMs, 25, 1)
	const initial = await readProcessTable()
	if (!initial) return false
	const leader = exactLeader(initial, identity)
	if (!leader) return !groupAlive(initial, identity.processGroup)
	if (leader.processGroup !== identity.processGroup) return false
	const initialMembers = initial.filter(entry => entry.processGroup === identity.processGroup)
	if (!signalGroup(identity.processGroup, 'SIGTERM')) return false
	if (await waitForGroupDeath(identity.processGroup, termGraceMs, pollIntervalMs)) return true

	const beforeKill = await readProcessTable()
	if (!beforeKill) return false
	if (!groupAlive(beforeKill, identity.processGroup)) return true
	const currentLeader = beforeKill.find(entry => entry.pid === identity.pid)
	if (
		currentLeader &&
		(normalizeStartIdentity(currentLeader.processStartedAt) !== normalizeStartIdentity(identity.processStartedAt) ||
			currentLeader.processGroup !== identity.processGroup)
	) {
		return false
	}
	const survivingMembers = beforeKill.filter(entry => entry.processGroup === identity.processGroup)
	if (!survivingMembers.some(current => initialMembers.some(initialMember => sameProcess(current, initialMember)))) {
		return false
	}
	if (!signalGroup(identity.processGroup, 'SIGKILL')) return false
	return waitForGroupDeath(identity.processGroup, killWaitMs, pollIntervalMs)
}

export function currentProcessStartIdentity(pid = process.pid): string {
	const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
		encoding: 'utf8',
		timeout: 2_000,
		maxBuffer: 64 * 1024
	})
	const identity = normalizeStartIdentity(output)
	if (!identity) throw new Error(`could not read process start identity for PID ${pid}`)
	return identity
}

/** A live UI-capable process must have a matching registration at this protocol. */
export function incompatibleRelayProcesses(
	processes: readonly RelayUiProcess[],
	registrations: readonly RelayProcessRegistration[],
	protocolVersion: number
): RelayUiProcess[] {
	return processes.filter(candidate => {
		const registration = registrations.find(
			entry =>
				entry.canDriveUi &&
				entry.pid === candidate.pid &&
				normalizeStartIdentity(entry.processStartedAt) === normalizeStartIdentity(candidate.processStartIdentity)
		)
		return !registration || registration.protocolVersion !== protocolVersion
	})
}
