import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceHistory } from '../src/voice/history.ts'

const dirs: string[] = []
const stores: VoiceHistory[] = []
afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
	vi.useRealTimers()
})

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-history-'))
	dirs.push(dir)
	const file = path.join(dir, 'history.db')
	let now = 1_000
	const log = vi.fn()
	const history = new VoiceHistory(file, { now: () => now, log })
	stores.push(history)
	const call = {
		callId: 'rtc_test',
		startedAt: now,
		transport: 'webrtc' as const,
		model: 'test-model',
		voice: 'marin',
		language: 'no' as const
	}
	history.start(call)
	return {
		history,
		call,
		file,
		log,
		advance: () => {
			now += 1_000
		}
	}
}

function added(history: VoiceHistory, id: string, previousId: string | null, role = 'user') {
	history.record('rtc_test', {
		type: 'conversation.item.added',
		previous_item_id: previousId,
		item: { id, type: 'message', role, content: [] }
	})
}

function said(history: VoiceHistory, id: string, text: string, role = 'user') {
	history.record('rtc_test', {
		type:
			role === 'user'
				? 'conversation.item.input_audio_transcription.completed'
				: 'response.output_audio_transcript.done',
		item_id: id,
		content_index: 0,
		transcript: text
	})
}

describe('durable voice transcripts', () => {
	it('searches both speakers with reusable item ids while excluding internal nudges and tool payloads', () => {
		const { history, call } = setup()
		added(history, 'u1', null)
		said(history, 'u1', 'Vi velger blåbær for the release.')
		added(history, 'a1', 'u1', 'assistant')
		said(history, 'a1', 'Release Friday after the backup.', 'assistant')
		history.internal(call.callId, 'relay_hidden')
		history.record(call.callId, {
			type: 'conversation.item.added',
			item: {
				id: 'relay_hidden',
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'private relay nudge' }]
			}
		})
		history.record(call.callId, {
			type: 'response.output_item.done',
			item: { id: 'tool', type: 'function_call', name: 'voice_send', arguments: '{"token":"private-preview-secret"}' }
		})
		expect(history.search('BLÅBÆR').hits).toMatchObject([{ itemId: 'u1', role: 'user', call: { callId: call.callId } }])
		expect(history.search('"release Friday"').hits).toMatchObject([{ itemId: 'a1', role: 'assistant' }])
		expect(history.search('private').hits).toEqual([])
		expect(history.search('voice_send').hits).toEqual([])
		expect(history.search('"; -- % ()').hits).toEqual([])
		expect(history.search('release', { callId: 'another_call' }).hits).toEqual([])
		expect(history.search('release', { limit: 1 })).toMatchObject({
			hits: [{ call: { callId: call.callId } }],
			hasMore: true
		})
		expect(history.search('release', { limit: 1, offset: 1 }).hasMore).toBe(false)
		expect(() => history.search('x'.repeat(501))).toThrow('at most 500')
	})

	it('replaces partial search terms when a final transcript corrects them and retains interruption flags', () => {
		const { history, call } = setup()
		history.record(call.callId, { type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'provisional' })
		expect(history.search('provisional').hits).toMatchObject([{ partial: true }])
		said(history, 'a1', 'Corrected answer', 'assistant')
		history.record(call.callId, { type: 'conversation.item.truncated', item_id: 'a1' })
		expect(history.search('provisional').hits).toEqual([])
		expect(history.search('corrected').hits).toMatchObject([{ partial: false, interrupted: true }])
	})

	it('backfills the search index for a v1 archive without losing calls or duplicating matches on reopening', () => {
		const { history, file } = setup()
		said(history, 'u1', 'An existing decision about Friday.')
		history.close()
		const legacy = new DatabaseSync(file)
		legacy.exec(
			'DROP TRIGGER voice_search_insert; DROP TRIGGER voice_search_update; DROP TRIGGER voice_search_delete; DROP TABLE voice_search; PRAGMA user_version = 1;'
		)
		legacy.close()
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const reopened = new VoiceHistory(file)
			stores.push(reopened)
			expect(reopened.search('Friday').hits).toMatchObject([{ itemId: 'u1' }])
			expect(reopened.read('rtc_test')?.entries[0].text).toBe('An existing decision about Friday.')
			reopened.close()
		}
	})
	it('persists each finished utterance before hang-up and reopens the same transcript', () => {
		const { history, file, advance } = setup()
		added(history, 'u1', null)
		said(history, 'u1', 'Start the Norwegian workspace.')
		advance()
		added(history, 'a1', 'u1', 'assistant')
		said(history, 'a1', 'Which repository?', 'assistant')
		const reopened = new VoiceHistory(file)
		stores.push(reopened)
		expect(reopened.read('rtc_test')?.entries.map(entry => [entry.role, entry.text])).toEqual([
			['user', 'Start the Norwegian workspace.'],
			['assistant', 'Which repository?']
		])
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		history.finish('rtc_test', 'ended')
		expect(reopened.read('rtc_test')).toMatchObject({
			status: 'ended',
			endedAt: 2_000,
			model: 'test-model',
			voice: 'marin',
			language: 'no',
			entryCount: 2
		})
	})

	it('uses item order when caller transcription finishes after two replies, including invisible predecessors', () => {
		const { history } = setup()
		added(history, 'u1', null)
		added(history, 'a1', 'u1', 'assistant')
		said(history, 'a1', 'First answer', 'assistant')
		history.record('rtc_test', {
			type: 'conversation.item.added',
			previous_item_id: 'a1',
			item: { id: 'result', type: 'function_call_output', output: 'do not archive raw output' }
		})
		added(history, 'u2', 'result')
		added(history, 'a2', 'u2', 'assistant')
		said(history, 'a2', 'Second answer', 'assistant')
		said(history, 'u2', 'Second question')
		said(history, 'u1', 'First question')
		expect(history.read('rtc_test')?.entries.map(entry => entry.text)).toEqual([
			'First question',
			'First answer',
			'Second question',
			'Second answer'
		])
	})

	it('reconciles deltas, multiple content parts and repeated completion snapshots without duplication', () => {
		const { history } = setup()
		added(history, 'a1', null, 'assistant')
		history.record('rtc_test', {
			type: 'response.output_audio_transcript.delta',
			item_id: 'a1',
			content_index: 0,
			delta: 'Draft text'
		})
		said(history, 'a1', 'Final text', 'assistant')
		said(history, 'a1', 'Final text', 'assistant')
		history.record('rtc_test', {
			type: 'response.output_audio_transcript.delta',
			item_id: 'a1',
			content_index: 0,
			delta: 'stale delta'
		})
		history.record('rtc_test', {
			type: 'response.output_text.done',
			item_id: 'a1',
			content_index: 1,
			text: 'Second part'
		})
		expect(history.read('rtc_test')?.entries).toMatchObject([{ text: 'Final text\nSecond part', partial: false }])
	})

	it('captures typed caller text and tool names without audio, arguments, credentials or relay-authored user items', () => {
		const { history, file } = setup()
		history.internal('rtc_test', 'relay_nudge')
		history.record('rtc_test', {
			type: 'conversation.item.added',
			previous_item_id: null,
			item: {
				id: 'relay_nudge',
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Internal nudge' }]
			}
		})
		history.record('rtc_test', {
			type: 'conversation.item.added',
			previous_item_id: 'relay_nudge',
			item: {
				id: 'typed',
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'Deploy it.' },
					{ type: 'input_audio', audio: 'AUDIO_SECRET' }
				]
			}
		})
		history.record('rtc_test', {
			type: 'conversation.item.added',
			previous_item_id: 'typed',
			item: {
				id: 'tool',
				type: 'function_call',
				name: 'voice_send',
				arguments: '{"token":"PREVIEW_SECRET"}',
				output: 'OUTPUT_SECRET'
			}
		})
		history.record('rtc_test', {
			type: 'session.updated',
			session: { tools: [{ headers: { authorization: 'AUTH_SECRET' } }] }
		})
		expect(history.read('rtc_test')?.entries.map(entry => [entry.role, entry.text])).toEqual([
			['user', 'Deploy it.'],
			['tool', 'voice_send']
		])
		history.close()
		const bytes = fs.readFileSync(file).toString('utf8')
		for (const secret of ['AUDIO_SECRET', 'PREVIEW_SECRET', 'OUTPUT_SECRET', 'AUTH_SECRET'])
			expect(bytes).not.toContain(secret)
	})

	it('retains generated text but marks interrupted playback and failed caller transcription', () => {
		const { history } = setup()
		added(history, 'a1', null, 'assistant')
		said(history, 'a1', 'A long answer not fully heard.', 'assistant')
		history.record('rtc_test', {
			type: 'conversation.item.truncated',
			item_id: 'a1',
			content_index: 0,
			audio_end_ms: 500
		})
		added(history, 'u1', 'a1')
		history.record('rtc_test', {
			type: 'conversation.item.input_audio_transcription.failed',
			item_id: 'u1',
			error: { message: 'unintelligible' }
		})
		expect(history.read('rtc_test')?.entries).toMatchObject([
			{ text: 'A long answer not fully heard.', interrupted: true },
			{ role: 'user', transcriptionFailed: true }
		])
	})

	it('saves partial captions within half a second and preserves a restart gap when the call resumes', () => {
		vi.useFakeTimers()
		const { history, file, call } = setup()
		history.record('rtc_test', {
			type: 'response.output_audio_transcript.delta',
			item_id: 'a1',
			delta: 'Partial answer'
		})
		vi.advanceTimersByTime(500)
		const reopened = new VoiceHistory(file)
		stores.push(reopened)
		expect(reopened.read('rtc_test')?.entries).toMatchObject([{ text: 'Partial answer', partial: true }])
		reopened.recover()
		expect(reopened.read('rtc_test')).toMatchObject({ status: 'interrupted', hasGaps: true, endedAt: null })
		reopened.start(call, true)
		said(reopened, 'a1', 'Final answer', 'assistant')
		expect(reopened.read('rtc_test')).toMatchObject({
			status: 'active',
			hasGaps: true,
			entries: [{ text: 'Final answer', partial: false }]
		})
	})

	it('paginates newest calls and returns null for unknown ids without treating ids as file paths', () => {
		const { history, call } = setup()
		history.start({ ...call, callId: 'rtc_newer', startedAt: 2_000 })
		expect(history.list(1)).toMatchObject({ calls: [{ callId: 'rtc_newer' }], hasMore: true })
		expect(history.list(1, 1)).toMatchObject({ calls: [{ callId: 'rtc_test' }], hasMore: false })
		expect(history.read('../../voice.json')).toBeNull()
	})

	it('keeps simultaneous calls separate even if an item id is reused', () => {
		const { history, call } = setup()
		history.start({ ...call, callId: 'rtc_second' })
		said(history, 'shared_id', 'First call')
		history.record('rtc_second', {
			type: 'conversation.item.input_audio_transcription.completed',
			item_id: 'shared_id',
			transcript: 'Second call'
		})
		history.finish('rtc_test', 'ended')
		expect(history.read('rtc_test')?.entries[0].text).toBe('First call')
		expect(history.read('rtc_second')).toMatchObject({ status: 'active', entries: [{ text: 'Second call' }] })
	})

	it('resumes capture after a storage failure and preserves the warning across restart', () => {
		const { file, call } = setup()
		const blocker = path.join(path.dirname(file), 'blocker')
		fs.writeFileSync(blocker, 'not a directory')
		const retryFile = path.join(blocker, 'history.db')
		const history = new VoiceHistory(retryFile, { log: () => undefined })
		stores.push(history)
		history.start(call)
		said(history, 'missed', 'Storage is unavailable')
		fs.unlinkSync(blocker)
		said(history, 'saved', 'Storage returned')
		expect(history.read(call.callId)).toMatchObject({
			hasGaps: true,
			captureError: expect.stringContaining('could not be saved'),
			entries: [{ text: 'Storage returned' }]
		})
		const reopened = new VoiceHistory(retryFile)
		stores.push(reopened)
		expect(reopened.read(call.callId)?.captureError).toContain('could not be saved')
	})

	it('does not throw into the live call when storage fails', () => {
		const { file, log } = setup()
		const unavailable = new VoiceHistory(path.join(file, 'impossible.db'), { log })
		stores.push(unavailable)
		expect(() =>
			unavailable.start({
				callId: 'rtc_broken',
				startedAt: 1,
				transport: 'sip',
				model: 'model',
				voice: 'marin',
				language: 'auto'
			})
		).not.toThrow()
		expect(log).toHaveBeenCalledWith(expect.stringContaining('transcript save failed'))
	})
})
