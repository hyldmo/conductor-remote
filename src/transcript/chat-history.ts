import fs from 'node:fs'
import path from 'node:path'
import type { ChatHistoryLink } from '../wire.ts'

interface StoredLink extends ChatHistoryLink {
	workspaceId: string
}

/** Only the connections live here. Conductor remains the read-only source of messages. */
export class ChatHistoryStore {
	private readonly file: string
	private links: Record<string, StoredLink>

	constructor(file: string) {
		this.file = file
		try {
			const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; links: Record<string, StoredLink> }
			if (saved.version !== 1 || !saved.links || typeof saved.links !== 'object' || Array.isArray(saved.links)) {
				throw new Error('Unsupported chat history file')
			}
			for (const [id, link] of Object.entries(saved.links)) {
				if (
					!id ||
					!link ||
					typeof link.workspaceId !== 'string' ||
					typeof link.previousSessionId !== 'string' ||
					typeof link.title !== 'string' ||
					typeof link.createdAt !== 'string'
				)
					throw new Error('Invalid chat history link')
			}
			this.links = saved.links
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			this.links = {}
		}
	}

	forWorkspace(workspaceId: string): Record<string, ChatHistoryLink> {
		return Object.fromEntries(
			Object.entries(this.links)
				.filter(([, link]) => link.workspaceId === workspaceId)
				.map(([id, { workspaceId: _, ...link }]) => [id, link])
		)
	}

	/** Idempotent: retrying the metadata write must never open another Conductor tab. */
	join(
		workspaceId: string,
		previousSessionId: string,
		sessionId: string,
		source: { title: string | null; created_at: string }
	): void {
		const existing = this.links[sessionId]
		if (existing?.workspaceId === workspaceId && existing.previousSessionId === previousSessionId) return
		if (existing) throw new Error('This chat already belongs to a conversation')
		if (Object.values(this.links).some(link => link.previousSessionId === previousSessionId)) {
			throw new Error('This chat already continues in another tab. Refresh to open the latest conversation.')
		}
		const visited = new Set([sessionId])
		for (let id: string | undefined = previousSessionId; id; id = this.links[id]?.previousSessionId) {
			if (visited.has(id)) throw new Error('Chat history cannot contain a cycle')
			if (this.links[id] && this.links[id].workspaceId !== workspaceId) throw new Error('Chats must share a workspace')
			visited.add(id)
		}
		const previous = this.links[previousSessionId]
		const next = {
			...this.links,
			[sessionId]: {
				workspaceId,
				previousSessionId,
				title: previous?.title ?? source.title ?? '',
				createdAt: previous?.createdAt ?? source.created_at
			}
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		const temporary = `${this.file}.${process.pid}.tmp`
		fs.writeFileSync(temporary, JSON.stringify({ version: 1, links: next }), { mode: 0o600 })
		fs.renameSync(temporary, this.file)
		this.links = next
	}
}
