/**
 * Worktree-scoped delegated-job and session-role persistence.
 *
 * Conductor owns the chat history; these small files hold only active/failed work
 * plus durable role identity. A decoder failure is public state, not permission to
 * delete a file: callers receive warnings and the bytes remain for repair/dismissal.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SessionRoleAssignment } from '../../wire.ts'
import { decodeDelegation, decodeSessionRoles, SAFE_ID, text } from './codec.ts'
import type { DelegationList, PersistedDelegation, SessionRolesRead, StateWarning } from './types.ts'

const DIRECTORY = path.join('.context', 'delegations')

const SESSIONS_FILE = 'sessions.json'

function atomicWrite(file: string, value: unknown): void {
	const temporary = `${file}.${process.pid}.tmp`
	fs.mkdirSync(path.dirname(file), { recursive: true })
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`, { mode: 0o600 })
		fs.chmodSync(temporary, 0o600)
		fs.renameSync(temporary, file)
	} catch (err) {
		try {
			fs.unlinkSync(temporary)
		} catch {}
		throw err
	}
}

export class DelegationStore {
	private readonly directory: string

	constructor(worktree: string) {
		this.directory = path.join(worktree, DIRECTORY)
	}

	list(): DelegationList {
		let files: string[]
		try {
			files = fs
				.readdirSync(this.directory)
				.filter(file => file.endsWith('.json') && file !== SESSIONS_FILE)
				.sort()
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], warnings: [] }
			return { jobs: [], warnings: [{ file: this.directory, message: String(err) }] }
		}
		const jobs: PersistedDelegation[] = []
		const warnings: StateWarning[] = []
		for (const file of files) {
			try {
				jobs.push(decodeDelegation(JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'))))
			} catch (err) {
				warnings.push({ file, message: err instanceof Error ? err.message : String(err) })
			}
		}
		return { jobs, warnings }
	}

	get(id: string): PersistedDelegation | null {
		if (!SAFE_ID.test(id)) return null
		try {
			return decodeDelegation(JSON.parse(fs.readFileSync(path.join(this.directory, `${id}.json`), 'utf8')))
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
	}

	put(raw: PersistedDelegation): PersistedDelegation {
		const job = decodeDelegation(raw)
		atomicWrite(path.join(this.directory, `${job.id}.json`), job)
		return job
	}

	remove(id: string): boolean {
		if (!SAFE_ID.test(id)) return false
		try {
			fs.unlinkSync(path.join(this.directory, `${id}.json`))
			return true
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
			throw err
		}
	}

	sessionRoles(): SessionRolesRead {
		const file = path.join(this.directory, SESSIONS_FILE)
		try {
			return { sessions: decodeSessionRoles(JSON.parse(fs.readFileSync(file, 'utf8'))) }
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} }
			return { sessions: {}, warning: err instanceof Error ? err.message : String(err) }
		}
	}

	assign(sessionId: string, assignment: SessionRoleAssignment): void {
		text(sessionId, 'session id')
		const current = this.sessionRoles()
		if (current.warning) throw new Error(`cannot update malformed sessions.json: ${current.warning}`)
		const sessions = decodeSessionRoles({
			version: 1,
			sessions: { ...current.sessions, [sessionId]: assignment }
		})
		atomicWrite(path.join(this.directory, SESSIONS_FILE), { version: 1, sessions })
	}
}
