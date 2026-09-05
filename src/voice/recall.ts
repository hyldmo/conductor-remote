/** On-request access to saved calls. Never loads or writes a Conductor chat. */
import { HIT_CLOSE, HIT_OPEN } from '../shared.ts'
import type { VoiceHistorySummary } from '../wire.ts'
import { parseVoiceDate } from './dates.ts'
import type { VoiceHistory, VoiceHistoryFilters } from './history.ts'
import { clipExact } from './speech.ts'

export interface VoiceRecallFilters {
	startedSince?: string
	startedBefore?: string
	limit?: number
	offset?: number
}

export interface VoiceRecallReadOptions {
	near?: string
	before?: number
	after?: number
	limit?: number
	maxChars?: number
}

function count(value: number | undefined, fallback: number, max: number, min = 0): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback
}

function summary(call: VoiceHistorySummary) {
	return {
		callId: call.callId,
		startedAt: new Date(call.startedAt).toISOString(),
		endedAt: call.endedAt === null ? null : new Date(call.endedAt).toISOString(),
		status: call.status,
		hasGaps: call.hasGaps,
		captureError: call.captureError,
		preview: clipExact(call.preview, 160)
	}
}

export class VoiceRecall {
	private readonly history: Pick<VoiceHistory, 'list' | 'search' | 'read'>
	private readonly callId: string
	private readonly now: () => number

	constructor(deps: { history: Pick<VoiceHistory, 'list' | 'search' | 'read'>; callId: string; now?: () => number }) {
		this.history = deps.history
		this.callId = deps.callId
		this.now = deps.now ?? Date.now
	}

	private filters(options: VoiceRecallFilters, now: number): VoiceHistoryFilters {
		const startedSince = options.startedSince ? parseVoiceDate(options.startedSince, now, 'started_since') : undefined
		const startedBefore = options.startedBefore
			? parseVoiceDate(options.startedBefore, now, 'started_before')
			: undefined
		if (startedSince !== undefined && startedBefore !== undefined && startedSince >= startedBefore)
			throw new Error('started_since must be earlier than started_before')
		return { excludeCallId: this.callId, startedSince, startedBefore }
	}

	private clock(now: number) {
		return { asOf: new Date(now).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
	}

	list(options: VoiceRecallFilters = {}) {
		const now = this.now()
		const limit = count(options.limit, 5, 10, 1)
		const offset = count(options.offset, 0, 1_000_000)
		const result = this.history.list(limit, offset, this.filters(options, now))
		return {
			...this.clock(now),
			calls: result.calls.map(summary),
			nextOffset: result.hasMore ? offset + result.calls.length : null
		}
	}

	search(query: string, options: VoiceRecallFilters & { callId?: string } = {}) {
		const now = this.now()
		const offset = count(options.offset, 0, 1_000_000)
		const result = this.history.search(query, {
			...this.filters(options, now),
			limit: count(options.limit, 5, 10, 1),
			offset,
			callId: options.callId
		})
		return {
			...this.clock(now),
			hits: result.hits.map(hit => ({
				call: summary(hit.call),
				itemId: hit.itemId,
				role: hit.role,
				at: new Date(hit.at).toISOString(),
				partial: hit.partial,
				interrupted: hit.interrupted,
				transcriptionFailed: hit.transcriptionFailed,
				snippet: clipExact(hit.snippet.replaceAll(HIT_OPEN, '').replaceAll(HIT_CLOSE, ''), 500)
			})),
			nextOffset: result.hasMore ? offset + result.hits.length : null
		}
	}

	read(callId: string, options: VoiceRecallReadOptions = {}) {
		if (callId === this.callId)
			throw new Error('Use this live conversation for the current call; recall reads previous calls.')
		const call = this.history.read(callId)
		if (!call) return null
		const entries = call.entries.filter(entry => entry.role === 'user' || entry.role === 'assistant')
		const anchor = options.near ? entries.findIndex(entry => entry.id === options.near) : -1
		if (options.near && anchor < 0) throw new Error('near item is not in that saved call')
		const limit = count(options.limit, 12, 30, 1)
		const start = options.near
			? Math.max(0, anchor - count(options.before, 6, 15))
			: Math.max(0, entries.length - limit)
		const end = options.near ? Math.min(entries.length, anchor + count(options.after, 6, 15) + 1) : entries.length
		const selected = entries.slice(start, end)
		let budget = count(options.maxChars, 12_000, 20_000, 1_000)
		const messages = selected.map((entry, index) => {
			const text = clipExact(entry.text, Math.floor(budget / (selected.length - index)))
			budget -= text.length
			return {
				itemId: entry.id,
				role: entry.role,
				at: new Date(entry.at).toISOString(),
				text,
				textTruncated: text !== entry.text,
				partial: entry.partial,
				interrupted: entry.interrupted,
				transcriptionFailed: entry.transcriptionFailed
			}
		})
		return {
			...this.clock(this.now()),
			call: summary(call),
			messages,
			olderItem: start > 0 ? (selected[0]?.id ?? null) : null,
			newerItem: end < entries.length ? (selected.at(-1)?.id ?? null) : null,
			truncated: start > 0 || end < entries.length || messages.some(entry => entry.textTruncated)
		}
	}
}
