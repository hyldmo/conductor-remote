import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { TranscriptEntry } from '../../src/wire.ts'

const { messages } = vi.hoisted(() => ({ messages: {} as Record<string, TranscriptEntry[]> }))
vi.mock('../../web/src/hooks/transcript.ts', () => ({
	useTranscript: (id: string) => ({ entries: messages[id] ?? [], loading: false, error: null })
}))
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })
const { TranscriptHistory } = await import('../../web/src/components/transcript/TranscriptHistory.tsx')
const entry = (id: string, rowid: number, text: string, role: 'user' | 'assistant'): TranscriptEntry => ({
	id,
	rowid,
	text,
	role,
	ts: '2026-09-01 12:00:00',
	queued: false
})

describe('inline conversation history', () => {
	test('renders actual old messages in order with an HR between contexts, including repeated compactions', () => {
		messages.first = [
			entry('u1', 1, 'The original question', 'user'),
			entry('a1', 2, 'The complete original answer', 'assistant')
		]
		messages.second = [
			entry('u2', 3, 'The follow-up question', 'user'),
			entry('a2', 4, 'The second answer', 'assistant')
		]
		const html = renderToStaticMarkup(
			<>
				<TranscriptHistory sessionId="first" />
				<TranscriptHistory sessionId="second" />
				<p>The newest live chat</p>
			</>
		)
		expect(html).toContain('The original question')
		expect(html).toContain('The complete original answer')
		expect(html).toContain('The follow-up question')
		expect(html.match(/<hr\b/g)).toHaveLength(2)
		expect(html.indexOf('The complete original answer')).toBeLessThan(html.indexOf('<hr'))
		expect(html.indexOf('The second answer')).toBeLessThan(html.lastIndexOf('<hr'))
		expect(html.lastIndexOf('<hr')).toBeLessThan(html.indexOf('The newest live chat'))
		expect(html).not.toContain('overflow-y-auto')
	})
})
