import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../../src/transcript/parser.ts'
import type { TranscriptNode } from '../../web/src/lib/transcript/tree.ts'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { SubagentEntry, SubagentResult } = await import('../../web/src/components/transcript/entries.tsx')

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
	test('leaves a compact doorway in the parent instead of duplicating the child transcript', () => {
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

		const html = renderToStaticMarkup(<SubagentEntry node={node} onOpen={() => {}} />)

		expect(html).toContain('data-subagent="Rebase main"')
		expect(html).toContain('>Agent<')
		expect(html).toContain('aria-label="Open agent Rebase main"')
		expect(html).toContain('>Open<')
		expect(html).not.toContain('The rebase is clean.')
		expect(html).not.toContain('receiverThreadIds')
	})

	test('renders a synchronous Claude report only in the selected child view', () => {
		const html = renderToStaticMarkup(<SubagentResult text="**Found it.**" />)

		expect(html).toContain('data-subagent-result="true"')
		expect(html).toContain('<strong>Found it.</strong>')
	})
})
