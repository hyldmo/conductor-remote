import { describe, expect, test } from 'vitest'
import { parseMessage, renderTranscript, type TranscriptEntry, toolImageAt } from '../src/transcript.ts'
import { mergeEntries } from '../web/src/lib/transcript-merge.ts'

/**
 * A tool's output is the half of a chat that never used to leave the relay, and every
 * way of getting it wrong is silent: an unpaired result renders as a step nobody ran,
 * a rebuilt entry re-renders a whole transcript on the 1s poll, and an output that
 * reaches `renderTranscript` puts the file dumps back into every fork.
 */

const row = (content: string, rowid = 1, id = 'message-1') => ({
	rowid,
	id,
	role: 'assistant' as const,
	content,
	full_message: null,
	created_at: '2026-09-01T00:00:00.000Z',
	sent_at: '2026-09-01T00:00:00.000Z',
	queue_order: null
})

const callFrame = (toolUseId: string) =>
	JSON.stringify({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'rg -n needle src' } }] }
	})

const resultFrame = (toolUseId: string, content: unknown, isError = false) =>
	JSON.stringify({
		type: 'user',
		message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] }
	})

describe('tool output on the wire', () => {
	test('a call carries its id and a result carries the output', () => {
		const [call] = parseMessage(row(callFrame('toolu_1')))
		const [result] = parseMessage(row(resultFrame('toolu_1', 'src/a.ts:3:needle'), 2, 'message-2'))

		expect(call.tool).toBe('Bash')
		expect(call.toolUseId).toBe('toolu_1')
		expect(call.output).toBeUndefined()
		expect(result.toolUseId).toBe('toolu_1')
		expect(result.output).toBe('src/a.ts:3:needle')
		expect(result.tool).toBeUndefined()
		// A success is folded onto the call or dropped, so its text would only ever be a
		// second copy of the output — the largest thing the transcript carries.
		expect(result.text).toBe('')
	})

	test('reads a result whose content is a block array, and clips a long one', () => {
		const [short] = parseMessage(row(resultFrame('toolu_1', [{ type: 'text', text: 'two lines\nof output' }])))
		expect(short.output).toBe('two lines\nof output')

		const [long] = parseMessage(row(resultFrame('toolu_1', 'x'.repeat(9000))))
		expect(long.output?.length).toBe(2001)
		expect(long.output?.endsWith('…')).toBe(true)
	})

	test('a failed result stays a row of its own as well as an output', () => {
		const [failed] = parseMessage(row(resultFrame('toolu_1', '<tool_use_error>no such file</tool_use_error>', true)))
		expect(failed.error).toBe(true)
		expect(failed.text).toBe('no such file')
		expect(failed.output).toBe('no such file')
	})

	test('an empty successful result is not a row', () => {
		expect(parseMessage(row(resultFrame('toolu_1', '   ')))).toEqual([])
	})
})

/**
 * Conductor stores a result in whatever shape the tool answered in, and only two of the
 * five shapes here used to be read. The other three rendered as nothing: an edit's diff,
 * the tools a search found, and every screenshot — each a step that looked like it did
 * nothing at all.
 */
describe('the shapes a result comes in', () => {
	test('an edit result becomes its status line and a diff', () => {
		const worktree = '/Users/example/conductor/workspaces/project/krakow'
		const content = { status: `update ${worktree}/src/a.ts`, diffString: '@@ -1,2 +1,2 @@\n-old\n+new\n' }
		const [entry] = parseMessage(row(resultFrame('toolu_1', content)), worktree)

		expect(entry.diff).toBe(true)
		expect(entry.output).toBe('update src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new')
	})

	test('a tool_reference list names the tools', () => {
		const content = [
			{ type: 'tool_reference', tool_name: 'navigate' },
			{ type: 'tool_reference', tool_name: 'read_page' }
		]
		const [entry] = parseMessage(row(resultFrame('toolu_1', content)))

		expect(entry.output).toBe('2 tools: navigate, read_page')
	})

	test('images travel as references, never as bytes', () => {
		const content = [
			{ type: 'text', text: 'captured' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
		]
		const [entry] = parseMessage(row(resultFrame('toolu_1', content), 42))

		expect(entry.output).toBe('captured')
		expect(entry.images).toEqual(['42.0'])
		expect(JSON.stringify(entry)).not.toContain('iVBORw0KGgo=')
	})

	test('an image-only result is still a row', () => {
		const content = [{ type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=' } }]
		const [entry] = parseMessage(row(resultFrame('toolu_1', content), 7))

		expect(entry.output).toBe('')
		expect(entry.images).toEqual(['7.0'])
	})

	test('an unknown shape falls back to its own JSON rather than to silence', () => {
		const [entry] = parseMessage(row(resultFrame('toolu_1', { total: 3, kind: 'summary' })))
		expect(entry.output).toBe('{"total":3,"kind":"summary"}')
	})

	test('image numbering is per row, and the lookup walks it the same way', () => {
		const frame = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_1',
						content: [{ type: 'image', source: { type: 'base64', data: 'iVBORfirst' } }]
					},
					{
						type: 'tool_result',
						tool_use_id: 'toolu_2',
						content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/second' } }]
					}
				]
			}
		})
		const entries = parseMessage(row(frame, 99))

		expect(entries.map(entry => entry.images)).toEqual([['99.0'], ['99.1']])
		// No media_type on the first block, so the base64 magic bytes name it.
		expect(toolImageAt(frame, 0)).toEqual({ mediaType: 'image/png', data: 'iVBORfirst' })
		expect(toolImageAt(frame, 1)).toEqual({ mediaType: 'image/jpeg', data: '/9j/second' })
		expect(toolImageAt(frame, 2)).toBeNull()
	})
})

describe('folding a result onto its call', () => {
	const entry = (e: Partial<TranscriptEntry>): TranscriptEntry => ({
		id: 'x',
		rowid: 1,
		role: 'tool',
		text: 'Bash',
		ts: '2026-09-01T00:00:00.000Z',
		queued: false,
		...e
	})
	const call = entry({ id: 'call', tool: 'Bash', toolUseId: 'toolu_1', detail: 'rg -n needle src' })
	const prose = entry({ id: 'said', role: 'assistant', text: 'Looking.' })

	test('an output arriving a tick later lands on the call', () => {
		const merged = mergeEntries(
			[prose, call],
			[entry({ id: 'result', toolUseId: 'toolu_1', text: 'src/a.ts:3', output: 'src/a.ts:3' })]
		)

		expect(merged).toHaveLength(2)
		expect(merged[1].output).toBe('src/a.ts:3')
		expect(merged[1].tool).toBe('Bash')
		expect(merged[1].detail).toBe('rg -n needle src')
	})

	test('a call and its result in one batch fold together', () => {
		const merged = mergeEntries([], [call, entry({ id: 'result', toolUseId: 'toolu_1', text: 'done', output: 'done' })])

		expect(merged).toHaveLength(1)
		expect(merged[0].output).toBe('done')
	})

	test('a failure marks the call it answers', () => {
		const merged = mergeEntries(
			[call],
			[entry({ id: 'result', toolUseId: 'toolu_1', text: 'boom', output: 'boom', error: true })]
		)

		expect(merged).toHaveLength(1)
		expect(merged[0].error).toBe(true)
		expect(merged[0].output).toBe('boom')
	})

	// Every row re-renders when its entry object changes, and this runs once a second.
	test('untouched entries come back as the same objects', () => {
		const other = entry({ id: 'other', tool: 'Read', toolUseId: 'toolu_2', detail: 'src/b.ts' })
		const merged = mergeEntries(
			[prose, other, call],
			[entry({ id: 'result', toolUseId: 'toolu_1', text: 'done', output: 'done' })]
		)

		expect(merged[0]).toBe(prose)
		expect(merged[1]).toBe(other)
		expect(merged[2]).not.toBe(call)
	})

	test('an unpaired failure is kept and an unpaired success is dropped', () => {
		const orphanError = entry({ id: 'e', toolUseId: 'toolu_missing', text: 'boom', output: 'boom', error: true })
		const orphanOk = entry({ id: 'o', toolUseId: 'toolu_missing', text: 'fine', output: 'fine' })

		expect(mergeEntries([prose], [orphanError])).toEqual([prose, orphanError])
		expect(mergeEntries([prose], [orphanOk])).toEqual([prose])
	})

	test('a diff and its images cross with the output', () => {
		const merged = mergeEntries(
			[call],
			[entry({ id: 'result', toolUseId: 'toolu_1', text: '', output: '@@ -1 +1 @@', diff: true, images: ['9.0'] })]
		)

		expect(merged[0].diff).toBe(true)
		expect(merged[0].images).toEqual(['9.0'])
	})

	test('a batch with no results is a plain append', () => {
		const merged = mergeEntries([prose], [call])
		expect(merged).toEqual([prose, call])
		expect(merged[1]).toBe(call)
	})
})

describe('rendering a transcript for a fork', () => {
	const entries = [
		...parseMessage(row(callFrame('toolu_1'))),
		...parseMessage(row(resultFrame('toolu_1', 'src/a.ts:3:needle'), 2, 'message-2')),
		...parseMessage(row(resultFrame('toolu_2', 'no such file', true), 3, 'message-3'))
	]

	test('prints the call and the failure, never a successful output', () => {
		const { text, elided } = renderTranscript(entries, { thinking: true, tools: true })

		expect(text).toContain('[Bash] Bash — `rg -n needle src`')
		expect(text).toContain('[error] no such file')
		expect(text).not.toContain('src/a.ts:3:needle')
		expect(elided.tools).toBe(0)
	})

	test('an output is not counted as an elided tool call', () => {
		const { text, elided } = renderTranscript(entries, { thinking: true, tools: false })

		expect(elided.tools).toBe(2)
		expect(text).toContain('[2 tool calls elided]')
	})
})
