import { describe, expect, it, vi } from 'vitest'
import type { Prefs, PrefsPatch } from '../../src/prefs.ts'
import type { SessionState, Workspace } from '../../src/reads/types.ts'
import {
	parseProseDecision,
	parseStructuredQuestion,
	VoiceBriefBoard,
	type VoiceBriefReads
} from '../../src/voice/brief.ts'
import type { ChatHistoryLink } from '../../src/wire.ts'

const NOW = Date.parse('2026-09-02T12:00:00Z')

function state(id: string, status: string, updatedAt: string, overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: id,
		workspaceId: `w-${id}`,
		status,
		updatedAt,
		turnStartedAt: null,
		lastUserMessageAt: null,
		workspaceTitle: `Workspace ${id}`,
		repoName: 'relay',
		sessionTitle: null,
		...overrides
	}
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
	return {
		id: `w-${id}`,
		directory_name: id,
		workspace_name: `Workspace ${id}`,
		branch: id,
		pr_title: null,
		derived_status: 'in_progress',
		manual_status: null,
		state: 'ready',
		created_at: '2026-08-01 00:00:00',
		updated_at: '2026-09-02 00:00:00',
		pinned_at: null,
		active_session_id: id,
		intended_target_branch: null,
		repo_name: 'relay',
		repo_root: null,
		repo_icon: null,
		remote_url: null,
		default_branch: 'main',
		session_status: 'idle',
		session_title: null,
		model: null,
		agent_type: null,
		unread_sessions: [],
		worktree: null,
		baseBranch: 'main',
		icon: null,
		...overrides
	}
}

function boardFor(
	states: SessionState[],
	messages: Record<string, string> = {},
	workspaces?: Workspace[],
	links: Record<string, ChatHistoryLink> = {}
) {
	return new VoiceBriefBoard({
		chatHistory: () => links,
		reads: {
			listWorkspaces: () => workspaces ?? states.map(s => workspace(s.sessionId)),
			listSessionStates: () => states,
			lastAssistantText: id => messages[id] ?? 'The work is complete.',
			lastQuestionInput: () => null
		},
		locked: async () => false,
		readPrefs: () => ({ readMarks: {}, drafts: {} }),
		writePrefs: () => ({ readMarks: {}, drafts: {} }),
		now: () => NOW
	})
}

describe('voice decision parsing', () => {
	it('extracts the gstack decision brief grammar and its recommendation', () => {
		const parsed = parseProseDecision(`The listener is built, but no process starts it yet.

## D6 — Which piece should land next?

A. Brief builder — gives the call something useful to say.
B. Broker — opens the observer socket. (recommended)
C. Funnel — puts the route on the air.

Recommendation: B, because the observer socket is the long pole.`)
		expect(parsed).toEqual({
			situation: 'The listener is built, but no process starts it yet.',
			question: 'Which piece should land next?',
			options: [
				'A. Brief builder — gives the call something useful to say.',
				'B. Broker — opens the observer socket. (recommended)',
				'C. Funnel — puts the route on the air.'
			],
			consequence: 'B, because the observer socket is the long pole.'
		})
	})

	it('falls back to the first structured AskUserQuestion prompt', () => {
		expect(
			parseStructuredQuestion({
				questions: [
					{
						question: 'Ship this now?',
						options: [
							{ label: 'Ship', description: 'Deploys the current branch.' },
							{ label: 'Wait', description: 'Leaves production unchanged.' }
						]
					}
				]
			})
		).toEqual({
			situation: '',
			question: 'Ship this now?',
			options: ['A. Ship — Deploys the current branch.', 'B. Wait — Leaves production unchanged.'],
			consequence: ''
		})
	})
})

describe('VoiceBriefBoard', () => {
	it('lists newest work first and separates idle follow-ups from explicit waits and unread updates', async () => {
		const states = [
			state('yesterday-error', 'error', '2026-09-01 12:00:00'),
			state('running', 'working', '2026-09-02 11:59:00'),
			state('question', 'idle', '2026-09-02 11:58:00'),
			state('unread', 'idle', '2026-09-02 11:57:00')
		]
		const board = boardFor(
			states,
			{
				question: 'The checks pass. Should I merge the PR?'
			},
			states.map(s =>
				workspace(s.sessionId, {
					unread_sessions: [{ id: s.sessionId, at: s.updatedAt }]
				})
			)
		)
		const first = await board.workspaceOverview()
		expect(first.workspaces.map(item => item.sessionId)).toEqual(['running', 'question', 'unread'])
		expect(first.waitingForYou).toBe(0)
		expect(first.waitingChatCount).toBe(0)
		expect(first.possibleFollowUpCount).toBe(1)
		expect(first.workspaces[1]).toMatchObject({
			waitingForYou: null,
			possibleFollowUps: [{ sessionId: 'question', question: 'Should I merge the PR?' }]
		})
		expect(first.spoken).toContain('Possible follow-up: Should I merge the PR?')
		expect(first.workspaces[2].waitingForYou).toBeNull()
		expect((await board.workspaceOverview(first.cursor ?? 0)).workspaces.map(item => item.sessionId)).toEqual([
			'yesterday-error'
		])
		expect(
			(await board.workspaceOverview(0, { agentStatus: 'needs-you' })).workspaces.map(item => item.sessionId)
		).toEqual([])
	})

	it('keeps a sibling chat waiting for input visible beside newer running work', async () => {
		const states = [
			state('running', 'working', '2026-09-02 11:59:00', { workspaceId: 'w-shared' }),
			state('waiting', 'needs_user_input', '2026-09-02 11:40:00', {
				workspaceId: 'w-shared',
				sessionTitle: 'API decision'
			})
		]
		const board = boardFor(states, { waiting: 'Which API should I use?' }, [workspace('shared')])
		const overview = await board.workspaceOverview()
		expect(overview).toMatchObject({ current: 1, waitingForYou: 1 })
		expect(overview.workspaces[0]).toMatchObject({
			sessionId: 'running',
			status: 'is working',
			updatedAt: '2026-09-02 11:59:00',
			waitingForYou: { sessionId: 'waiting', chatTitle: 'API decision', question: 'Which API should I use?' }
		})
		expect(overview.spoken).toContain('API decision is waiting for you. Which API should I use?')
	})

	it('names waiting work beyond the latest page without displacing newer activity', async () => {
		const states = [
			...['one', 'two', 'three'].map((id, index) => state(id, 'working', `2026-09-02 11:5${9 - index}:00`)),
			state('waiting', 'needs_user_input', '2026-09-02 10:00:00')
		]
		const overview = await boardFor(states, { waiting: 'May I ship?' }).workspaceOverview()
		expect(overview.workspaces.map(item => item.sessionId)).toEqual(['one', 'two', 'three'])
		expect(overview.waitingForYou).toBe(1)
		expect(overview.waiting).toMatchObject([
			{ sessionId: 'waiting', workspaceId: 'w-waiting', question: 'May I ship?' }
		])
	})

	it('counts and independently pages every waiting sibling without duplicating session rows', async () => {
		const states = [
			state('running', 'working', '2026-09-02 11:59:00', { workspaceId: 'w-shared' }),
			...['one', 'two', 'three', 'four', 'five'].map((id, index) =>
				state(id, 'needs_user_input', `2026-09-02 11:5${8 - index}:00`, {
					workspaceId: 'w-shared',
					sessionTitle: 'Same title'
				})
			),
			state('follow-up', 'idle', '2026-09-02 11:50:00', { workspaceId: 'w-shared' })
		]
		const board = boardFor([...states, states[1]], { 'follow-up': 'Anything else?' }, [workspace('shared')])
		const first = await board.workspaceOverview()
		expect(first).toMatchObject({
			current: 1,
			waitingForYou: 1,
			waitingChatCount: 5,
			possibleFollowUpCount: 1,
			cursor: null,
			waitingCursor: 3
		})
		expect(first.workspaces[0]).toMatchObject({
			chatCount: 7,
			workingCount: 1,
			waitingCount: 5,
			possibleFollowUpCount: 1
		})
		expect(first.waiting.map(chat => chat.sessionId)).toEqual(['one', 'two', 'three'])
		const second = await board.workspaceOverview(0, {}, first.waitingCursor!)
		expect(second.waiting.map(chat => chat.sessionId)).toEqual(['four', 'five'])
		expect(second.waitingCursor).toBeNull()
		expect(second.waitingChatCount).toBe(5)
		const filtered = await board.workspaceOverview(0, { agentStatus: 'needs-you' })
		expect(filtered.workspaces[0]).toMatchObject({
			chatCount: 5,
			workingCount: 0,
			waitingCount: 5,
			possibleFollowUpCount: 0
		})
		expect((await board.workspaceOverview(0, {}, -5)).waiting).toEqual(first.waiting)
		expect((await board.workspaceOverview(0, {}, 100)).waiting).toEqual([])
	})

	it('resolves accepted successors before needs-you, date, and dormancy filters', async () => {
		const old = state('old', 'needs_user_input', '2026-09-02 10:00:00', { workspaceId: 'w-shared' })
		const next = state('next', 'working', '2026-09-02 11:59:00', {
			workspaceId: 'w-shared',
			createdAt: '2026-09-02 11:00:00',
			turnStartedAt: '2026-09-02 11:01:00'
		})
		const links = { next: { previousSessionId: 'old', title: 'Original', createdAt: '2026-09-01 00:00:00' } }
		const board = boardFor([old, next], { old: 'May I ship?' }, [workspace('shared')], links)
		expect((await board.workspaceOverview()).workspaces[0]).toMatchObject({
			sessionId: 'next',
			chatCount: 1,
			waitingCount: 0
		})
		expect((await board.workspaceOverview(0, { agentStatus: 'needs-you' })).current).toBe(0)
		expect((await board.workspaceOverview(0, { updatedBefore: '2026-09-02T11:00:00Z' })).current).toBe(0)
		expect((await board.workspaceOverview(0, { includeDormant: true })).waitingChatCount).toBe(0)
		expect((await board.rollCall()).queue).toEqual([])
	})

	it('skips cached decisions replaced or resumed since the roll call', async () => {
		const old = state('old', 'needs_user_input', '2026-09-02 10:00:00', { workspaceId: 'w-shared' })
		const next = state('next', 'working', '2026-09-02 11:59:00', { workspaceId: 'w-shared' })
		const sibling = state('sibling', 'needs_user_input', '2026-09-02 09:00:00', { workspaceId: 'w-shared' })
		const links: Record<string, ChatHistoryLink> = {}
		const board = boardFor([old, next, sibling], {}, [workspace('shared')], links)
		expect((await board.rollCall()).queue.map(chat => chat.sessionId)).toEqual(['old', 'sibling'])
		links.next = { previousSessionId: 'old', title: 'Original', createdAt: '2026-09-01 00:00:00' }
		next.turnStartedAt = '2026-09-02 11:01:00'
		expect(await board.nextDecision()).toMatchObject({ sessionId: 'sibling', cursor: 2 })
		sibling.status = 'working'
		expect(await board.nextDecision()).toBeNull()
	})

	it('ages errors and input waits out too, preserves running work, and can explicitly recover older work', async () => {
		const states = ['idle', 'error', 'needs_user_input', 'needs_plan_response', 'working'].map(status =>
			state(status, status, '2026-08-28 12:00:00')
		)
		const board = boardFor(states)
		const overview = await board.workspaceOverview()
		expect(overview).toMatchObject({ current: 1, dormant: 4, waitingForYou: 0 })
		expect(overview.workspaces.map(item => item.sessionId)).toEqual(['working'])
		expect(await board.rollCall()).toMatchObject({ working: 1, needsYou: 0, dormant: 4, queue: [] })
		expect((await board.workspaceOverview(0, { includeDormant: true })).current).toBe(5)
		expect(
			(await board.workspaceOverview(0, { updatedSince: '2026-08-28', updatedBefore: '2026-08-29' })).current
		).toBe(5)
	})

	it('lets recent activity outrank an old error in the decision queue as relevance halves each day', async () => {
		const states = [
			state('old-error', 'error', '2026-08-31 12:00:00'),
			state('question', 'idle', '2026-09-02 11:58:00'),
			state('unread', 'idle', '2026-09-02 11:57:00')
		]
		const board = boardFor(
			states,
			{ question: 'May I deploy?' },
			states.map(s =>
				workspace(s.sessionId, {
					unread_sessions: [{ id: s.sessionId, at: s.updatedAt }]
				})
			)
		)
		const roll = await board.rollCall()
		expect(roll.queue.map(item => item.sessionId)).toEqual(['question', 'unread', 'old-error'])
		expect(roll.needsYou).toBe(1)
		expect((await board.nextDecision())?.spoken).toContain('Possible follow-up: May I deploy?')
	})

	it('does not resurrect a historical structured question after an idle chat finishes', async () => {
		const lastQuestionInput = vi.fn(() => ({
			questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }]
		}))
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => [workspace('finished'), workspace('waiting')],
				listSessionStates: () => [
					state('finished', 'idle', '2026-09-02 11:59:00'),
					state('waiting', 'needs_plan_response', '2026-09-02 11:58:00')
				],
				lastAssistantText: () => 'All done.',
				lastQuestionInput
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})
		const overview = await board.workspaceOverview(0, { agentStatus: 'needs-you' })
		expect(overview.workspaces.map(item => item.sessionId)).toEqual(['waiting'])
		expect(overview.workspaces[0].waitingForYou?.question).toBe('Ship?')
		expect(lastQuestionInput.mock.calls).toEqual([['waiting']])
	})

	it('builds a fresh overview of current workspaces with their latest agent updates', async () => {
		const active = state('active', 'working', '2026-09-02 11:45:00')
		const old = state('old', 'idle', '2026-08-20 00:00:00')
		let update = 'The first implementation pass is running.'
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => [workspace('active'), workspace('old')],
				listSessionStates: () => [active, old],
				lastAssistantText: id => (id === 'active' ? update : 'This workspace is already parked.'),
				lastQuestionInput: () => null
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const first = await board.workspaceOverview()
		expect(first.asOf).toBe('2026-09-02T12:00:00.000Z')
		expect(first.spoken).toContain('1 current workspace, 1 dormant')
		expect(first.spoken).toContain(
			'Workspace active is working. Updated 15 minutes ago. The first implementation pass is running.'
		)
		expect(first.spoken).not.toContain('already parked')
		expect(first.spoken.length).toBeLessThanOrEqual(700)

		update = 'The tests are green and the build is finishing.'
		const refreshed = await board.workspaceOverview()
		expect(refreshed.spoken).toContain('The tests are green and the build is finishing.')
		expect(refreshed.spoken).not.toContain('first implementation pass')
	})

	it('groups chats by workspace and pages a long current overview', async () => {
		const states = [
			state('one', 'working', '2026-09-02 11:55:00'),
			state('one-extra', 'idle', '2026-09-02 11:50:00', { workspaceId: 'w-one' }),
			state('two', 'working', '2026-09-02 11:45:00'),
			state('three', 'working', '2026-09-02 11:40:00'),
			state('four', 'working', '2026-09-02 11:35:00')
		]
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => ['one', 'two', 'three', 'four'].map(id => workspace(id)),
				listSessionStates: () => states,
				lastAssistantText: id => `Latest update from ${id}.`,
				lastQuestionInput: () => null
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const first = await board.workspaceOverview()
		expect(first.current).toBe(4)
		expect(first.workspaces).toHaveLength(3)
		expect(first.cursor).toBe(3)
		const second = await board.workspaceOverview(first.cursor ?? 0)
		expect(second.workspaces.map(item => item.workspaceId)).toEqual(['w-four'])
		expect(second.cursor).toBeNull()
	})

	it('hides done and merged workspaces by default and includes them only when requested', async () => {
		const states = [
			state('active', 'working', '2026-09-02 11:45:00'),
			state('done', 'working', '2026-09-02 11:40:00'),
			state('merged', 'working', '2026-09-02 11:35:00'),
			state('both', 'working', '2026-09-02 11:30:00')
		]
		const workspaces = [
			workspace('active'),
			workspace('done', { manual_status: 'done' }),
			workspace('merged', { pr_status: 'merged' }),
			workspace('both', { manual_status: 'done', pr_status: 'merged' })
		]
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => workspaces,
				listSessionStates: () => states,
				lastAssistantText: id => `Latest update from ${id}.`,
				lastQuestionInput: () => null
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const ordinary = await board.workspaceOverview()
		expect(ordinary.workspaces.map(item => item.workspaceId)).toEqual(['w-active'])
		expect(ordinary.completed).toBe(3)
		expect(ordinary.spoken).toContain('3 completed hidden')

		const all = await board.workspaceOverview(0, { includeDone: true, includeMerged: true })
		expect(all.current).toBe(4)
		expect(all.completed).toBe(0)
		expect(all.workspaces.map(item => item.workspaceId)).toEqual(['w-active', 'w-done', 'w-merged'])
	})

	it('filters an overview by dates, repo, agent status, and workspace status', async () => {
		const states = [
			state('recent', 'working', '2026-09-02 11:45:00', { repoName: 'relay' }),
			state('idle', 'idle', '2026-09-02 10:00:00', { repoName: 'relay' }),
			state('yesterday', 'working', '2026-09-01 10:00:00', { repoName: 'relay' }),
			state('other', 'working', '2026-09-02 11:50:00', { repoName: 'another-repo' })
		]
		const workspaces = [
			workspace('recent', { manual_status: 'in-review' }),
			workspace('idle', { manual_status: 'in-review' }),
			workspace('yesterday', { manual_status: 'in-review' }),
			workspace('other', { repo_name: 'another-repo', manual_status: 'in-review' })
		]
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => workspaces,
				listSessionStates: () => states,
				lastAssistantText: id => `Latest update from ${id}.`,
				lastQuestionInput: () => null
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const overview = await board.workspaceOverview(0, {
			updatedSince: 'today',
			repo: 'relay',
			agentStatus: 'working',
			workspaceStatus: 'in-review'
		})
		expect(overview.current).toBe(1)
		expect(overview.filtered).toBe(3)
		expect(overview.workspaces.map(item => item.workspaceId)).toEqual(['w-recent'])
		expect(overview.spoken).toContain('Updated 15 minutes ago.')

		const yesterday = await board.workspaceOverview(0, {
			updatedSince: 'yesterday',
			updatedBefore: 'today',
			repo: 'relay'
		})
		expect(yesterday.workspaces.map(item => item.workspaceId)).toEqual(['w-yesterday'])

		await expect(board.workspaceOverview(0, { updatedSince: 'whenever' })).rejects.toThrow(/updated_since/i)
	})

	it.each<{ label: string; completion: Partial<Workspace> }>([
		{ label: 'manual Done', completion: { manual_status: 'done' } },
		{ label: 'derived Done', completion: { derived_status: 'done' } },
		{ label: 'merged', completion: { pr_status: 'merged' } },
		{ label: 'Done and merged', completion: { manual_status: 'done', pr_status: 'merged' } }
	])('excludes $label workspaces from every roll-call count and decision', async ({ completion }) => {
		const finished = ['working', 'idle', 'error', 'needs_user_input', 'needs_plan_response'].map(status =>
			state(`finished-${status}`, status, '2026-09-02 11:50:00')
		)
		const states = [
			...finished,
			state('working', 'working', '2026-09-02 11:45:00'),
			state('attention', 'needs_user_input', '2026-09-02 11:40:00'),
			state('old', 'idle', '2026-08-20 00:00:00')
		]
		const lastAssistantText = vi.fn(() => 'May I start Docker Desktop?')
		const lastQuestionInput = vi.fn(() => null)
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => [
					...finished.map(s =>
						workspace(s.sessionId, { ...completion, unread_sessions: [{ id: s.sessionId, at: s.updatedAt }] })
					),
					workspace('working'),
					workspace('attention'),
					workspace('old')
				],
				listSessionStates: () => states,
				lastAssistantText,
				lastQuestionInput
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		// A decision request can also be the first tool used in a call.
		expect((await board.nextDecision())?.sessionId).toBe('attention')
		const roll = await board.rollCall()
		expect(roll).toMatchObject({ working: 1, needsYou: 1, dormant: 1 })
		expect(roll.spoken).toContain('1 working, 1 need you, 1 dormant')
		expect(roll.spoken).not.toContain('finished')
		expect(roll.queue.map(item => item.sessionId)).toEqual(['attention'])
		expect(await board.nextDecision(1)).toBeNull()
		// Finished conversations should not be read into the call at all.
		expect(lastAssistantText.mock.calls).toEqual([['attention'], ['attention']])
		expect(lastQuestionInput.mock.calls).toEqual([['attention'], ['attention']])
	})

	it('skips work completed during a call without shifting the remaining decision cursors', async () => {
		const states = ['first', 'done', 'next', 'merged'].map((id, index) =>
			state(id, 'needs_user_input', `2026-09-02 11:5${9 - index}:00`)
		)
		const workspaces = states.map(s => workspace(s.sessionId))
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => workspaces,
				listSessionStates: () => states,
				lastAssistantText: () => 'May I continue?',
				lastQuestionInput: () => null
			},
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const roll = await board.rollCall()
		expect(roll.queue.map(item => item.sessionId)).toEqual(['first', 'done', 'next', 'merged'])
		const first = await board.nextDecision()
		expect(first).toMatchObject({ sessionId: 'first', cursor: 1 })

		workspaces[1].manual_status = 'done'
		workspaces[3].pr_status = 'merged'
		const next = await board.nextDecision(first?.cursor)
		expect(next).toMatchObject({ sessionId: 'next', cursor: 3 })
		expect(await board.nextDecision(next?.cursor)).toBeNull()
	})

	it('ranks live signals, excludes dormant work, and bounds spoken output', async () => {
		const states = [
			state('recent', 'idle', '2026-09-02 10:00:00'),
			state('unread', 'idle', '2026-09-02 09:00:00'),
			state('question', 'idle', '2026-09-02 08:00:00'),
			state('input', 'needs_user_input', '2026-09-02 07:00:00'),
			state('error', 'error', '2026-09-02 06:00:00'),
			state('working', 'working', '2026-09-02 11:00:00'),
			state('old', 'idle', '2026-08-20 00:00:00')
		]
		const workspaces = states.map(s =>
			workspace(s.sessionId, {
				unread_sessions: s.sessionId === 'unread' ? [{ id: 'unread', at: s.updatedAt }] : []
			})
		)
		const messages: Record<string, string> = {
			error: 'The build failed in the release step.',
			input: 'Please choose the target.',
			question:
				'The API is ready.\n\nD7 — Which endpoint?\n\nA. Public\nB. Private (recommended)\n\nRecommendation: B.',
			unread: 'Finished the refactor.',
			recent: 'Everything is ready.'
		}
		const reads: VoiceBriefReads = {
			listWorkspaces: () => workspaces,
			listSessionStates: () => states,
			lastAssistantText: id => messages[id] ?? null,
			lastQuestionInput: () => null
		}
		const board = new VoiceBriefBoard({
			reads,
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} }),
			now: () => NOW
		})

		const roll = await board.rollCall()
		expect(roll.spoken.startsWith('Mac is unlocked; sends can land.')).toBe(true)
		expect(roll.spoken).toContain('1 working, 2 need you, 1 dormant')
		expect(roll.spoken.length).toBeLessThanOrEqual(600)
		expect(roll.queue.map(q => q.sessionId)).toEqual(['input', 'error', 'unread', 'question', 'recent'])

		const decision = await board.nextDecision()
		expect(decision?.sessionId).toBe('input')
		expect((await board.nextDecision(3))?.spoken).toContain('Possible follow-up: Which endpoint?')
		expect(decision?.spoken.length).toBeLessThanOrEqual(400)
	})

	it('uses the Mac lock wording and writes a read mark only after an item is handled', async () => {
		const s = state('choice', 'needs_plan_response', '2026-09-02 11:30:00')
		let prefs: Prefs = { readMarks: {}, drafts: {} }
		const writes: PrefsPatch[] = []
		const board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => [workspace('choice')],
				listSessionStates: () => [s],
				lastAssistantText: () => 'Choose A or B.',
				lastQuestionInput: () => null
			},
			locked: async () => true,
			readPrefs: () => prefs,
			writePrefs: patch => {
				writes.push(patch)
				prefs = { ...prefs, readMarks: { ...prefs.readMarks, ...patch.readMarks } }
				return prefs
			},
			now: () => NOW
		})

		expect((await board.rollCall()).spoken).toMatch(/^Mac is locked; sends will park\./)
		const item = await board.nextDecision()
		expect(item?.sessionId).toBe('choice')
		expect(writes).toHaveLength(0)
		board.markHandled('choice')
		expect(writes).toEqual([{ readMarks: { choice: '2026-09-02 11:30:00' } }])
	})
})
