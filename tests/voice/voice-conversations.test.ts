import { describe, expect, it } from 'vitest'
import type { SessionState } from '../../src/reads/types.ts'
import { currentConversations } from '../../src/voice/conversations.ts'
import type { ChatHistoryLink } from '../../src/wire.ts'

const state = (sessionId: string, overrides: Partial<SessionState> = {}): SessionState => ({
	sessionId,
	workspaceId: 'workspace',
	workspaceTitle: 'Workspace',
	repoName: 'relay',
	sessionTitle: 'Same title',
	status: 'needs_user_input',
	createdAt: '2026-09-02 10:00:00',
	updatedAt: '2026-09-02 11:00:00',
	lastUserMessageAt: '2026-09-02 10:00:00',
	turnStartedAt: '2026-09-02 10:00:00',
	...overrides
})
const link = (previousSessionId: string): ChatHistoryLink => ({
	previousSessionId,
	title: 'Same title',
	createdAt: '2026-09-02 10:00:00'
})
const successor = (overrides: Partial<SessionState> = {}) =>
	state('next', {
		status: 'working',
		createdAt: '2026-09-02 11:00:00',
		turnStartedAt: '2026-09-02 11:01:00',
		...overrides
	})
const ids = (states: SessionState[], links: Record<string, ChatHistoryLink> = { next: link('old') }) =>
	currentConversations(states, () => links).map(s => s.sessionId)

describe('current voice conversations', () => {
	it.each([
		'working',
		'idle',
		'error',
		'needs_user_input'
	])('suppresses a replaced context while its accepted successor is %s', status => {
		expect(ids([state('old'), successor({ status }), state('sibling')])).toEqual(['next', 'sibling'])
	})

	it('retains the predecessor until a successor turn is dispatched', () => {
		expect(ids([state('old'), successor({ turnStartedAt: null })])).toEqual(['old', 'next'])
		expect(ids([state('old')])).toEqual(['old'])
	})

	it('does not suppress a predecessor resumed after the successor was created', () => {
		expect(ids([state('old', { lastUserMessageAt: '2026-09-02 11:00:30' }), successor()])).toEqual(['old', 'next'])
		expect(ids([state('old', { status: 'working' }), successor()])).toEqual(['old', 'next'])
		expect(ids([state('old'), successor({ createdAt: undefined })])).toEqual(['old', 'next'])
	})

	it('walks repeated replacements and keeps an unaccepted newest context from retiring its parent', () => {
		const newest = state('newest', { createdAt: '2026-09-02 11:30:00', turnStartedAt: '2026-09-02 11:31:00' })
		const states = [state('old'), successor({ status: 'idle' }), newest]
		const links = { next: link('old'), newest: link('next') }
		expect(ids(states, links)).toEqual(['newest'])
		expect(ids([...states.slice(0, 2), { ...newest, turnStartedAt: null }], links)).toEqual(['next', 'newest'])
	})

	it('keeps work visible when history branches, cycles, or crosses workspaces', () => {
		const states = [state('old'), successor()]
		expect(ids(states, { next: link('old'), another: link('old') })).toEqual(['old', 'next'])
		expect(ids(states, { next: link('old'), old: link('next') })).toEqual(['old', 'next'])
		expect(ids([state('old'), successor({ workspaceId: 'other' })])).toEqual(['old', 'next'])
	})

	it('deduplicates session identity using the newest row, without merging matching titles', () => {
		const older = state('one', { updatedAt: '2026-09-02 10:00:00' })
		const newer = state('one', { status: 'working' })
		const result = currentConversations([older, state('two'), newer], () => ({}))
		expect(result.map(s => s.sessionId)).toEqual(['one', 'two'])
		expect(result[0].status).toBe('working')
	})
})
