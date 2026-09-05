import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '../../src/mcp/types.ts'
import type { SessionState } from '../../src/reads/types.ts'
import { VoiceBriefBoard } from '../../src/voice/brief.ts'
import type { VoiceCallTarget, VoiceChatContext } from '../../src/voice/context.ts'
import type { SendPreview, WorkspacePreview } from '../../src/voice/preview.ts'
import { PreviewStore } from '../../src/voice/preview.ts'
import { VoiceRecall } from '../../src/voice/recall.ts'
import { createVoiceTools, type VoiceDispatchResult, type VoiceWorkspaceCreateResult } from '../../src/voice/tools.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tool(tools: Tool[], name: string): Tool {
	const found = tools.find(candidate => candidate.name === name)
	if (!found) throw new Error(`missing ${name}`)
	return found
}

function harness(status = 'idle', visual = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tools-'))
	dirs.push(dir)
	const state: SessionState = {
		sessionId: 's1',
		workspaceId: 'w1',
		status,
		updatedAt: '2026-09-02 12:00:00',
		turnStartedAt: null,
		lastUserMessageAt: '2026-09-02 11:59:00',
		workspaceTitle: 'Berlin relay',
		repoName: 'conductor-remote',
		sessionTitle: null
	}
	const board = new VoiceBriefBoard({
		reads: {
			listWorkspaces: () => [],
			listSessionStates: () => [],
			lastAssistantText: () => null,
			lastQuestionInput: () => null
		},
		locked: async () => false,
		readPrefs: () => ({ readMarks: {}, drafts: {} }),
		writePrefs: patch => ({ readMarks: patch.readMarks ?? {}, drafts: {} })
	})
	const dispatch = vi.fn<(preview: SendPreview) => Promise<VoiceDispatchResult>>(async () => ({ ok: true }))
	const createWorkspace = vi.fn<(preview: WorkspacePreview) => Promise<VoiceWorkspaceCreateResult>>(async () => ({
		ok: true,
		workspaceId: 'w-new'
	}))
	const announce = vi.fn()
	const history = {
		list: vi.fn(() => ({ calls: [], hasMore: false })),
		search: vi.fn((query: string) => ({ query, hits: [], hasMore: false })),
		read: vi.fn(() => null)
	}
	const recall = new VoiceRecall({ history, callId: 'call-a' })
	const readChatContext = vi.fn(
		(target: VoiceCallTarget): VoiceChatContext => ({
			...target,
			workspaceTitle: state.workspaceTitle,
			chatTitle: 'Active chat',
			repo: state.repoName,
			branch: null,
			status: state.status,
			updatedAt: state.updatedAt,
			waitingForTasks: false,
			messages: [{ role: 'assistant', text: 'Latest progress' }],
			truncated: false
		})
	)
	const previews = new PreviewStore(path.join(dir, 'previews.json'))
	const tools = createVoiceTools({
		callId: 'call-a',
		board,
		recall,
		previews,
		presentPreview: async () => visual,
		findSession: id => (id === 's1' ? state : null),
		listRepos: () => [
			{ name: 'conductor-remote', defaultBranch: 'main' },
			{ name: 'website', defaultBranch: 'main' }
		],
		createWorkspace,
		readChatContext,
		dispatch,
		announce
	})
	return { tools, previews, state, board, dispatch, createWorkspace, announce, readChatContext, history, recall }
}

describe('createVoiceTools', () => {
	it('exposes chat context, fleet reads, creation, and the guarded decision tools', () => {
		expect(harness().tools.map(candidate => candidate.name)).toEqual([
			'voice_roll_call',
			'voice_workspace_overview',
			'voice_chat_context',
			'voice_next_decision',
			'voice_list_calls',
			'voice_search_calls',
			'voice_read_call',
			'voice_list_repos',
			'voice_select_repo',
			'voice_create_workspace_preview',
			'voice_create_workspace',
			'voice_send_preview',
			'voice_send'
		])
	})

	it('loads no conversation history when creating tools and forwards only explicit recall requests', async () => {
		const { tools, recall, history, readChatContext } = harness()
		expect(history.list).not.toHaveBeenCalled()
		expect(history.search).not.toHaveBeenCalled()
		expect(history.read).not.toHaveBeenCalled()
		expect(readChatContext).not.toHaveBeenCalled()
		const list = vi.spyOn(recall, 'list')
		const search = vi.spyOn(recall, 'search')
		const read = vi.spyOn(recall, 'read')
		await tool(tools, 'voice_list_calls').run({ started_since: 'yesterday', started_before: 'today', limit: 1 })
		expect(list).toHaveBeenCalledWith(
			expect.objectContaining({ startedSince: 'yesterday', startedBefore: 'today', limit: 1 })
		)
		await tool(tools, 'voice_search_calls').run({ query: 'lamp', call_id: 'old-call', offset: 2 })
		expect(search).toHaveBeenCalledWith('lamp', expect.objectContaining({ callId: 'old-call', offset: 2 }))
		await tool(tools, 'voice_read_call').run({
			call_id: 'old-call',
			near: 'item',
			before: 2,
			after: 3,
			max_chars: 4_000
		})
		expect(read).toHaveBeenCalledWith(
			'old-call',
			expect.objectContaining({ near: 'item', before: 2, after: 3, maxChars: 4_000 })
		)
		expect(readChatContext).not.toHaveBeenCalled()
	})

	it('passes date, repo, status, and completion filters into a fresh overview', async () => {
		const { tools, board } = harness()
		const overview = vi.spyOn(board, 'workspaceOverview').mockResolvedValue({
			spoken: 'Filtered overview.',
			asOf: '2026-09-02T12:00:00.000Z',
			current: 0,
			waitingForYou: 0,
			waitingChatCount: 0,
			possibleFollowUpCount: 0,
			waiting: [],
			waitingCursor: null,
			dormant: 0,
			completed: 0,
			filtered: 0,
			cursor: null,
			workspaces: []
		})
		await tool(tools, 'voice_workspace_overview').run({
			cursor: 3,
			waiting_cursor: 6,
			repo: 'conductor-remote',
			agent_status: 'working',
			workspace_status: 'in-review',
			updated_since: 'today',
			updated_before: '2026-09-03',
			include_done: true,
			include_merged: true,
			include_dormant: true
		})
		expect(overview).toHaveBeenCalledWith(
			3,
			{
				repo: 'conductor-remote',
				agentStatus: 'working',
				workspaceStatus: 'in-review',
				updatedSince: 'today',
				updatedBefore: '2026-09-03',
				includeDone: true,
				includeMerged: true,
				includeDormant: true
			},
			6
		)
	})

	it('lists repos, previews an exact workspace creation, and consumes approval once', async () => {
		const { tools, createWorkspace, announce } = harness()
		const repos = JSON.parse(await tool(tools, 'voice_list_repos').run({})) as {
			spoken: string
			repos: Array<{ name: string }>
		}
		expect(repos.repos.map(repo => repo.name)).toEqual(['conductor-remote', 'website'])
		expect(repos.spoken).toContain('conductor-remote')

		const preview = JSON.parse(
			await tool(tools, 'voice_create_workspace_preview').run({
				repo: 'conductor-remote',
				prompt: 'Implement the overview filters.'
			})
		) as { token: string; spoken: string }
		expect(preview.spoken).toBe(
			'Create a new workspace in conductor-remote with this first prompt: “Implement the overview filters.” Say yes to create it.'
		)

		const approved = JSON.parse(
			await tool(tools, 'voice_create_workspace').run({
				token: preview.token,
				repo: 'conductor-remote',
				prompt: 'Implement the overview filters.'
			})
		) as { status: string; spoken: string }
		expect(approved).toEqual({
			status: 'queued',
			spoken: 'Creating a new workspace in conductor-remote. I will say when it is ready.'
		})
		await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(1))
		expect(createWorkspace.mock.calls[0]?.[0]).toMatchObject({
			kind: 'create_workspace',
			repo: 'conductor-remote',
			prompt: 'Implement the overview filters.'
		})
		await vi.waitFor(() =>
			expect(announce).toHaveBeenCalledWith('Created a new conductor-remote workspace and queued its first prompt.')
		)

		await expect(
			tool(tools, 'voice_create_workspace').run({
				token: preview.token,
				repo: 'conductor-remote',
				prompt: 'Implement the overview filters.'
			})
		).resolves.toMatch(/already used/i)
	})

	it('refuses to preview creation in a repo the relay does not know', async () => {
		const { tools, createWorkspace } = harness()
		await expect(
			tool(tools, 'voice_create_workspace_preview').run({ repo: 'unknown', prompt: 'Do the work.' })
		).resolves.toMatch(/could not find.*unknown/i)
		expect(createWorkspace).not.toHaveBeenCalled()
	})

	it('announces a failed workspace creation', async () => {
		const { tools, createWorkspace, announce } = harness()
		createWorkspace.mockResolvedValue({ ok: false, error: 'Conductor did not open the workspace.' })
		const preview = JSON.parse(
			await tool(tools, 'voice_create_workspace_preview').run({ repo: 'website', prompt: 'Fix the header.' })
		) as { token: string }
		await tool(tools, 'voice_create_workspace').run({
			token: preview.token,
			repo: 'website',
			prompt: 'Fix the header.'
		})
		await vi.waitFor(() =>
			expect(announce).toHaveBeenCalledWith(
				'The new website workspace was not created. Conductor did not open the workspace.'
			)
		)
	})

	it('refreshes the exact named chat without dispatching or marking a decision handled', async () => {
		const { tools, readChatContext, dispatch, state } = harness()
		const contextTool = tool(tools, 'voice_chat_context')
		const args = { workspace_id: 'w1', session_id: 's1' }
		expect(JSON.parse(await contextTool.run(args)).status).toBe('idle')
		state.status = 'working'
		expect(JSON.parse(await contextTool.run(args)).status).toBe('working')
		expect(readChatContext).toHaveBeenCalledTimes(2)
		expect(readChatContext).toHaveBeenLastCalledWith({ workspaceId: 'w1', sessionId: 's1' })
		expect(dispatch).not.toHaveBeenCalled()
	})

	it('reads back the exact target and text, then queues only that preview', async () => {
		const { tools, dispatch } = harness()
		const preview = JSON.parse(
			await tool(tools, 'voice_send_preview').run({
				workspace_id: 'w1',
				session_id: 's1',
				text: 'Implement option B exactly.'
			})
		) as { token: string; spoken: string }
		expect(preview.spoken).toBe(
			'Preview for Berlin relay: “Implement option B exactly.” Say yes to send this exact text.'
		)

		const answer = JSON.parse(
			await tool(tools, 'voice_send').run({
				token: preview.token,
				session_id: 's1',
				text: 'Implement option B exactly.'
			})
		) as { status: string; spoken: string }
		expect(answer).toEqual({ status: 'queued', spoken: 'Queued for Berlin relay.' })
		expect(dispatch).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			callId: 'call-a',
			workspaceId: 'w1',
			sessionId: 's1',
			text: 'Implement option B exactly.',
			token: preview.token
		})
	})

	it('does not claim or steer a chat that became working', async () => {
		const { tools, state, dispatch } = harness()
		const preview = JSON.parse(
			await tool(tools, 'voice_send_preview').run({ workspace_id: 'w1', session_id: 's1', text: 'Go.' })
		) as { token: string }
		state.status = 'working'
		await expect(
			tool(tools, 'voice_send').run({ token: preview.token, session_id: 's1', text: 'Go.' })
		).resolves.toMatch(/running.*steer/i)
		expect(dispatch).not.toHaveBeenCalled()
	})

	it('announces a parked or failed async delivery, while a success stays silent', async () => {
		const parked = harness()
		parked.dispatch.mockResolvedValue({ ok: false, parked: true, error: 'Mac locked' })
		const preview = JSON.parse(
			await tool(parked.tools, 'voice_send_preview').run({ workspace_id: 'w1', session_id: 's1', text: 'Go.' })
		) as { token: string }
		await tool(parked.tools, 'voice_send').run({ token: preview.token, session_id: 's1', text: 'Go.' })
		await vi.waitFor(() => expect(parked.announce).toHaveBeenCalledWith('The prompt is parked until the Mac unlocks.'))

		const landed = harness()
		const landedPreview = JSON.parse(
			await tool(landed.tools, 'voice_send_preview').run({ workspace_id: 'w1', session_id: 's1', text: 'Go.' })
		) as { token: string }
		await tool(landed.tools, 'voice_send').run({ token: landedPreview.token, session_id: 's1', text: 'Go.' })
		await vi.waitFor(() => expect(landed.dispatch).toHaveBeenCalled())
		expect(landed.announce).not.toHaveBeenCalled()
	})
})

it('gives a brief cue for an acknowledged visual draft and the full text for hands-free review', async () => {
	const text = 'A long draft with exact line breaks.\n'.repeat(30)
	const visual = harness('idle', true)
	const card = JSON.parse(
		await tool(visual.tools, 'voice_send_preview').run({ workspace_id: 'w1', session_id: 's1', text })
	)
	expect(card.presentation).toBe('visual')
	expect(card.spoken).not.toContain('A long draft')
	expect(card.text).toBe(text.trim())
	expect(visual.previews.get('call-a', card.token)?.kind).toBe('send_prompt')
	const handsFree = harness()
	const spoken = JSON.parse(
		await tool(handsFree.tools, 'voice_send_preview').run({ workspace_id: 'w1', session_id: 's1', text })
	)
	expect(spoken.presentation).toBe('spoken')
	expect(spoken.spoken).toContain(text.trim())
})

it('saves the creation receipt even if the spoken announcement fails and refuses duplicate approval', async () => {
	const h = harness('idle', true)
	h.announce.mockRejectedValue(new Error('observer disconnected'))
	const preview = JSON.parse(
		await tool(h.tools, 'voice_create_workspace_preview').run({ repo: 'conductor-remote', prompt: 'Draft' })
	)
	const args = { token: preview.token, repo: preview.repo, prompt: preview.prompt }
	expect(JSON.parse(await tool(h.tools, 'voice_create_workspace').run(args)).status).toBe('queued')
	await new Promise(resolve => setImmediate(resolve))
	expect(new PreviewStore(h.previews.file).get('call-a', preview.token)?.outcome).toEqual({
		state: 'completed',
		workspaceId: 'w-new',
		message: 'First prompt queued.'
	})
	expect(JSON.parse(await tool(h.tools, 'voice_create_workspace').run(args)).status).toBe('refused')
	expect(h.createWorkspace).toHaveBeenCalledTimes(1)
})

it('retains a contextual repository choice separately from draft approval', async () => {
	const h = harness()
	await tool(h.tools, 'voice_select_repo').run({ repo: 'Conductor-Remote', confirmed: false })
	expect(JSON.parse(await tool(h.tools, 'voice_list_repos').run({})).selection).toEqual({
		repo: 'conductor-remote',
		confirmed: false
	})
	await tool(h.tools, 'voice_select_repo').run({ repo: 'conductor-remote', confirmed: true })
	expect(JSON.parse(await tool(h.tools, 'voice_list_repos').run({})).selection).toEqual({
		repo: 'conductor-remote',
		confirmed: true
	})
	expect(h.previews.list('call-a')).toEqual([])
	expect(h.createWorkspace).not.toHaveBeenCalled()
})
