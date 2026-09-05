import { describe, expect, test } from 'vitest'
import {
	type ContextMessageRow,
	estimateContextCategories,
	estimateTextTokens
} from '../../src/transcript/context-breakdown.ts'

const sdk = (type: string, content: unknown[] = [], subtype?: string): ContextMessageRow => ({
	// Conductor stores every raw SDK frame under the assistant role; the frame's own
	// type distinguishes assistant output from user-shaped tool plumbing.
	role: 'assistant',
	content: JSON.stringify({ type, ...(subtype ? { subtype } : {}), message: { content } })
})

const result = (): ContextMessageRow => ({ role: 'result', content: JSON.stringify({ type: 'result' }) })

function total(categories: ReturnType<typeof estimateContextCategories>['categories']): number {
	return categories.initial + categories.chat + categories.thinking + categories.tools
}

describe('context category estimates', () => {
	test('separates chat, thinking, and tool traffic while preserving the exact total', () => {
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: 'Please inspect this.' },
				sdk('assistant', [
					{ type: 'thinking', thinking: 'I should inspect the relevant source first.' },
					{ type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
					{ type: 'text', text: 'The issue is in the parser.' }
				]),
				sdk('user', [{ type: 'tool_result', content: 'export const answer = 42' }]),
				result()
			],
			500
		)

		expect(estimated.compacted).toBe(false)
		expect(estimated.categories.chat).toBeGreaterThan(0)
		expect(estimated.categories.thinking).toBeGreaterThan(0)
		expect(estimated.categories.tools).toBeGreaterThan(0)
		expect(estimated.categories.initial).toBeGreaterThan(0)
		expect(total(estimated.categories)).toBe(500)
	})

	test('starts at the latest completed compaction boundary', () => {
		const estimated = estimateContextCategories(
			[
				sdk('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(4_000) } }]),
				sdk('system', [], 'compact_boundary'),
				{ role: 'user', content: 'Continue from the summary.' },
				sdk('assistant', [{ type: 'text', text: 'Done.' }]),
				result()
			],
			200
		)

		expect(estimated.compacted).toBe(true)
		expect(estimated.categories.tools).toBe(0)
		expect(estimated.categories.chat).toBeGreaterThan(0)
		expect(total(estimated.categories)).toBe(200)
	})

	test('does not mix a streaming turn into the previous completed total', () => {
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: 'Finished prompt' },
				sdk('assistant', [{ type: 'text', text: 'Finished answer' }]),
				result(),
				sdk('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: 'large'.repeat(2_000) } }])
			],
			100
		)

		expect(estimated.categories.tools).toBe(0)
		expect(total(estimated.categories)).toBe(100)
	})

	test('does not mistake an embedded subagent result for the parent turn boundary', () => {
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: 'Parent prompt' },
				sdk('assistant', [{ type: 'text', text: 'Parent answer' }]),
				result(),
				{
					role: 'result',
					content: JSON.stringify({ type: 'result', parent_tool_use_id: 'tool-child' })
				},
				sdk('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: 'child-only' } }])
			],
			100
		)

		expect(estimated.categories.tools).toBe(0)
		expect(total(estimated.categories)).toBe(100)
	})

	test('does not charge a delegated child’s internal frames to the parent context', () => {
		const childTool = {
			role: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				parent_tool_use_id: 'tool-child',
				message: {
					content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x'.repeat(20_000) } }]
				}
			})
		}
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: 'Delegate this.' },
				sdk('assistant', [{ type: 'tool_use', name: 'Agent', input: { prompt: 'Inspect it.' } }]),
				childTool,
				sdk('user', [{ type: 'tool_result', content: 'The child found one issue.' }]),
				sdk('assistant', [{ type: 'text', text: 'There is one issue.' }]),
				result()
			],
			1_000
		)

		expect(estimated.categories.tools).toBeLessThan(100)
		expect(estimated.categories.initial).toBeGreaterThan(800)
		expect(total(estimated.categories)).toBe(1_000)
	})

	test('excludes opaque reasoning signatures and proportionally fits tokenizer overshoot', () => {
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: 'x'.repeat(400) },
				sdk('assistant', [
					{ type: 'thinking', thinking: 'y'.repeat(400), signature: 's'.repeat(40_000) },
					{ type: 'tool_use', name: 'Bash', input: { command: 'z'.repeat(400) } }
				]),
				result()
			],
			10
		)

		expect(estimated.categories.initial).toBe(0)
		expect(estimated.categories.chat).toBeGreaterThan(0)
		expect(estimated.categories.thinking).toBeGreaterThan(0)
		expect(estimated.categories.tools).toBeGreaterThan(0)
		expect(total(estimated.categories)).toBe(10)
	})

	test('keeps a human JSON prompt in chat instead of treating it as an SDK frame', () => {
		const estimated = estimateContextCategories(
			[
				{ role: 'user', content: JSON.stringify({ task: 'inspect this object', depth: 2 }) },
				sdk('assistant', [{ type: 'text', text: 'I inspected it.' }]),
				result()
			],
			100
		)

		expect(estimated.categories.chat).toBeGreaterThan(10)
		expect(total(estimated.categories)).toBe(100)
	})

	test('does not count embedded data URIs as ordinary tool prose', () => {
		const withoutBinary = estimateContextCategories(
			[
				sdk('assistant', [
					{
						type: 'tool_use',
						name: 'InspectImage',
						input: { image_url: `data:image/png;base64,${'x'.repeat(40_000)}` }
					}
				]),
				result()
			],
			20_000
		)

		expect(withoutBinary.categories.tools).toBeLessThan(100)
		expect(withoutBinary.categories.initial).toBeGreaterThan(19_000)
	})

	test('uses UTF-8 bytes for fork payload estimates', () => {
		expect(estimateTextTokens('1234')).toBe(1)
		expect(estimateTextTokens('🙂')).toBe(1)
	})

	test('excludes MCP images serialized as JSON text in a tool result', () => {
		const estimated = estimateContextCategories(
			[
				sdk('user', [
					{
						type: 'tool_result',
						content: JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(400_000) }] })
					}
				]),
				result()
			],
			200_000
		)
		expect(estimated.categories.tools).toBeLessThan(100)
		expect(total(estimated.categories)).toBe(200_000)
	})
})
