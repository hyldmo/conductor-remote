import { describe, expect, it, vi } from 'vitest'
import type { SearchWorkspace, SessionRow } from '../src/reads.ts'
import type { TranscriptEntry } from '../src/transcript.ts'
import {
	MAX_VOICE_CONTEXT_CHARS,
	parseVoiceCallTarget,
	readVoiceChatContext,
	VoiceContextError
} from '../src/voice/context.ts'
import { buildWebRtcSession } from '../src/voice/webrtc.ts'

const target = { workspaceId: 'workspace-1', sessionId: 'selected-chat' }
const workspace: SearchWorkspace = {
	id: target.workspaceId,
	workspace_name: 'Fix checkout',
	pr_title: null,
	branch: 'fix-checkout',
	directory_name: 'tokyo',
	state: 'ready',
	updated_at: '2026-09-05 12:00:00',
	repo_name: 'shop',
	icon: null,
	archived: false
}
const session: SessionRow = {
	id: target.sessionId,
	title: 'Checkout retry',
	status: 'working',
	model: 'Codex',
	permission_mode: 'default',
	claude_effort_level: 'high',
	fast_mode: 0,
	agent_type: 'codex',
	context_used_percent: 20,
	unread_count: 0,
	created_at: '2026-09-05 11:00:00',
	updated_at: '2026-09-05 12:00:00',
	last_user_message_at: '2026-09-05 11:59:00',
	prompt_cache_ttl_ms: null,
	turn_started_at: '2026-09-05 11:59:00',
	background_tasks: []
}

function entry(role: TranscriptEntry['role'], text: string, patch: Partial<TranscriptEntry> = {}): TranscriptEntry {
	return { id: text, rowid: 1, role, text, ts: session.updated_at, queued: false, ...patch }
}

function harness(entries: TranscriptEntry[] = []) {
	return {
		getAnyWorkspace: vi.fn(() => workspace),
		// The selected chat is deliberately not the first tab.
		listSessions: vi.fn(() => [{ ...session, id: 'other-chat', title: 'Unrelated work' }, session]),
		getMessages: vi.fn(() => ({ entries, queued: [entry('user', 'Still in the outbox')], cursor: 10 }))
	}
}

describe('workspace voice context', () => {
	it('requires an exact workspace and chat pair when a target is supplied', () => {
		expect(parseVoiceCallTarget(undefined)).toBeUndefined()
		expect(parseVoiceCallTarget(target)).toEqual(target)
		for (const invalid of [null, [], {}, { workspaceId: 'workspace-1' }, { ...target, sessionId: ' ' }]) {
			expect(() => parseVoiceCallTarget(invalid)).toThrow(VoiceContextError)
		}
	})

	it('loads the selected chat conversation before the first response and retains the language choice', () => {
		const reads = harness([
			entry('user', 'Fix duplicate checkout requests.'),
			entry('assistant', 'The retry handler submits twice.'),
			entry('thinking', 'Private reasoning'),
			entry('tool', 'Large command output'),
			entry('assistant', 'Unrelated child work', { parentToolUseId: 'child-tool' }),
			entry('user', 'Legacy queued message', { queued: true })
		])
		const context = readVoiceChatContext(reads, target)
		expect(reads.getMessages).toHaveBeenCalledExactlyOnceWith('selected-chat')
		expect(context).toMatchObject({
			...target,
			workspaceTitle: 'Fix checkout',
			chatTitle: 'Checkout retry',
			status: 'working',
			truncated: false,
			messages: [
				{ role: 'user', text: 'Fix duplicate checkout requests.' },
				{ role: 'assistant', text: 'The retry handler submits twice.' }
			]
		})
		const call = buildWebRtcSession({ model: 'test', voice: 'marin', language: 'no', context })
		expect(call.instructions).toContain(JSON.stringify(context))
		expect(call.instructions).toContain('Norwegian Bokmål')
		expect(call.instructions).toContain('voice_chat_context')
		expect(call.instructions).toContain('voice_send_preview')
		expect(call.instructions).toContain('A historical yes does not authorize a send')
		expect(call.instructions).not.toContain('Start with voice_roll_call')
		expect(call.instructions).not.toContain('Unrelated child work')
	})

	it('refuses archived, hidden, or mismatched targets before reading a transcript', () => {
		const reads = harness()
		expect(() => readVoiceChatContext(reads, { ...target, sessionId: 'hidden-chat' })).toThrow(
			'no longer in the named workspace'
		)
		expect(reads.getMessages).not.toHaveBeenCalled()
		reads.getAnyWorkspace.mockReturnValue({ ...workspace, archived: true })
		expect(() => readVoiceChatContext(reads, target)).toThrow('workspace is no longer available')
		expect(reads.getMessages).not.toHaveBeenCalled()
	})

	it('keeps the newest conversation in order and reports when older context is omitted', () => {
		const reads = harness(Array.from({ length: 30 }, (_, i) => entry(i % 2 ? 'assistant' : 'user', `Message ${i}`)))
		const context = readVoiceChatContext(reads, target)
		expect(context.messages).toHaveLength(24)
		expect(context.messages[0]?.text).toBe('Message 6')
		expect(context.messages.at(-1)?.text).toBe('Message 29')
		expect(context.truncated).toBe(true)
	})

	it('bounds long messages and keeps the latest update', () => {
		const reads = harness([
			...Array.from({ length: 30 }, () => entry('assistant', 'large '.repeat(2_000))),
			entry('user', 'The latest request')
		])
		const context = readVoiceChatContext(reads, target)
		expect(context.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(
			MAX_VOICE_CONTEXT_CHARS
		)
		expect(context.messages.at(-1)).toEqual({ role: 'user', text: 'The latest request' })
		expect(context.truncated).toBe(true)
	})

	it('retains the user request when a long running turn fills the recent tail with progress', () => {
		const reads = harness([
			entry('user', 'Fix the checkout retry without changing payment providers.'),
			...Array.from({ length: 30 }, (_, i) => entry('assistant', `Progress ${i}: ${'details '.repeat(1_000)}`))
		])
		const context = readVoiceChatContext(reads, target)
		expect(context.messages[0]).toEqual({
			role: 'user',
			text: 'Fix the checkout retry without changing payment providers.'
		})
		expect(context.messages.at(-1)?.text).toMatch(/^Progress 29:/)
		expect(context.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(
			MAX_VOICE_CONTEXT_CHARS
		)
		expect(context.truncated).toBe(true)
	})

	it('refreshes from the same chat and supports an empty conversation', () => {
		const reads = harness()
		expect(readVoiceChatContext(reads, target).messages).toEqual([])
		reads.getMessages.mockReturnValue({ entries: [entry('assistant', 'The fix now passes.')], queued: [], cursor: 11 })
		reads.listSessions.mockReturnValue([{ ...session, status: 'idle' }])
		expect(readVoiceChatContext(reads, target)).toMatchObject({
			status: 'idle',
			messages: [{ role: 'assistant', text: 'The fix now passes.' }],
			truncated: false
		})
	})
})
