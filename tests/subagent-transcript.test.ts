import { describe, expect, test } from 'vitest'
import { parseMessage, type TranscriptEntry } from '../src/transcript.ts'
import { transcriptTree } from '../web/src/lib/transcript-tree.ts'

const row = (content: string, rowid: number, id = `message-${rowid}`) => ({
	rowid,
	id,
	role: 'assistant',
	content,
	full_message: null,
	created_at: `2026-09-03T19:15:${String(rowid).padStart(2, '0')}.000Z`,
	sent_at: `2026-09-03T19:15:${String(rowid).padStart(2, '0')}.000Z`,
	queue_order: null
})

const frame = (content: unknown[], parent_tool_use_id?: string) =>
	JSON.stringify({
		type: 'assistant',
		message: { role: 'assistant', content },
		...(parent_tool_use_id ? { parent_tool_use_id } : {})
	})

const textEntry = (id: string, rowid: number, text: string, parentToolUseId?: string): TranscriptEntry => ({
	id,
	rowid,
	role: 'assistant',
	text,
	ts: '2026-09-03T19:15:00.000Z',
	queued: false,
	...(parentToolUseId ? { parentToolUseId } : {})
})

describe('subagent transcript metadata', () => {
	test('labels a Codex collaboration call from its task path', () => {
		const [entry] = parseMessage(
			row(
				frame([
					{
						type: 'tool_use',
						id: 'call_rebase',
						name: 'collab__spawnAgent',
						input: { agent_nickname: 'Hypatia', agent_path: '/root/rebase_main' }
					}
				]),
				1
			)
		)

		expect(entry.subagentLabel).toBe('Rebase main')
		expect(entry.toolUseId).toBe('call_rebase')
	})

	test('uses a Claude Agent description and carries its parent id on every child entry', () => {
		const [call] = parseMessage(
			row(
				frame([
					{
						type: 'tool_use',
						id: 'toolu_explore',
						name: 'Agent',
						input: { description: 'Map the message renderer', prompt: 'Find the relevant files.' }
					}
				]),
				1
			)
		)
		const [child] = parseMessage(row(frame([{ type: 'text', text: 'I found the parser.' }], 'toolu_explore'), 2))

		expect(call.subagentLabel).toBe('Map the message renderer')
		expect(child).toMatchObject({ role: 'assistant', text: 'I found the parser.', parentToolUseId: 'toolu_explore' })
	})
})

describe('subagent transcript hierarchy', () => {
	test('moves interleaved child frames under their call and leaves parent speech at the root', () => {
		const spawn: TranscriptEntry = {
			...textEntry('spawn', 1, 'collab__spawnAgent'),
			role: 'tool',
			tool: 'collab__spawnAgent',
			toolUseId: 'call_rebase',
			subagentLabel: 'Rebase main'
		}
		const childStart = textEntry('child-start', 2, 'I am taking the rebase.', 'call_rebase')
		const parentUpdate = textEntry('parent-update', 3, 'I am checking the model picker.')
		const childUpdate = textEntry('child-update', 4, 'The rebase succeeded.', 'call_rebase')

		const tree = transcriptTree([spawn, childStart, parentUpdate, childUpdate])

		expect(tree.map(node => node.e.id)).toEqual(['spawn', 'parent-update'])
		expect(tree[0].children.map(node => node.e.id)).toEqual(['child-start', 'child-update'])
	})

	test('nests a subagent spawned by another subagent and keeps unknown parents visible', () => {
		const root: TranscriptEntry = {
			...textEntry('root', 1, 'Agent'),
			role: 'tool',
			tool: 'Agent',
			toolUseId: 'root-call',
			subagentLabel: 'Review'
		}
		const nested: TranscriptEntry = {
			...textEntry('nested', 2, 'Agent', 'root-call'),
			role: 'tool',
			tool: 'Agent',
			toolUseId: 'nested-call',
			subagentLabel: 'Inspect tests'
		}
		const grandchild = textEntry('grandchild', 3, 'Tests are green.', 'nested-call')
		const orphan = textEntry('orphan', 4, 'Do not lose me.', 'unknown-call')

		const tree = transcriptTree([root, nested, grandchild, orphan])

		expect(tree.map(node => node.e.id)).toEqual(['root', 'orphan'])
		expect(tree[0].children[0].e.id).toBe('nested')
		expect(tree[0].children[0].children[0].e.id).toBe('grandchild')
	})
})
