import { describe, expect, it } from 'vitest'
import { handleRpc } from '../../src/mcp/dispatcher.ts'
import { INSTRUCTIONS } from '../../src/mcp/protocol.ts'
import { createTools } from '../../src/mcp/registry.ts'
import type { CallOptions, RelayCall } from '../../src/mcp/types.ts'
import { routes } from '../../src/routes.ts'
import { HIT_CLOSE, HIT_OPEN } from '../../src/shared.ts'
import type { VoiceHistoryCall, VoiceHistoryEntry } from '../../src/wire.ts'

const entry = (id: string, text: string, role: VoiceHistoryEntry['role'] = 'user'): VoiceHistoryEntry => ({
	id,
	text,
	role,
	at: 2_000,
	partial: false,
	interrupted: false,
	transcriptionFailed: false
})
const saved: VoiceHistoryCall = {
	callId: 'rtc_saved',
	startedAt: 1_000,
	updatedAt: 3_000,
	endedAt: null,
	status: 'interrupted',
	transport: 'webrtc',
	model: 'test',
	voice: 'marin',
	language: 'no',
	hasGaps: true,
	entryCount: 5,
	preview: 'first question',
	entries: [
		entry('i1', 'first question'),
		entry('i2', 'first answer', 'assistant'),
		entry('i3', 'second question'),
		entry('i4', 'second answer', 'assistant'),
		entry('i5', 'third question')
	]
}

function fixture(response: unknown) {
	const requests: { route: string; options?: CallOptions }[] = []
	const call: RelayCall = async <T>(route: string, options?: CallOptions) => {
		requests.push({ route, options })
		return response as T
	}
	const tools = createTools(call)
	return { requests, tools, tool: (name: string) => tools.find(tool => tool.name === name)! }
}

describe('MCP voice history', () => {
	it('advertises the three tools through the shared JSON-RPC dispatcher', async () => {
		const { tools } = fixture(null)
		const result = await handleRpc(tools, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
		if (!result) throw new Error('tools/list must return a response')
		const listed = (result.result as { tools: { name: string }[] }).tools.map(tool => tool.name)
		for (const name of ['list_voice_calls', 'search_voice_calls', 'read_voice_call']) {
			expect(listed).toContain(name)
			expect(INSTRUCTIONS).toContain(name)
		}
	})

	it('lists saved calls through an authenticated relay GET with pagination and capture warnings', async () => {
		const { tool, requests } = fixture({ calls: [saved], hasMore: true })
		const output = await tool('list_voice_calls').run({ limit: 1, offset: 4 })
		expect(requests).toEqual([{ route: `${routes.voiceHistory.path()}?limit=1&offset=4`, options: undefined }])
		expect(output).toContain('call_id: rtc_saved')
		expect(output).toContain('first question')
		expect(output).toContain('may have gaps')
		expect(output).toContain('next_offset: 5')
		await expect(tool('list_voice_calls').run({ delete: true })).rejects.toThrow('unknown field')
	})

	it('searches with encoded scope and returns item ids that can be read nearby', async () => {
		const { tool, requests } = fixture({
			query: 'blåbær & Friday',
			hasMore: true,
			hits: [
				{
					call: saved,
					itemId: 'i4',
					at: 2_000,
					role: 'assistant',
					partial: false,
					interrupted: true,
					transcriptionFailed: false,
					snippet: `Wait until ${HIT_OPEN}Friday${HIT_CLOSE}.`
				}
			]
		})
		const output = await tool('search_voice_calls').run({ query: 'blåbær & Friday', call_id: 'rtc/a', offset: 2 })
		const url = new URL(requests[0].route, 'http://localhost')
		expect(url.pathname).toBe(routes.voiceSearch.path())
		expect(url.searchParams.get('q')).toBe('blåbær & Friday')
		expect(url.searchParams.get('callId')).toBe('rtc/a')
		expect(requests[0].options).toBeUndefined()
		expect(output).toContain('call_id: rtc_saved')
		expect(output).toContain('item_id: i4')
		expect(output).toContain('[assistant]')
		expect(output).toContain('words not played')
		expect(output).toContain('«Friday»')
		expect(output).toContain('next_offset: 3')
		await expect(tool('search_voice_calls').run({ query: ' ' })).rejects.toThrow('query is required')
		await expect(tool('search_voice_calls').run({ query: 'x'.repeat(501) })).rejects.toThrow('at most 500')
	})

	it('reads bounded context in conversation order and rejects an item from another call', async () => {
		const { tool, requests } = fixture(saved)
		const read = tool('read_voice_call')
		const output = await read.run({ call_id: saved.callId, near: 'i3', before: 1, after: 1 })
		expect(requests).toEqual([{ route: routes.voiceTranscript.path(saved.callId), options: undefined }])
		expect(output).toMatch(/first answer[\s\S]*second question[\s\S]*second answer/)
		expect(output).not.toContain('first question')
		expect(output).not.toContain('third question')
		expect(output).toContain('older_item: i2')
		expect(output).toContain('newer_item: i4')
		expect(output).toContain('may have gaps')
		await expect(read.run({ call_id: saved.callId, near: 'foreign' })).rejects.toThrow('not in that saved call')
		const latest = await read.run({ call_id: saved.callId, limit: 1 })
		expect(latest).toContain('third question')
		expect(latest).not.toContain('first answer')
	})

	it('keeps the anchor, caveats and navigation when the requested window exceeds its text budget', async () => {
		const many: VoiceHistoryCall = {
			...saved,
			captureError: 'Some text could not be saved.',
			entries: Array.from({ length: 30 }, (_, i) => ({
				...entry(`i${i}`, 'long speech '.repeat(1_000), 'assistant'),
				interrupted: true
			}))
		}
		const { tool } = fixture(many)
		const text = await tool('read_voice_call').run({
			call_id: saved.callId,
			near: 'i15',
			before: 100,
			after: 100,
			max_chars: 1_000
		})
		expect(text.length).toBeLessThanOrEqual(1_000)
		expect(text).toContain('item_id: i15')
		expect(text).toContain('words not played')
		expect(text).toContain('Some text could not be saved.')
		expect(text).toContain('older_item:')
		expect(text).toContain('newer_item:')
		expect(text).toContain('[truncated]')
	})

	it('returns useful empty history and transcript results', async () => {
		expect(await fixture({ calls: [], hasMore: false }).tool('list_voice_calls').run({})).toContain(
			'No saved voice calls'
		)
		expect(await fixture({ hits: [], hasMore: false }).tool('search_voice_calls').run({ query: 'missing' })).toContain(
			'No saved voice transcript matches'
		)
		expect(
			await fixture({ ...saved, entries: [] })
				.tool('read_voice_call')
				.run({ call_id: saved.callId })
		).toContain('Showing 0 of 0 entries')
	})
})
