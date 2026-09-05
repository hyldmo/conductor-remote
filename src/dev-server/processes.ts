import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validPort } from './ports.ts'

const exec = promisify(execFile)

export const PORT_SNAPSHOT_TTL_MS = 5000

export function processAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Parse a macOS `ps eww -axo command=` snapshot without ever logging it: process
 * environments can contain credentials. Multiple processes are expected, but
 * conflicting ports for one workspace are not safe to guess through.
 */
export function parseWorkspacePort(snapshot: string, workspaceId: string): number | null {
	const ports = new Set<number>()
	for (const line of snapshot.split('\n')) {
		const id = line.match(/(?:^|\s)CONDUCTOR_WORKSPACE_ID=([^\s]+)/)?.[1]
		if (id !== workspaceId) continue
		const port = Number(line.match(/(?:^|\s)CONDUCTOR_PORT=(\d+)(?:\s|$)/)?.[1])
		if (validPort(port)) ports.add(port)
	}
	return ports.size === 1 ? [...ports][0] : null
}

let portSnapshot: { at: number; text: string } | null = null

let portSnapshotInFlight: Promise<string> | null = null

async function readProcesses(): Promise<string> {
	const { stdout } = await exec('ps', ['eww', '-axo', 'command='], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: 5000
	})
	portSnapshot = { at: Date.now(), text: stdout }
	return stdout
}

/**
 * One `ps` snapshot shared by every workspace. It carries every process
 * environment on the Mac (~650 kB here), and the phone polls this state every
 * 2.5s per open chat, so a read reuses a recent one and simultaneous readers
 * await the same child process. A workspace whose Run task is stopped has no
 * port to remember, which is why the miss path needs this and not just the hit
 * path. A start asks for `maxAgeMs` 0, because the task it just pressed is
 * younger than any cached snapshot.
 */
function processSnapshot(maxAgeMs: number): Promise<string> {
	if (maxAgeMs <= 0) return readProcesses()
	if (portSnapshot && Date.now() - portSnapshot.at <= maxAgeMs) return Promise.resolve(portSnapshot.text)
	portSnapshotInFlight ??= readProcesses().finally(() => {
		portSnapshotInFlight = null
	})
	return portSnapshotInFlight
}

export async function workspacePort(workspaceId: string, maxAgeMs = 0): Promise<number | null> {
	try {
		return parseWorkspacePort(await processSnapshot(maxAgeMs), workspaceId)
	} catch {
		// Never reflect the error: `execFile` includes stdout, which is the process
		// environment snapshot and may contain secrets.
		return null
	}
}
