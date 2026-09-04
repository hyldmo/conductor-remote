import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '../src/mcp-tools.ts'
import type { SessionState } from '../src/reads.ts'
import { VoiceBriefBoard } from '../src/voice/brief.ts'
import type { SendPreview } from '../src/voice/preview.ts'
import { PreviewStore } from '../src/voice/preview.ts'
import { createVoiceTools, type VoiceDispatchResult } from '../src/voice/tools.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tool(tools: Tool[], name: string): Tool {
	const found = tools.find(candidate => candidate.name === name)
	if (!found) throw new Error(`missing ${name}`)
	return found
}

function harness(status = 'idle') {
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
	const announce = vi.fn()
	const tools = createVoiceTools({
		callId: 'call-a',
		board,
		previews: new PreviewStore(path.join(dir, 'previews.json')),
		findSession: id => (id === 's1' ? state : null),
		dispatch,
		announce
	})
	return { tools, state, dispatch, announce }
}

describe('createVoiceTools', () => {
	it('exposes the overview plus the four guarded decision tools', () => {
		expect(harness().tools.map(candidate => candidate.name)).toEqual([
			'voice_roll_call',
			'voice_workspace_overview',
			'voice_next_decision',
			'voice_send_preview',
			'voice_send'
		])
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
