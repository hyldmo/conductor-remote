import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../src/transcript.ts'
import type { TranscriptNode } from '../web/src/lib/transcript-tree.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { SubagentEntry } = await import('../web/src/components/Transcript.tsx')

const entry = (patch: Partial<TranscriptEntry>): TranscriptEntry => ({
	id: 'entry',
	rowid: 1,
	role: 'assistant',
	text: 'text',
	ts: '2026-09-03T19:15:00.000Z',
	queued: false,
	...patch
})

describe('subagent transcript rendering', () => {
	test('draws the labelled child transcript under a rail and hides collaboration bookkeeping', () => {
		const node: TranscriptNode = {
			e: entry({
				role: 'tool',
				tool: 'collab__spawnAgent',
				toolUseId: 'call_rebase',
				subagentLabel: 'Rebase main',
				output: '{"status":"completed","receiverThreadIds":["thread-1"]}'
			}),
			children: [{ e: entry({ id: 'child', text: 'The rebase is clean.' }), children: [] }]
		}

		const html = renderToStaticMarkup(<SubagentEntry node={node} />)

		expect(html).toContain('data-subagent="Rebase main"')
		expect(html).toContain('>Agent<')
		expect(html).toContain('The rebase is clean.')
		expect(html).toContain('border-l')
		expect(html).not.toContain('receiverThreadIds')
	})

	test('renders the final report returned by a synchronous Claude Agent', () => {
		const node: TranscriptNode = {
			e: entry({
				role: 'tool',
				tool: 'Agent',
				toolUseId: 'toolu_explore',
				subagentLabel: 'Inspect parser',
				output: '**Found it.**'
			}),
			children: []
		}

		const html = renderToStaticMarkup(<SubagentEntry node={node} />)

		expect(html).toContain('data-subagent-result="true"')
		expect(html).toContain('<strong>Found it.</strong>')
	})
})
