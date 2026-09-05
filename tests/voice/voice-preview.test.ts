import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreviewStore } from '../../src/voice/preview.ts'

const dirs: string[] = []
function file(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-preview-'))
	dirs.push(dir)
	return path.join(dir, 'previews.json')
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('PreviewStore', () => {
	it('persists exact previews, then claims one token exactly once', () => {
		const at = 1_000_000
		const store = new PreviewStore(file(), { now: () => at })
		const preview = store.create({ callId: 'call-a', workspaceId: 'w1', sessionId: 's1', text: 'Use option B.' })
		expect(preview.expiresAt).toBe(at + 120_000)
		expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)

		const afterRestart = new PreviewStore(store.file, { now: () => at + 1 })
		expect(afterRestart.claim(preview.token, { callId: 'call-a', sessionId: 's1', text: 'Use option B.' })).toEqual({
			ok: true,
			preview: expect.objectContaining({ status: 'claimed', token: preview.token })
		})
		expect(afterRestart.claim(preview.token, { callId: 'call-a', sessionId: 's1', text: 'Use option B.' })).toEqual({
			ok: false,
			reason: 'already-used'
		})
	})

	it('gives distinct refusals for expired, foreign, and text-mismatched tokens', () => {
		let now = 10_000
		const store = new PreviewStore(file(), { now: () => now })
		const foreign = store.create({ callId: 'call-a', workspaceId: 'w1', sessionId: 's1', text: 'Exact text' })
		expect(store.claim(foreign.token, { callId: 'call-b', sessionId: 's1', text: 'Exact text' })).toEqual({
			ok: false,
			reason: 'foreign-call'
		})
		expect(store.claim(foreign.token, { callId: 'call-a', sessionId: 's2', text: 'Exact text' })).toEqual({
			ok: false,
			reason: 'foreign-session'
		})
		expect(store.claim(foreign.token, { callId: 'call-a', sessionId: 's1', text: 'Nearly exact' })).toEqual({
			ok: false,
			reason: 'text-mismatch'
		})

		const expired = store.create({ callId: 'call-a', workspaceId: 'w1', sessionId: 's1', text: 'Exact text' })
		now += 120_001
		expect(store.claim(expired.token, { callId: 'call-a', sessionId: 's1', text: 'Exact text' })).toEqual({
			ok: false,
			reason: 'expired'
		})
	})

	it('keeps pre-action-kind send previews valid across an upgrade', () => {
		const target = file()
		fs.writeFileSync(
			target,
			JSON.stringify([
				{
					callId: 'call-a',
					workspaceId: 'w1',
					sessionId: 's1',
					text: 'Existing preview.',
					token: 'legacy-token',
					createdAt: 9_000,
					expiresAt: 20_000,
					status: 'ready'
				}
			])
		)
		const store = new PreviewStore(target, { now: () => 10_000 })
		expect(store.claim('legacy-token', { callId: 'call-a', sessionId: 's1', text: 'Existing preview.' })).toEqual({
			ok: true,
			preview: expect.objectContaining({ kind: 'send_prompt', status: 'claimed' })
		})
	})

	it('prunes expired records when a later preview is created', () => {
		let now = 10_000
		const store = new PreviewStore(file(), { now: () => now })
		store.create({ callId: 'old-call', workspaceId: 'w1', sessionId: 's1', text: 'Old text' })
		now += 120_001
		const current = store.create({ callId: 'new-call', workspaceId: 'w2', sessionId: 's2', text: 'New text' })
		expect(JSON.parse(fs.readFileSync(store.file, 'utf8'))).toEqual([current])
	})

	it('persists and claims an exact create-workspace preview once', () => {
		const at = 1_000_000
		const store = new PreviewStore(file(), { now: () => at })
		const preview = store.createWorkspace({
			callId: 'call-a',
			repo: 'conductor-remote',
			prompt: 'Implement the date filters.'
		})

		const afterRestart = new PreviewStore(store.file, { now: () => at + 1 })
		expect(
			afterRestart.claimWorkspace(preview.token, {
				callId: 'call-a',
				repo: 'conductor-remote',
				prompt: 'Implement the date filters.'
			})
		).toEqual({ ok: true, preview: expect.objectContaining({ kind: 'create_workspace', status: 'claimed' }) })
		expect(
			afterRestart.claimWorkspace(preview.token, {
				callId: 'call-a',
				repo: 'conductor-remote',
				prompt: 'Implement the date filters.'
			})
		).toEqual({ ok: false, reason: 'already-used' })
	})

	it('refuses a create-workspace token when its repo or prompt changed', () => {
		const store = new PreviewStore(file(), { now: () => 10_000 })
		const preview = store.createWorkspace({ callId: 'call-a', repo: 'relay', prompt: 'Build it.' })
		expect(store.claimWorkspace(preview.token, { callId: 'call-a', repo: 'other', prompt: 'Build it.' })).toEqual({
			ok: false,
			reason: 'foreign-repo'
		})
		expect(store.claimWorkspace(preview.token, { callId: 'call-a', repo: 'relay', prompt: 'Change it.' })).toEqual({
			ok: false,
			reason: 'prompt-mismatch'
		})
	})

	it('does not let one preview kind authorize the other action', () => {
		const store = new PreviewStore(file(), { now: () => 10_000 })
		const send = store.create({ callId: 'call-a', workspaceId: 'w1', sessionId: 's1', text: 'Go.' })
		expect(store.claimWorkspace(send.token, { callId: 'call-a', repo: 'relay', prompt: 'Go.' })).toEqual({
			ok: false,
			reason: 'wrong-action'
		})

		const workspace = store.createWorkspace({ callId: 'call-a', repo: 'relay', prompt: 'Go.' })
		expect(store.claim(workspace.token, { callId: 'call-a', sessionId: 's1', text: 'Go.' })).toEqual({
			ok: false,
			reason: 'wrong-action'
		})
	})
})
