import { routes } from '../../routes.ts'
import type {
	VoiceHistoryCall,
	VoiceHistoryEntry,
	VoiceHistoryResponse,
	VoiceHistorySearchResponse
} from '../../wire.ts'
import { need, num, rejectUnknown, str } from '../arguments.ts'
import { boundedTranscript, clip, unmark, voiceCallHeader, voiceEntryFlags } from '../formatters.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createListVoiceCallsTool(call: RelayCall): Tool {
	return {
		name: 'list_voice_calls',
		description:
			'List saved fleet voice calls on this Mac, newest first, with dates, previews and call_id values for read_voice_call. These transcripts are separate from Conductor chat history. Read-only; no live call or UI interaction.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', description: 'Calls per page (default 20, max 50).' },
				offset: {
					type: 'integer',
					description: 'Skip this many calls; use next_offset from the previous page (default 0).'
				}
			},
			additionalProperties: false
		},
		run: async args => {
			rejectUnknown(args, ['limit', 'offset'])
			const limit = Math.min(50, Math.max(1, Math.floor(num(args.limit) ?? 20)))
			const offset = Math.min(1_000_000, Math.max(0, Math.floor(num(args.offset) ?? 0)))
			const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
			const data = await call<VoiceHistoryResponse>(`${routes.voiceHistory.path()}?${params}`)
			if (!data.calls.length)
				return 'No saved voice calls on this page. Only calls captured after transcript saving was enabled are available.'
			return [
				...data.calls.map(item => [...voiceCallHeader(item), clip(item.preview.replace(/\s+/g, ' '), 200)].join('\n')),
				...(data.hasMore ? [`next_offset: ${offset + data.calls.length}`] : [])
			].join('\n\n')
		}
	}
}

export function createSearchVoiceCallsTool(call: RelayCall): Tool {
	return {
		name: 'search_voice_calls',
		description:
			'Search caller and assistant text across saved fleet calls. Results include matching excerpts, call_id and item_id; pass those to read_voice_call as call_id and near to read surrounding decisions. Partial and interrupted text is labeled. Read-only; no UI interaction.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					maxLength: 500,
					description: 'Words ranked by relevance; quote an exact phrase. Uses the same query grammar as search_chats.'
				},
				call_id: { type: 'string', description: 'Optional: search only this saved call.' },
				limit: { type: 'integer', description: 'Matching utterances per page (default 12, max 50).' },
				offset: {
					type: 'integer',
					description: 'Skip this many hits; use next_offset from the previous page (default 0).'
				}
			},
			required: ['query'],
			additionalProperties: false
		},
		run: async args => {
			rejectUnknown(args, ['query', 'call_id', 'limit', 'offset'])
			const query = need(args, 'query')
			if (query.length > 500) throw new Error('query must be at most 500 characters')
			const limit = Math.min(50, Math.max(1, Math.floor(num(args.limit) ?? 12)))
			const offset = Math.min(1_000_000, Math.max(0, Math.floor(num(args.offset) ?? 0)))
			const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) })
			if (str(args.call_id)) params.set('callId', str(args.call_id)!)
			const data = await call<VoiceHistorySearchResponse>(`${routes.voiceSearch.path()}?${params}`)
			if (!data.hits.length) return `No saved voice transcript matches ${JSON.stringify(query)} on this page.`
			return [
				...data.hits.map(hit =>
					[
						...voiceCallHeader(hit.call),
						`item_id: ${hit.itemId} · ${new Date(hit.at).toISOString()}`,
						`[${hit.role}]${voiceEntryFlags(hit)} ${clip(unmark(hit.snippet), 500)}`
					].join('\n')
				),
				...(data.hasMore ? [`next_offset: ${offset + data.hits.length}`] : [])
			].join('\n\n')
		}
	}
}

export function createReadVoiceCallTool(call: RelayCall): Tool {
	return {
		name: 'read_voice_call',
		description:
			'Read a saved fleet-call transcript by call_id, with caller, orchestrator and tool activity in conversation order. Pass an item_id from search_voice_calls as near for surrounding context, or use older_item/newer_item from a previous read. Without near, reads the latest entries. Text can be clipped to max_chars; narrow the window or raise that budget to read more. Interrupted replies can include generated words the caller never heard. Read-only; no UI interaction.',
		inputSchema: {
			type: 'object',
			properties: {
				call_id: { type: 'string', description: 'From list_voice_calls or search_voice_calls.' },
				near: { type: 'string', description: 'A transcript item_id from a search hit or previous read.' },
				before: { type: 'integer', description: 'Entries before near (default 6, max 100).' },
				after: { type: 'integer', description: 'Entries after near (default 6, max 100).' },
				limit: { type: 'integer', description: 'Latest entries when near is omitted (default 20, max 200).' },
				max_chars: { type: 'integer', description: 'Hard output budget (default 12000, min 1000, max 40000).' }
			},
			required: ['call_id'],
			additionalProperties: false
		},
		run: async args => {
			rejectUnknown(args, ['call_id', 'near', 'before', 'after', 'limit', 'max_chars'])
			const callId = need(args, 'call_id')
			const data = await call<VoiceHistoryCall>(routes.voiceTranscript.path(callId))
			const entries = data.entries.filter(entry => entry.role !== 'relay')
			const near = str(args.near)
			const anchor = near ? entries.findIndex(entry => entry.id === near) : -1
			if (near && anchor === -1) throw new Error('near item is not in that saved call')
			const count = (value: unknown, fallback: number, max: number) =>
				Math.min(max, Math.max(0, Math.floor(num(value) ?? fallback)))
			const limit = Math.max(1, count(args.limit, 20, 200))
			let start = near ? Math.max(0, anchor - count(args.before, 6, 100)) : Math.max(0, entries.length - limit)
			let end = near ? Math.min(entries.length, anchor + count(args.after, 6, 100) + 1) : entries.length
			const maxChars = Math.max(1_000, count(args.max_chars, 12_000, 40_000))
			const heading = (entry: VoiceHistoryEntry) =>
				`[${entry.role}] item_id: ${entry.id} · ${new Date(entry.at).toISOString()}${voiceEntryFlags(entry)}\n`
			// Keep identities and caveats readable even for a tiny budget. Shrink the
			// window around its anchor, then advertise the omitted sides for paging.
			while (end - start > 1) {
				const minRow = Math.max(...entries.slice(start, end).map(entry => heading(entry).length)) + 80
				if (voiceCallHeader(data).join('\n').length + 240 + (end - start) * (minRow + 2) <= maxChars) break
				if (!near || anchor - start > end - anchor - 1) start += 1
				else end -= 1
			}
			const selected = entries.slice(start, end)
			const head = [
				...voiceCallHeader(data),
				`Showing ${selected.length} of ${entries.length} entries.`,
				...(start > 0 && selected[0] ? [`older_item: ${selected[0].id} (use as near with before > 0)`] : []),
				...(end < entries.length && selected.at(-1)
					? [`newer_item: ${selected.at(-1)!.id} (use as near with after > 0)`]
					: [])
			]
			const rendered = selected.map(entry => `${heading(entry)}${entry.text}`)
			return boundedTranscript(head, rendered, maxChars)
		}
	}
}
