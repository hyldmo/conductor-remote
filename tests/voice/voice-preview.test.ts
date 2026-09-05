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

	it('retains expired drafts for review until the 30-day retention boundary', () => {
		let now = 10_000
		const store = new PreviewStore(file(), { now: () => now })
		const old = store.create({ callId: 'old-call', workspaceId: 'w1', sessionId: 's1', text: 'Old text' })
		now += 120_001
		const current = store.create({ callId: 'new-call', workspaceId: 'w2', sessionId: 's2', text: 'New text' })
		expect(JSON.parse(fs.readFileSync(store.file, 'utf8'))).toEqual([old, current])
		now += 31 * 86_400_000
		const latest = store.createWorkspace({ callId: 'latest', repo: 'repo', prompt: '' })
		expect(JSON.parse(fs.readFileSync(store.file, 'utf8'))).toEqual([latest])
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

it('retires approval when a draft is edited and retains both revisions across restart', () => {
	const store = new PreviewStore(file())
	const old = store.createWorkspace({ callId: 'call', repo: 'repo', prompt: 'Original exact prompt' })
	const edited = store.edit('call', old.token, 'Changed exact prompt')!
	expect(edited.token).not.toBe(old.token)
	expect(store.claimWorkspace(old.token, { callId: 'call', repo: 'repo', prompt: 'Original exact prompt' })).toEqual({
		ok: false,
		reason: 'already-used'
	})
	expect(new PreviewStore(store.file).list('call')).toHaveLength(2)
	expect(store.claimWorkspace(edited.token, { callId: 'call', repo: 'repo', prompt: 'Changed exact prompt' }).ok).toBe(
		true
	)
	store.settle(edited.token, { state: 'completed', workspaceId: 'created-workspace' })
	expect(new PreviewStore(store.file).get('call', edited.token)?.outcome).toEqual({
		state: 'completed',
		workspaceId: 'created-workspace'
	})
})

it('requires a receipt for the exact displayed revision and falls back when no screen acknowledges it', async () => {
	const store = new PreviewStore(file())
	const preview = store.createWorkspace({ callId: 'call', repo: 'repo', prompt: 'Full text' })
	const shown = store.waitForPresentation(preview.token, 50)
	expect(store.present('foreign-call', preview.token)).toBe(false)
	expect(store.present('call', preview.token)).toBe(true)
	await expect(shown).resolves.toBe(true)
	const edited = store.edit('call', preview.token, 'Revised')!
	await expect(store.waitForPresentation(edited.token, 1)).resolves.toBe(false)
})

it('marks an in-flight action unknown after a restart instead of offering to replay it', () => {
	const store = new PreviewStore(file())
	const preview = store.createWorkspace({ callId: 'call', repo: 'repo', prompt: '' })
	store.claimWorkspace(preview.token, { callId: 'call', repo: 'repo', prompt: '' })
	const restored = new PreviewStore(store.file)
	expect(restored.get('call', preview.token)?.outcome?.state).toBe('unknown')
	expect(restored.claimWorkspace(preview.token, { callId: 'call', repo: 'repo', prompt: '' }).ok).toBe(false)
})

it('pauses voice approval before unsaved editing begins, then requires the saved revision', () => {
	const store = new PreviewStore(file())
	const preview = store.createWorkspace({ callId: 'call', repo: 'repo', prompt: 'Original' })
	expect(store.pauseReview('call', preview.token, true)).toBe(true)
	expect(store.claimWorkspace(preview.token, { callId: 'call', repo: 'repo', prompt: 'Original' })).toEqual({
		ok: false,
		reason: 'editing'
	})
	const saved = store.edit('call', preview.token, 'Saved edit')!
	expect(store.claimWorkspace(preview.token, { callId: 'call', repo: 'repo', prompt: 'Original' }).ok).toBe(false)
	expect(store.claimWorkspace(saved.token, { callId: 'call', repo: 'repo', prompt: 'Saved edit' }).ok).toBe(true)
})
