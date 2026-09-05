import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceHistory } from '../../src/voice/history.ts'
import { VoiceRecall } from '../../src/voice/recall.ts'

const NOW = new Date(2026, 8, 5, 12).getTime()
const TODAY = new Date(2026, 8, 5).getTime()
const YESTERDAY = new Date(2026, 8, 4).getTime()
const dirs: string[] = []
const stores: VoiceHistory[] = []

afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-recall-'))
	dirs.push(dir)
	const file = path.join(dir, 'history.db')
	const history = new VoiceHistory(file, { now: () => NOW })
	stores.push(history)
	const recall = new VoiceRecall({ history, callId: 'current', now: () => NOW })
	const add = (callId: string, startedAt: number, text: string) => {
		history.start({ callId, startedAt, transport: 'webrtc', model: 'test', voice: 'marin', language: 'auto' })
		history.record(callId, {
			type: 'conversation.item.added',
			item: {
				id: `${callId}_user`,
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text }]
			}
		})
		history.finish(callId, 'ended')
	}
	return { history, recall, file, add }
}

describe('on-request voice recall', () => {
	it('finds the preceding dropped call after restart without mistaking the new call for it', () => {
		const { history, file, add } = setup()
		add('previous', NOW - 60_000, 'We should test the blue lamp tomorrow.')
		history.record('previous', {
			type: 'response.output_audio_transcript.delta',
			item_id: 'unfinished',
			delta: 'The blue lamp needs'
		})
		history.finish('previous', 'interrupted')
		add('current', NOW, 'What did we just talk about?')
		history.close()

		const reopened = new VoiceHistory(file)
		stores.push(reopened)
		const recall = new VoiceRecall({ history: reopened, callId: 'current', now: () => NOW })
		const latest = recall.list({ limit: 1 })
		expect(latest.calls).toMatchObject([{ callId: 'previous', status: 'interrupted', hasGaps: true }])
		expect(latest.nextOffset).toBeNull()
		const result = recall.read(latest.calls[0].callId)
		expect(result?.messages).toMatchObject([
			{ role: 'user', text: 'We should test the blue lamp tomorrow.', partial: false },
			{ role: 'assistant', text: 'The blue lamp needs', partial: true }
		])
		expect(JSON.stringify(result)).not.toContain('What did we just talk about?')
		expect(() => recall.read('current')).toThrow(/current call/)
	})

	it('lists yesterday using the Mac calendar and applies filters before pagination', () => {
		const { recall, add } = setup()
		add('before', YESTERDAY - 1, 'Day before yesterday')
		add('first', YESTERDAY, 'First discussion yesterday')
		add('last', TODAY - 1, 'Last discussion yesterday')
		add('today', TODAY, 'Discussion today')
		add('current', NOW, 'Current conversation')

		const filters = { startedSince: 'yesterday', startedBefore: 'today', limit: 1 }
		const first = recall.list(filters)
		expect(first.calls.map(call => call.callId)).toEqual(['last'])
		expect(first.nextOffset).toBe(1)
		expect(first.asOf).toBe(new Date(NOW).toISOString())
		expect(first.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
		const second = recall.list({ ...filters, offset: first.nextOffset! })
		expect(second.calls.map(call => call.callId)).toEqual(['first'])
		expect(second.nextOffset).toBeNull()
	})

	it('searches a topic within previous calls and returns an anchor for reading the discussion', () => {
		const { history, recall, add } = setup()
		add('old', YESTERDAY - 1, 'Blue lamp from last week')
		add('yesterday', YESTERDAY, 'Blue lamp color should be navy')
		add('current', NOW, 'Blue lamp blue lamp')
		history.record('yesterday', {
			type: 'response.output_audio_transcript.done',
			item_id: 'reply',
			transcript: 'Navy it is.'
		})
		history.record('yesterday', { type: 'conversation.item.truncated', item_id: 'reply' })
		history.internal('yesterday', 'relay_hidden')
		history.record('yesterday', {
			type: 'conversation.item.added',
			item: {
				id: 'relay_hidden',
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Secret blue lamp nudge' }]
			}
		})
		history.record('yesterday', {
			type: 'response.output_item.done',
			item: { id: 'tool', type: 'function_call', name: 'voice_send', arguments: '{"text":"Secret blue lamp payload"}' }
		})

		const result = recall.search('blue lamp', { startedSince: 'yesterday', startedBefore: 'today' })
		expect(result.hits).toMatchObject([{ call: { callId: 'yesterday' }, itemId: 'yesterday_user', role: 'user' }])
		expect(result.nextOffset).toBeNull()
		const transcript = recall.read(result.hits[0].call.callId, { near: result.hits[0].itemId })
		expect(transcript?.messages).toMatchObject([
			{ role: 'user', text: 'Blue lamp color should be navy' },
			{ role: 'assistant', text: 'Navy it is.', interrupted: true }
		])
		expect(JSON.stringify(transcript)).not.toMatch(/Secret|voice_send/)
		expect(recall.search('blue lamp', { callId: 'current' }).hits).toEqual([])
	})

	it('bounds recalled text and lets the caller narrow or page a long transcript', () => {
		const { history, recall, add } = setup()
		add('long', YESTERDAY, 'A long design discussion')
		for (let index = 0; index < 40; index++) {
			history.record('long', {
				type: 'response.output_audio_transcript.done',
				item_id: `answer-${index}`,
				transcript: `Answer ${index}: ${'Long explanation. '.repeat(200)}`
			})
		}
		const tail = recall.read('long', { limit: 10, maxChars: 1_000 })!
		expect(tail.messages).toHaveLength(10)
		expect(tail.messages.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(1_000)
		expect(tail.truncated).toBe(true)
		expect(tail.messages[0].textTruncated).toBe(true)
		expect(tail.olderItem).toBe('answer-30')
		expect(tail.newerItem).toBeNull()
		const older = recall.read('long', { near: tail.olderItem!, before: 2, after: 0 })!
		expect(older.messages.map(message => message.itemId)).toEqual(['answer-28', 'answer-29', 'answer-30'])
		expect(older.newerItem).toBe('answer-30')
		const fullMessage = recall.read('long', { near: 'answer-30', before: 0, after: 0, maxChars: 5_000 })!
		expect(fullMessage.messages[0].textTruncated).toBe(false)
		expect(fullMessage.messages[0].text).toBe(`Answer 30: ${'Long explanation. '.repeat(200)}`.trim())
	})

	it('does not substitute unrelated history for a missing call, date, topic, or anchor', () => {
		const { recall, add } = setup()
		add('previous', YESTERDAY, 'Existing discussion')
		expect(recall.read('missing')).toBeNull()
		expect(recall.search('unrelated topic').hits).toEqual([])
		expect(recall.list({ startedSince: 'today' }).calls).toEqual([])
		expect(() => recall.read('previous', { near: 'missing' })).toThrow(/not in that saved call/)
		expect(() => recall.list({ startedSince: 'whenever' })).toThrow(/started_since/)
		expect(() => recall.search('discussion', { startedSince: 'today', startedBefore: 'yesterday' })).toThrow(/earlier/)
	})
})
