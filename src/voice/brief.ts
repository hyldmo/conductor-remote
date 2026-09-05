/** Deterministic, speech-bounded fleet briefing built only from Conductor's read side. */
import type { Prefs, PrefsPatch } from '../prefs.ts'
import type { SessionState, Workspace } from '../reads/types.ts'
import { parseVoiceDate } from './dates.ts'
import { clipExact, oneLine, speechText } from './speech.ts'

const ACTIVITY_HALF_LIFE_MS = 24 * 60 * 60 * 1000
const MIN_ACTIVITY_RELEVANCE = 1 / 8
const DORMANT_LABELS = new Set(['backlog', 'done', 'canceled', 'cancelled'])
const OVERVIEW_PAGE_SIZE = 3
const OVERVIEW_AGENT_STATUSES = new Set(['working', 'idle', 'error', 'needs-you'])

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

export interface WaitingChat {
	sessionId: string
	chatTitle: string | null
	updatedAt: string
	question: string | null
}

export interface WorkspaceOverviewItem {
	workspaceId: string
	sessionId: string
	title: string
	status: string
	updatedAt: string
	update: string
	/** The newest waiting chat, which may differ from the workspace's latest activity. */
	waitingForYou: WaitingChat | null
}

export interface WorkspaceOverview {
	spoken: string
	/** Relay time used for relative dates and filters. */
	asOf: string
	current: number
	/** Matching workspaces with a chat waiting for input; unread alone is not a question. */
	waitingForYou: number
	/** Bounded waiting-work heads, even when the latest activity page is all running chats. */
	waiting: (WaitingChat & { workspaceId: string; title: string })[]
	dormant: number
	completed: number
	filtered: number
	cursor: number | null
	workspaces: WorkspaceOverviewItem[]
}

export interface WorkspaceOverviewFilters {
	repo?: string
	agentStatus?: 'working' | 'idle' | 'error' | 'needs-you'
	workspaceStatus?: string
	prStatus?: string
	/** A named calendar boundary, relative duration such as `24h`/`7d`, or ISO date/time. */
	updatedSince?: string
	/** Exclusive upper bound, as an ISO date/time or date-only local day. */
	updatedBefore?: string
	includeDone?: boolean
	includeMerged?: boolean
	includeDormant?: boolean
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

/** Halve relevance each day; status can help a recent decision, never keep an old one on top forever. */
function activityRelevance(updatedAt: string, now: number): number {
	const at = parseDate(updatedAt)
	return at ? 2 ** (-Math.max(0, now - at) / ACTIVITY_HALF_LIFE_MS) : 0
}

function newestFirst(a: { updatedAt: string; sessionId: string }, b: { updatedAt: string; sessionId: string }): number {
	return parseDate(b.updatedAt) - parseDate(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)
}

function waitingStatus(state: SessionState): boolean {
	return state.status === 'needs_user_input' || state.status === 'needs_plan_response'
}

function trailingQuestion(text: string): string | null {
	const paragraph = lastParagraph(text)
	if (!/\?$/.test(paragraph)) return null
	return paragraph.match(/[^.!?]*\?$/)?.[0].trim() || paragraph
}

function statusLabel(workspace: Workspace): string | null {
	return workspace.manual_status ?? workspace.derived_status
}

function normalizedStatus(value: string | null | undefined): string {
	return (value ?? '').trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
}

function isDormant(
	state: SessionState,
	workspace: Workspace,
	now: number,
	options: {
		ignoreAge?: boolean
		includeDone?: boolean
		includeDormant?: boolean
		includedWorkspaceStatus?: string
	} = {}
): boolean {
	if (state.status === 'working' || options.includeDormant) return false
	const old = activityRelevance(state.updatedAt, now) < MIN_ACTIVITY_RELEVANCE
	const label = normalizedStatus(statusLabel(workspace))
	const explicitlyIncluded = options.includedWorkspaceStatus === label || (options.includeDone && label === 'done')
	const labelled = (!state.status || state.status === 'idle') && DORMANT_LABELS.has(label) && !explicitlyIncluded
	return (!options.ignoreAge && old) || labelled
}

function isDone(workspace: Workspace): boolean {
	return normalizedStatus(statusLabel(workspace)) === 'done'
}

function isMerged(workspace: Workspace): boolean {
	return workspace.pr_status === 'merged'
}

function agentStatus(state: SessionState, waiting: boolean): WorkspaceOverviewFilters['agentStatus'] {
	if (waiting) return 'needs-you'
	if (state.status === 'working' || state.status === 'error') return state.status
	return 'idle'
}

function spokenUpdateAge(value: string, now: number): string {
	const at = parseDate(value)
	if (!at) return 'Update time unavailable.'
	const elapsed = Math.max(0, now - at)
	const minutes = Math.floor(elapsed / (60 * 1000))
	if (minutes < 1) return 'Updated just now.'
	if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago.`
	const hours = Math.floor(elapsed / (60 * 60 * 1000))
	if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago.`
	const days = Math.floor(elapsed / (24 * 60 * 60 * 1000))
	if (days === 1) return 'Updated yesterday.'
	if (days < 31) return `Updated ${days} days ago.`
	const date = new Date(at)
	const month = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	][date.getUTCMonth()]
	return `Updated on ${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}.`
}

function overviewStatus(state: SessionState, workspace: Workspace, waiting: boolean): string {
	if (state.status === 'error') return 'has an error'
	if (waiting) return 'is waiting for you'
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

	private signal(state: SessionState) {
		const said = this.deps.reads.lastAssistantText(state.sessionId) ?? ''
		// Historical AskUserQuestion calls may already be answered. Only a live waiting
		// status can make that history evidence of a current structured question.
		const decision =
			parseProseDecision(said) ??
			(waitingStatus(state) ? parseStructuredQuestion(this.deps.reads.lastQuestionInput(state.sessionId)) : null)
		const question = decision?.question ?? trailingQuestion(said)
		const waiting = waitingStatus(state) || ((!state.status || state.status === 'idle') && question !== null)
		return { said, decision, question, waiting }
	}

	private build(): { queue: VoiceQueueItem[]; working: number; dormant: number } {
		const now = this.now()
		const workspaces = new Map(this.deps.reads.listWorkspaces().map(ws => [ws.id, ws]))
		const marks = this.deps.readPrefs().readMarks
		let working = 0
		let dormant = 0
		const queue: VoiceQueueItem[] = []
		for (const state of this.deps.reads.listSessionStates()) {
			const workspace = workspaces.get(state.workspaceId)
			// Completion applies to every chat signal, including working and waiting for input.
			if (!workspace || isDone(workspace) || isMerged(workspace)) continue
			if (state.status === 'working') {
				working++
				continue
			}
			if (isDormant(state, workspace, now)) {
				dormant++
				continue
			}
			if ((marks[state.sessionId] ?? '') >= state.updatedAt) continue

			const signal = this.signal(state)
			const unread = workspace.unread_sessions.some(s => s.id === state.sessionId)
			const priority = state.status === 'error' ? 0 : waitingStatus(state) ? 1 : signal.waiting ? 2 : unread ? 3 : 4
			queue.push({
				workspaceId: state.workspaceId,
				sessionId: state.sessionId,
				title: state.sessionTitle ? `${state.workspaceTitle}, ${state.sessionTitle}` : state.workspaceTitle,
				updatedAt: state.updatedAt,
				priority,
				decision: signal.decision ?? {
					...fallbackDecision(state, signal.said),
					...(signal.waiting && signal.question ? { question: signal.question } : {})
				}
			})
		}
		const score = (item: VoiceQueueItem) =>
			activityRelevance(item.updatedAt, now) * (item.priority < 3 ? 2 : item.priority === 3 ? 1 : 0.5)
		queue.sort((a, b) => score(b) - score(a) || newestFirst(a, b))
		return { queue, working, dormant }
	}

	private items(): VoiceQueueItem[] {
		if (!this.cached) this.cached = this.build().queue
		return this.cached
	}

	/** A deliberately uncached read: a new overview must not replay the call-opening tally. */
	async workspaceOverview(cursor = 0, filters: WorkspaceOverviewFilters = {}): Promise<WorkspaceOverview> {
		if (filters.agentStatus && !OVERVIEW_AGENT_STATUSES.has(filters.agentStatus))
			throw new Error('agent_status must be working, idle, error, or needs-you')
		const now = this.now()
		const updatedSince = filters.updatedSince ? parseVoiceDate(filters.updatedSince, now, 'updated_since') : null
		const updatedBefore = filters.updatedBefore ? parseVoiceDate(filters.updatedBefore, now, 'updated_before') : null
		if (updatedSince !== null && updatedBefore !== null && updatedSince >= updatedBefore)
			throw new Error('updated_since must be earlier than updated_before')
		const wantedWorkspaceStatus = filters.workspaceStatus ? normalizedStatus(filters.workspaceStatus) : null
		const completedOnly = wantedWorkspaceStatus === 'done' || filters.prStatus === 'merged'
		const includeDone = filters.includeDone === true || completedOnly
		const includeMerged = filters.includeMerged === true || completedOnly
		const ignoreDormantAge =
			updatedSince !== null ||
			updatedBefore !== null ||
			wantedWorkspaceStatus !== null ||
			filters.prStatus !== undefined
		const workspaces = new Map(this.deps.reads.listWorkspaces().map(workspace => [workspace.id, workspace]))
		const grouped = new Map<string, SessionState[]>()
		for (const state of this.deps.reads.listSessionStates()) {
			if (!workspaces.has(state.workspaceId)) continue
			const states = grouped.get(state.workspaceId) ?? []
			states.push(state)
			grouped.set(state.workspaceId, states)
		}

		let dormant = 0
		let completed = 0
		let filtered = 0
		const items: WorkspaceOverviewItem[] = []
		for (const [workspaceId, workspace] of workspaces) {
			if (filters.repo && workspace.repo_name?.toLowerCase() !== filters.repo.toLowerCase()) {
				filtered++
				continue
			}
			if (wantedWorkspaceStatus && normalizedStatus(statusLabel(workspace)) !== wantedWorkspaceStatus) {
				filtered++
				continue
			}
			if (filters.prStatus && (workspace.pr_status ?? 'none') !== filters.prStatus) {
				filtered++
				continue
			}
			if ((!includeDone && isDone(workspace)) || (!includeMerged && isMerged(workspace))) {
				completed++
				continue
			}
			const live = (grouped.get(workspaceId) ?? []).filter(
				state =>
					!isDormant(state, workspace, now, {
						ignoreAge: ignoreDormantAge,
						includeDone,
						includeDormant: filters.includeDormant,
						includedWorkspaceStatus: wantedWorkspaceStatus ?? undefined
					})
			)
			if (!live.length) {
				dormant++
				continue
			}
			const current = live
				.map(state => ({ state, signal: this.signal(state) }))
				.filter(({ state, signal }) => {
					if (filters.agentStatus && agentStatus(state, signal.waiting) !== filters.agentStatus) return false
					const at = parseDate(state.updatedAt)
					if (updatedSince !== null && at < updatedSince) return false
					if (updatedBefore !== null && at >= updatedBefore) return false
					return true
				})
			if (!current.length) {
				filtered++
				continue
			}
			current.sort((a, b) => newestFirst(a.state, b.state))
			const { state, signal } = current[0]
			const waiting = current.find(candidate => candidate.signal.waiting)
			items.push({
				workspaceId,
				sessionId: state.sessionId,
				title: oneLine(state.workspaceTitle, 100),
				status: overviewStatus(state, workspace, signal.waiting),
				updatedAt: state.updatedAt,
				update: oneLine(speechText(signal.said, 150), 150),
				waitingForYou: waiting
					? {
							sessionId: waiting.state.sessionId,
							chatTitle: waiting.state.sessionTitle,
							updatedAt: waiting.state.updatedAt,
							question: waiting.signal.question ? oneLine(speechText(waiting.signal.question, 180), 180) : null
						}
					: null
			})
		}
		items.sort(newestFirst)

		const offset = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0
		const page = items.slice(offset, offset + OVERVIEW_PAGE_SIZE)
		const next = offset + page.length < items.length ? offset + page.length : null
		const noun = items.length === 1 ? 'workspace' : 'workspaces'
		const lines = page.map(item => {
			const waiting = item.waitingForYou
			const attention = waiting
				? `${waiting.sessionId === item.sessionId ? '' : ` ${waiting.chatTitle ?? 'Another chat'} is waiting for you.`}${waiting.question ? ` ${waiting.question}` : ''}`
				: item.update
					? ` ${item.update}`
					: ' No agent update yet.'
			return `${item.title} ${item.status}. ${spokenUpdateAge(item.updatedAt, now)}${attention}`
		})
		const waiting = items
			.flatMap(item =>
				item.waitingForYou ? [{ ...item.waitingForYou, workspaceId: item.workspaceId, title: item.title }] : []
			)
			.sort(newestFirst)
		const more = next === null ? '' : ` ${items.length - next} more current; ask me to continue.`
		const none = items.length ? '' : filtered ? ' Nothing matches those filters.' : ' Nothing is active right now.'
		const completedSummary = completed ? `, ${completed} completed hidden` : ''
		const filteredSummary = filtered ? `, ${filtered} outside filters` : ''
		return {
			spoken: clipExact(
				`Fresh overview: ${items.length} current ${noun}${completedSummary}${filteredSummary}, ${dormant} dormant. ${waiting.length} waiting for you. ${lines.join(' ')}${more}${none}`.trim(),
				700
			),
			asOf: new Date(now).toISOString(),
			current: items.length,
			waitingForYou: waiting.length,
			waiting: waiting.slice(0, OVERVIEW_PAGE_SIZE),
			dormant,
			completed,
			filtered,
			cursor: next,
			workspaces: page
		}
	}

	async rollCall(): Promise<RollCall> {
		const built = this.build()
		this.cached = built.queue
		const locked = await this.deps.locked()
		const needsYou = built.queue.filter(item => item.priority < 3).length
		const heads = built.queue.slice(0, 3).map(item => item.title)
		const spoken = clipExact(
			`${locked ? 'Mac is locked; sends will park.' : 'Mac is unlocked; sends can land.'} ${built.working} working, ${needsYou} need you, ${built.dormant} dormant.${heads.length ? ` Queue starts with ${heads.join(', ')}.` : ''}`,
			600
		)
		return { spoken, working: built.working, needsYou, dormant: built.dormant, queue: built.queue }
	}

	async nextDecision(cursor = 0): Promise<NextDecision | null> {
		const items = this.items()
		const workspaces = new Map(this.deps.reads.listWorkspaces().map(workspace => [workspace.id, workspace]))
		// Keep snapshot positions stable while skipping work completed since the roll call.
		for (let index = Math.max(0, Math.floor(cursor)); index < items.length; index++) {
			const item = items[index]
			const workspace = workspaces.get(item.workspaceId)
			if (!workspace || isDone(workspace) || isMerged(workspace)) continue
			return {
				spoken: spokenDecision(item),
				cursor: index + 1,
				workspaceId: item.workspaceId,
				sessionId: item.sessionId
			}
		}
		return null
	}

	/** A dispatch or an explicit spoken skip is handled; merely hearing the item is not. */
	markHandled(sessionId: string): void {
		const item = this.items().find(candidate => candidate.sessionId === sessionId)
		if (!item) return
		this.deps.writePrefs({ readMarks: { [sessionId]: item.updatedAt } })
	}
}
