/** Deterministic, speech-bounded fleet briefing built only from Conductor's read side. */
import type { Prefs, PrefsPatch } from '../prefs.ts'
import type { SessionState, Workspace } from '../reads.ts'
import { clipExact, oneLine, speechText } from '../speech.ts'

const DORMANT_MS = 7 * 24 * 60 * 60 * 1000
const DORMANT_LABELS = new Set(['backlog', 'done', 'canceled', 'cancelled'])
const OVERVIEW_PAGE_SIZE = 3

export interface VoiceDecision {
	situation: string
	question: string
	options: string[]
	consequence: string
}

export interface VoiceBriefReads {
	listWorkspaces(): Workspace[]
	listSessionStates(): SessionState[]
	lastAssistantText(sessionId: string): string | null
	lastQuestionInput(sessionId: string): unknown | null
}

export interface VoiceQueueItem {
	workspaceId: string
	sessionId: string
	title: string
	updatedAt: string
	priority: number
	decision: VoiceDecision
}

export interface RollCall {
	spoken: string
	working: number
	needsYou: number
	dormant: number
	queue: VoiceQueueItem[]
}

export interface NextDecision {
	spoken: string
	cursor: number
	workspaceId: string
	sessionId: string
}

export interface WorkspaceOverviewItem {
	workspaceId: string
	sessionId: string
	title: string
	status: string
	updatedAt: string
	update: string
}

export interface WorkspaceOverview {
	spoken: string
	current: number
	dormant: number
	cursor: number | null
	workspaces: WorkspaceOverviewItem[]
}

interface BriefDeps {
	reads: VoiceBriefReads
	locked: () => Promise<boolean>
	readPrefs: () => Prefs
	writePrefs: (patch: PrefsPatch) => Prefs
	now?: () => number
}

function clean(text: string): string {
	return text
		.replace(/[*_`#]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

function lastParagraph(text: string): string {
	return (
		text
			.trim()
			.split(/\n\s*\n/)
			.map(clean)
			.filter(Boolean)
			.at(-1) ?? ''
	)
}

/** Parse `D<N> —`, lettered choices, `(recommended)`, and `Recommendation:` briefs. */
export function parseProseDecision(text: string): VoiceDecision | null {
	const lines = text.split('\n')
	const heading = lines.findIndex(line => /^\s*#{0,6}\s*\**D\d+\s*[—:-]\s*/i.test(line))
	if (heading < 0) return null
	const question = clean(lines[heading].replace(/^\s*#{0,6}\s*\**D\d+\s*[—:-]\s*/i, ''))
	if (!question) return null
	const options: string[] = []
	let consequence = ''
	for (let i = heading + 1; i < lines.length; i++) {
		const line = clean(lines[i])
		if (/^[A-Z][.)]\s+/.test(line)) options.push(line)
		else if (/^Recommendation\s*:/i.test(line)) consequence = line.replace(/^Recommendation\s*:\s*/i, '')
	}
	if (!options.length) return null
	const before = lines.slice(0, heading).join('\n')
	return { situation: lastParagraph(before), question, options, consequence }
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/** Parse the input shape used by AskUserQuestion without depending on a provider SDK. */
export function parseStructuredQuestion(input: unknown): VoiceDecision | null {
	const root = object(input)
	const first = Array.isArray(root?.questions) ? object(root.questions[0]) : null
	if (!first || typeof first.question !== 'string' || !first.question.trim()) return null
	const rawOptions = Array.isArray(first.options) ? first.options : []
	const options = rawOptions.flatMap((raw, index) => {
		const option = object(raw)
		if (!option || typeof option.label !== 'string' || !option.label.trim()) return []
		const letter = String.fromCharCode(65 + index)
		const description = typeof option.description === 'string' ? clean(option.description) : ''
		return [`${letter}. ${clean(option.label)}${description ? ` — ${description}` : ''}`]
	})
	if (!options.length) return null
	return { situation: '', question: clean(first.question), options, consequence: '' }
}

function parseDate(value: string | null): number {
	if (!value) return 0
	// SQLite values have no zone marker but are UTC in Conductor's DB.
	const normalized = value.includes('T') || /Z$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
	const parsed = Date.parse(normalized)
	return Number.isFinite(parsed) ? parsed : 0
}

function statusLabel(workspace: Workspace): string | null {
	return workspace.manual_status ?? workspace.derived_status
}

function isDormant(state: SessionState, workspace: Workspace, now: number): boolean {
	if (state.status !== 'idle' && state.status) return false
	const old = now - parseDate(state.updatedAt) > DORMANT_MS
	const labelled = DORMANT_LABELS.has((statusLabel(workspace) ?? '').toLowerCase())
	return old || labelled
}

function overviewRank(state: SessionState): number {
	if (state.status === 'error') return 0
	if (state.status === 'needs_user_input' || state.status === 'needs_plan_response') return 1
	if (state.status === 'working') return 2
	return 3
}

function overviewStatus(state: SessionState, workspace: Workspace): string {
	if (state.status === 'error') return 'has an error'
	if (state.status === 'needs_user_input' || state.status === 'needs_plan_response') return 'needs you'
	if (state.status === 'working') return 'is working'
	if (workspace.unread_sessions.some(session => session.id === state.sessionId)) return 'has an unread update'
	return 'is recently active'
}

function fallbackDecision(state: SessionState, said: string): VoiceDecision {
	const last = lastParagraph(said) || `${state.workspaceTitle} needs attention.`
	return {
		situation: last,
		question: state.status === 'error' ? 'What should the agent try next?' : 'What should this agent do next?',
		options: ['A. Send a focused instruction.', 'B. Skip this item for now.'],
		consequence: 'Sending unblocks the owning workspace; skipping leaves it in the queue.'
	}
}

function spokenDecision(item: VoiceQueueItem): string {
	const d = item.decision
	const fields = [
		`Situation: ${item.title}. ${d.situation}`,
		`Decision needed: ${d.question}`,
		`Safe options: ${d.options.join(' ')}`,
		d.consequence ? `Consequence: ${d.consequence}` : ''
	]
		.filter(Boolean)
		.map(field => oneLine(field, 180))
	return clipExact(fields.join(' '), 400)
}

export class VoiceBriefBoard {
	private readonly deps: BriefDeps
	private readonly now: () => number
	private cached: VoiceQueueItem[] | null = null

	constructor(deps: BriefDeps) {
		this.deps = deps
		this.now = deps.now ?? Date.now
	}

	private build(): { queue: VoiceQueueItem[]; working: number; dormant: number } {
		const workspaces = new Map(this.deps.reads.listWorkspaces().map(ws => [ws.id, ws]))
		const marks = this.deps.readPrefs().readMarks
		let working = 0
		let dormant = 0
		const queue: VoiceQueueItem[] = []
		for (const state of this.deps.reads.listSessionStates()) {
			const workspace = workspaces.get(state.workspaceId)
			if (!workspace) continue
			if (state.status === 'working') {
				working++
				continue
			}
			if (isDormant(state, workspace, this.now())) {
				dormant++
				continue
			}
			if ((marks[state.sessionId] ?? '') >= state.updatedAt) continue

			const said = this.deps.reads.lastAssistantText(state.sessionId) ?? ''
			const prose = parseProseDecision(said)
			const structured = prose ? null : parseStructuredQuestion(this.deps.reads.lastQuestionInput(state.sessionId))
			const hasQuestion = Boolean(prose ?? structured) || /\?\s*$/.test(said.trim())
			const unread = workspace.unread_sessions.some(s => s.id === state.sessionId)
			const priority =
				state.status === 'error'
					? 0
					: state.status === 'needs_user_input' || state.status === 'needs_plan_response'
						? 1
						: hasQuestion
							? 2
							: unread
								? 3
								: 4
			queue.push({
				workspaceId: state.workspaceId,
				sessionId: state.sessionId,
				title: state.sessionTitle ? `${state.workspaceTitle}, ${state.sessionTitle}` : state.workspaceTitle,
				updatedAt: state.updatedAt,
				priority,
				decision: prose ?? structured ?? fallbackDecision(state, said)
			})
		}
		queue.sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt))
		return { queue, working, dormant }
	}

	private items(): VoiceQueueItem[] {
		if (!this.cached) this.cached = this.build().queue
		return this.cached
	}

	/** A deliberately uncached read: a new overview must not replay the call-opening tally. */
	async workspaceOverview(cursor = 0): Promise<WorkspaceOverview> {
		const workspaces = new Map(this.deps.reads.listWorkspaces().map(workspace => [workspace.id, workspace]))
		const grouped = new Map<string, SessionState[]>()
		for (const state of this.deps.reads.listSessionStates()) {
			if (!workspaces.has(state.workspaceId)) continue
			const states = grouped.get(state.workspaceId) ?? []
			states.push(state)
			grouped.set(state.workspaceId, states)
		}

		let dormant = 0
		const items: (WorkspaceOverviewItem & { rank: number })[] = []
		for (const [workspaceId, workspace] of workspaces) {
			const current = (grouped.get(workspaceId) ?? []).filter(state => !isDormant(state, workspace, this.now()))
			if (!current.length) {
				dormant++
				continue
			}
			current.sort((a, b) => overviewRank(a) - overviewRank(b) || parseDate(b.updatedAt) - parseDate(a.updatedAt))
			const state = current[0]
			const said = this.deps.reads.lastAssistantText(state.sessionId) ?? ''
			items.push({
				workspaceId,
				sessionId: state.sessionId,
				title: state.sessionTitle ? `${state.workspaceTitle}, ${state.sessionTitle}` : state.workspaceTitle,
				status: overviewStatus(state, workspace),
				updatedAt: state.updatedAt,
				update: oneLine(speechText(said, 150), 150),
				rank: overviewRank(state)
			})
		}
		items.sort((a, b) => a.rank - b.rank || parseDate(b.updatedAt) - parseDate(a.updatedAt))

		const offset = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0
		const rankedPage = items.slice(offset, offset + OVERVIEW_PAGE_SIZE)
		const page = rankedPage.map(({ rank: _rank, ...item }) => item)
		const next = offset + page.length < items.length ? offset + page.length : null
		const noun = items.length === 1 ? 'workspace' : 'workspaces'
		const lines = page.map(
			item => `${item.title} ${item.status}.${item.update ? ` ${item.update}` : ' No agent update yet.'}`
		)
		const more = next === null ? '' : ` ${items.length - next} more current; ask me to continue.`
		const none = items.length ? '' : ' Nothing is active right now.'
		return {
			spoken: clipExact(
				`Fresh overview: ${items.length} current ${noun}, ${dormant} dormant. ${lines.join(' ')}${more}${none}`.trim(),
				700
			),
			current: items.length,
			dormant,
			cursor: next,
			workspaces: page
		}
	}

	async rollCall(): Promise<RollCall> {
		const built = this.build()
		this.cached = built.queue
		const locked = await this.deps.locked()
		const needsYou = built.queue.filter(item => item.priority < 4).length
		const heads = built.queue.slice(0, 3).map(item => item.title)
		const spoken = clipExact(
			`${locked ? 'Mac is locked; sends will park.' : 'Mac is unlocked; sends can land.'} ${built.working} working, ${needsYou} need you, ${built.dormant} dormant.${heads.length ? ` Queue starts with ${heads.join(', ')}.` : ''}`,
			600
		)
		return { spoken, working: built.working, needsYou, dormant: built.dormant, queue: built.queue }
	}

	async nextDecision(cursor = 0): Promise<NextDecision | null> {
		const item = this.items()[Math.max(0, Math.floor(cursor))]
		if (!item) return null
		return {
			spoken: spokenDecision(item),
			cursor: Math.max(0, Math.floor(cursor)) + 1,
			workspaceId: item.workspaceId,
			sessionId: item.sessionId
		}
	}

	/** A dispatch or an explicit spoken skip is handled; merely hearing the item is not. */
	markHandled(sessionId: string): void {
		const item = this.items().find(candidate => candidate.sessionId === sessionId)
		if (!item) return
		this.deps.writePrefs({ readMarks: { [sessionId]: item.updatedAt } })
	}
}
