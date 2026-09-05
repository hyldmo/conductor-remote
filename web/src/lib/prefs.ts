/**
 * Local-first half of preference sync.
 *
 * The old localStorage keys remain mirrored so a service-worker-cached older build can
 * still read them while the relay updates underneath it. A separate metadata document
 * carries revision timestamps and deletion tombstones for the host merge.
 */
import { isAgentEffort } from '../../../src/shared.ts'
import { AGENT_DRAFT_PREFIX } from './prompts/agent-draft.ts'
import { DRAFT_PREFIX, legacyForkContent } from './prompts/draft.ts'
import { READ_MARKS_KEY, type ReadMarks } from './read.ts'
import type { AgentPatch, DraftAttachment, Prefs, SyncedDraft } from './types.ts'

const META_KEY = 'conductor-remote-prefs-v1'

interface StorageLike {
	readonly length: number
	key(index: number): string | null
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

export interface LocalPrefsProjection {
	drafts: Record<string, string>
	agentDrafts: Record<string, AgentPatch>
	draftAttachments: Record<string, DraftAttachment[]>
	readMarks: ReadMarks
}

export interface MergeResult {
	state: LocalPrefsProjection
	/** The local side won at least one key and should be patched back to the host. */
	needsUpload: boolean
}

function object(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function cleanAgent(raw: unknown): AgentPatch {
	const value = object(raw)
	if (!value) return {}
	const agent: AgentPatch = {}
	if (typeof value.auto === 'boolean') agent.auto = value.auto
	if (typeof value.model === 'string') agent.model = value.model
	if (isAgentEffort(value.effort)) agent.effort = value.effort
	if (typeof value.plan === 'boolean') agent.plan = value.plan
	if (typeof value.fast === 'boolean') agent.fast = value.fast
	return agent
}

function hasAgent(agent: AgentPatch): boolean {
	return Object.keys(agent).length > 0
}

function cleanAttachment(raw: unknown): DraftAttachment | null {
	const value = object(raw)
	if (!value) return null
	if (
		typeof value.name !== 'string' ||
		typeof value.path !== 'string' ||
		typeof value.token !== 'string' ||
		!Number.isSafeInteger(Number(value.bytes)) ||
		Number(value.bytes) < 0
	)
		return null
	if (value.stageId !== undefined && typeof value.stageId !== 'string') return null
	return {
		name: value.name,
		path: value.path,
		bytes: Number(value.bytes),
		token: value.token,
		...(value.source === 'fork' ? { source: 'fork' as const } : {}),
		...(value.stageId ? { stageId: value.stageId } : {})
	}
}

function cleanAttachments(raw: unknown): DraftAttachment[] {
	if (!Array.isArray(raw)) return []
	const seen = new Set<string>()
	return raw.flatMap(candidate => {
		const attachment = cleanAttachment(candidate)
		if (!attachment || seen.has(attachment.path)) return []
		seen.add(attachment.path)
		return [attachment]
	})
}

function cleanDraft(raw: unknown): SyncedDraft | null {
	const value = object(raw)
	if (!value) return null
	const updatedAt = Number(value.updatedAt)
	if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return null
	if (value.deleted === true) return { text: '', agent: {}, attachments: [], updatedAt, deleted: true }
	if (typeof value.text !== 'string') return null
	return {
		text: value.text,
		agent: cleanAgent(value.agent),
		attachments: cleanAttachments(value.attachments),
		updatedAt,
		deleted: false
	}
}

function sameAgent(a: AgentPatch, b: AgentPatch): boolean {
	return a.auto === b.auto && a.model === b.model && a.effort === b.effort && a.plan === b.plan && a.fast === b.fast
}

function sameDraft(a: SyncedDraft, b: SyncedDraft): boolean {
	return (
		a.text === b.text &&
		a.updatedAt === b.updatedAt &&
		a.deleted === b.deleted &&
		sameAgent(a.agent, b.agent) &&
		a.attachments.length === b.attachments.length &&
		a.attachments.every((attachment, index) => {
			const other = b.attachments[index]
			return (
				attachment.name === other?.name &&
				attachment.path === other.path &&
				attachment.bytes === other.bytes &&
				attachment.token === other.token &&
				attachment.source === other.source &&
				attachment.stageId === other.stageId
			)
		})
	)
}

function liveDraft(text: string, agent: AgentPatch, attachments: DraftAttachment[], updatedAt: number): SyncedDraft {
	return text || hasAgent(agent) || attachments.length
		? { text, agent: { ...agent }, attachments: cleanAttachments(attachments), updatedAt, deleted: false }
		: { text: '', agent: {}, attachments: [], updatedAt, deleted: true }
}

/** Injectable local store: the browser uses one singleton, tests use a Map-backed Storage. */
export class LocalPrefs {
	private readonly storage: StorageLike
	private prefs: Prefs
	private clock: number
	private generation = 0
	private readonly touched = new Set<string>()
	private readonly listeners = new Set<(immediate: boolean) => void>()

	constructor(storage: StorageLike) {
		this.storage = storage
		const rawDrafts = this.readRawDrafts()
		const rawAgents = this.readRawAgents()
		const saved = this.readMetadata()
		const savedDrafts = saved?.drafts ?? {}
		this.clock = Math.max(Date.now(), ...Object.values(savedDrafts).map(draft => draft.updatedAt))

		if (!saved) {
			const drafts: Record<string, SyncedDraft> = {}
			for (const id of new Set([...Object.keys(rawDrafts), ...Object.keys(rawAgents)])) {
				drafts[id] = liveDraft(rawDrafts[id] ?? '', rawAgents[id] ?? {}, [], 0)
			}
			this.prefs = { readMarks: this.readRawMarks(), drafts }
		} else {
			const drafts = { ...savedDrafts }
			for (const id of new Set([...Object.keys(savedDrafts), ...Object.keys(rawDrafts), ...Object.keys(rawAgents)])) {
				const raw = liveDraft(rawDrafts[id] ?? '', rawAgents[id] ?? {}, [], savedDrafts[id]?.updatedAt ?? 0)
				const metadata = savedDrafts[id]
				const attachmentOnly =
					metadata &&
					!metadata.deleted &&
					metadata.attachments.length > 0 &&
					!metadata.text &&
					!hasAgent(metadata.agent) &&
					raw.deleted
				// An older cached build only knows the legacy keys. A mismatch is therefore a
				// real local edit (including a send clearing the last value), not stale metadata.
				// Attachment-only drafts are the exception: legacy keys cannot represent them,
				// so their absence is the expected mirror rather than evidence of deletion.
				if (
					!attachmentOnly &&
					(!metadata ||
						metadata.text !== raw.text ||
						metadata.deleted !== raw.deleted ||
						!sameAgent(metadata.agent, raw.agent))
				) {
					drafts[id] = liveDraft(raw.text, raw.agent, [], this.tick())
					this.touched.add(id)
				}
			}
			this.prefs = { readMarks: this.readRawMarks(), drafts }
		}
		this.migrateForkDrafts()
		this.persistAll()
	}

	snapshot(): Prefs {
		return {
			readMarks: { ...this.prefs.readMarks },
			drafts: Object.fromEntries(
				Object.entries(this.prefs.drafts).map(([id, draft]) => [
					id,
					{ ...draft, agent: { ...draft.agent }, attachments: draft.attachments.map(attachment => ({ ...attachment })) }
				])
			)
		}
	}

	project(): LocalPrefsProjection {
		const drafts: Record<string, string> = {}
		const agentDrafts: Record<string, AgentPatch> = {}
		const draftAttachments: Record<string, DraftAttachment[]> = {}
		for (const [id, draft] of Object.entries(this.prefs.drafts)) {
			if (draft.deleted) continue
			drafts[id] = draft.text
			if (hasAgent(draft.agent)) agentDrafts[id] = { ...draft.agent }
			if (draft.attachments.length) {
				draftAttachments[id] = draft.attachments.map(attachment => ({ ...attachment }))
			}
		}
		return { drafts, agentDrafts, draftAttachments, readMarks: { ...this.prefs.readMarks } }
	}

	currentGeneration(): number {
		return this.generation
	}

	setDraft(id: string, text: string, agent: AgentPatch): LocalPrefsProjection {
		this.setLocal(id, text, agent, this.prefs.drafts[id]?.attachments ?? [])
		return this.project()
	}

	setAgent(id: string, agent: AgentPatch, text: string): LocalPrefsProjection {
		this.setLocal(id, text, agent, this.prefs.drafts[id]?.attachments ?? [])
		return this.project()
	}

	setAttachments(id: string, attachments: DraftAttachment[], text: string, agent: AgentPatch): LocalPrefsProjection {
		this.setLocal(id, text, agent, attachments)
		return this.project()
	}

	setContent(id: string, text: string, agent: AgentPatch, attachments: DraftAttachment[]): LocalPrefsProjection {
		this.setLocal(id, text, agent, attachments)
		return this.project()
	}

	moveDraft(fromId: string, toId: string): LocalPrefsProjection {
		const from = this.prefs.drafts[fromId]
		const to = this.prefs.drafts[toId]
		if (!from || from.deleted || fromId === toId || (to && !to.deleted)) return this.project()
		this.prefs.drafts[fromId] = liveDraft('', {}, [], this.tick())
		this.prefs.drafts[toId] = liveDraft(from.text, from.agent, from.attachments, this.tick())
		this.touched.add(fromId)
		this.touched.add(toId)
		this.changed()
		return this.project()
	}

	markRead(sessionId: string, at: string): LocalPrefsProjection {
		if ((this.prefs.readMarks[sessionId] ?? '') >= at) return this.project()
		this.prefs.readMarks[sessionId] = at
		this.changed()
		return this.project()
	}

	/** Merge the host copy without ever replacing a composer the user is actively editing. */
	merge(remoteRaw: Prefs, focusedDraft: string | null): MergeResult {
		const rawRemoteDrafts = object(object(remoteRaw)?.drafts)
		const remote = this.cleanPrefs(remoteRaw)
		// Once a revision has been observed, every later local edit must sort after it
		// even when another device's wall clock is far ahead of this one.
		for (const draft of Object.values(remote.drafts)) this.clock = Math.max(this.clock, draft.updatedAt)
		let changed = false
		let needsUpload = false

		for (const [id, mark] of Object.entries(remote.readMarks)) {
			if ((this.prefs.readMarks[id] ?? '') >= mark) continue
			this.prefs.readMarks[id] = mark
			changed = true
		}
		for (const [id, mark] of Object.entries(this.prefs.readMarks)) {
			if ((remote.readMarks[id] ?? '') < mark) needsUpload = true
		}

		for (const id of new Set([...Object.keys(this.prefs.drafts), ...Object.keys(remote.drafts)])) {
			const local = this.prefs.drafts[id]
			const incoming = remote.drafts[id]
			const rawIncoming = object(rawRemoteDrafts?.[id])
			// During rollout a new PWA can briefly talk to the previous relay build. That
			// relay accepts the extra field but cannot echo it, so absence means “unknown”,
			// not an explicit empty list. A tombstone still clears the whole draft.
			if (local && incoming && !incoming.deleted && rawIncoming && !Object.hasOwn(rawIncoming, 'attachments')) {
				incoming.attachments = local.attachments.map(attachment => ({ ...attachment }))
			}
			if (!local && incoming) {
				this.prefs.drafts[id] = incoming
				changed = true
				continue
			}
			if (local && !incoming) {
				needsUpload = true
				continue
			}
			if (!(local && incoming) || sameDraft(local, incoming)) continue

			const protect =
				focusedDraft === id &&
				(this.touched.has(id) ||
					(!local.deleted && (local.text.length > 0 || hasAgent(local.agent) || local.attachments.length > 0)))
			const incomingWins =
				incoming.updatedAt > local.updatedAt ||
				(incoming.updatedAt === local.updatedAt && (incoming.deleted || !local.deleted))
			if (incomingWins && !protect) {
				this.prefs.drafts[id] = incoming
				changed = true
				continue
			}
			if (incomingWins) {
				// A far-ahead device clock must not defeat a keystroke made after we saw it.
				local.updatedAt = this.tick(incoming.updatedAt)
				changed = true
			}
			needsUpload = true
		}

		if (this.migrateForkDrafts()) {
			changed = true
			needsUpload = true
		}
		if (changed) this.persistAll()
		return { state: this.project(), needsUpload }
	}

	subscribe(listener: (immediate: boolean) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	requestFlush(): void {
		for (const listener of this.listeners) listener(true)
	}

	private setLocal(id: string, text: string, agent: AgentPatch, attachments: DraftAttachment[]): void {
		this.prefs.drafts[id] = liveDraft(text, cleanAgent(agent), attachments, this.tick())
		this.touched.add(id)
		this.changed()
	}

	private migrateForkDrafts(): boolean {
		let changed = false
		for (const [id, draft] of Object.entries(this.prefs.drafts)) {
			if (draft.deleted) continue
			const content = legacyForkContent(draft.text, draft.attachments)
			if (!content) continue
			this.prefs.drafts[id] = { ...draft, ...content, updatedAt: this.tick() }
			changed = true
		}
		return changed
	}

	private changed(): void {
		this.generation += 1
		this.persistAll()
		for (const listener of this.listeners) listener(false)
	}

	private tick(after = 0): number {
		this.clock = Math.max(Date.now(), this.clock + 1, after + 1)
		return this.clock
	}

	private cleanPrefs(raw: Prefs): Prefs {
		const value = object(raw)
		const marks: ReadMarks = {}
		for (const [id, mark] of Object.entries(object(value?.readMarks) ?? {})) {
			if (typeof mark === 'string') marks[id] = mark
		}
		const drafts: Record<string, SyncedDraft> = {}
		for (const [id, candidate] of Object.entries(object(value?.drafts) ?? {})) {
			const draft = cleanDraft(candidate)
			if (draft) drafts[id] = draft
		}
		return { readMarks: marks, drafts }
	}

	private readMetadata(): { drafts: Record<string, SyncedDraft> } | null {
		try {
			const parsed = object(JSON.parse(this.storage.getItem(META_KEY) ?? 'null'))
			if (parsed?.version !== 1) return null
			const drafts: Record<string, SyncedDraft> = {}
			for (const [id, candidate] of Object.entries(object(parsed.drafts) ?? {})) {
				const draft = cleanDraft(candidate)
				if (draft) drafts[id] = draft
			}
			return { drafts }
		} catch {
			return null
		}
	}

	private readRawDrafts(): Record<string, string> {
		const drafts: Record<string, string> = {}
		try {
			for (let i = 0; i < this.storage.length; i++) {
				const key = this.storage.key(i)
				if (!key?.startsWith(DRAFT_PREFIX)) continue
				const value = this.storage.getItem(key)
				if (value) drafts[key.slice(DRAFT_PREFIX.length)] = value
			}
		} catch {}
		return drafts
	}

	private readRawAgents(): Record<string, AgentPatch> {
		const agents: Record<string, AgentPatch> = {}
		try {
			for (let i = 0; i < this.storage.length; i++) {
				const key = this.storage.key(i)
				if (!key?.startsWith(AGENT_DRAFT_PREFIX)) continue
				const raw = this.storage.getItem(key)
				if (!raw) continue
				const agent = cleanAgent(JSON.parse(raw))
				if (hasAgent(agent)) agents[key.slice(AGENT_DRAFT_PREFIX.length)] = agent
			}
		} catch {}
		return agents
	}

	private readRawMarks(): ReadMarks {
		try {
			const value = object(JSON.parse(this.storage.getItem(READ_MARKS_KEY) ?? '{}'))
			if (!value) return {}
			return Object.fromEntries(
				Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
			)
		} catch {
			return {}
		}
	}

	private persistAll(): void {
		try {
			// Legacy values first, metadata last: if a quota error or process kill interrupts
			// this, the next load sees a mismatch and promotes the legacy value as a new edit.
			for (const [id, draft] of Object.entries(this.prefs.drafts)) {
				if (!draft.deleted && draft.text) this.storage.setItem(DRAFT_PREFIX + id, draft.text)
				else this.storage.removeItem(DRAFT_PREFIX + id)
				if (!draft.deleted && hasAgent(draft.agent)) {
					this.storage.setItem(AGENT_DRAFT_PREFIX + id, JSON.stringify(draft.agent))
				} else this.storage.removeItem(AGENT_DRAFT_PREFIX + id)
			}
			this.storage.setItem(READ_MARKS_KEY, JSON.stringify(this.prefs.readMarks))
			this.storage.setItem(META_KEY, JSON.stringify({ version: 1, drafts: this.prefs.drafts }))
		} catch {}
	}
}

let browserStore: LocalPrefs | null = null

function browserPrefs(): LocalPrefs {
	if (!browserStore) browserStore = new LocalPrefs(localStorage)
	return browserStore
}

export const loadLocalPrefs = (): LocalPrefsProjection => browserPrefs().project()
export const localPrefsSnapshot = (): Prefs => browserPrefs().snapshot()
export const localPrefsGeneration = (): number => browserPrefs().currentGeneration()
export const setLocalDraft = (id: string, text: string, agent: AgentPatch): LocalPrefsProjection =>
	browserPrefs().setDraft(id, text, agent)
export const setLocalAgent = (id: string, agent: AgentPatch, text: string): LocalPrefsProjection =>
	browserPrefs().setAgent(id, agent, text)
export const setLocalAttachments = (
	id: string,
	attachments: DraftAttachment[],
	text: string,
	agent: AgentPatch
): LocalPrefsProjection => browserPrefs().setAttachments(id, attachments, text, agent)
export const setLocalDraftContent = (
	id: string,
	text: string,
	agent: AgentPatch,
	attachments: DraftAttachment[]
): LocalPrefsProjection => browserPrefs().setContent(id, text, agent, attachments)
export const moveLocalDraft = (fromId: string, toId: string): LocalPrefsProjection =>
	browserPrefs().moveDraft(fromId, toId)
export const setLocalReadMark = (id: string, at: string): LocalPrefsProjection => browserPrefs().markRead(id, at)
export const mergeRemotePrefs = (prefs: Prefs, focusedDraft: string | null): MergeResult =>
	browserPrefs().merge(prefs, focusedDraft)
export const subscribeLocalPrefs = (listener: (immediate: boolean) => void): (() => void) =>
	browserPrefs().subscribe(listener)
export const requestPrefsFlush = (): void => browserPrefs().requestFlush()
