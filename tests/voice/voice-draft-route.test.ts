import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createVoiceRoutes } from '../../src/http/routes/voice.ts'
import { PreviewStore } from '../../src/voice/preview.ts'
import { createVoiceTools } from '../../src/voice/tools.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-draft-route-'))
	dirs.push(dir)
	const previews = new PreviewStore(path.join(dir, 'previews.json'))
	const createWorkspace = vi.fn(async () => ({ ok: true, workspaceId: 'created-id' }))
	let live = true
	let body: unknown
	const route = createVoiceRoutes({
		voicePreviews: previews,
		voiceBroker: { isBrowserCall: () => live, inject: vi.fn(), sendText: vi.fn(() => true) },
		voiceToolsForCall: (callId: string) =>
			createVoiceTools({
				callId,
				previews,
				listRepos: () => [{ name: 'repo', defaultBranch: 'main' }],
				createWorkspace,
				announce: vi.fn()
			} as unknown as Parameters<typeof createVoiceTools>[0]),
		readBody: async () => JSON.stringify(body),
		json: (_req: IncomingMessage, _res: ServerResponse, status: number, data: unknown) => ({ status, data })
	} as unknown as Parameters<typeof createVoiceRoutes>[0])
	const request = async (method: string, callId: string, value?: unknown) => {
		body = value
		return (await route(
			{ method } as IncomingMessage,
			{} as ServerResponse,
			new URL(`http://relay/api/voice/calls/${callId}/drafts`)
		)) as unknown as { status: number; data: unknown }
	}
	return {
		previews,
		createWorkspace,
		request,
		end: () => {
			live = false
		}
	}
}
it('dispatches the exact displayed revision only once across concurrent approvals', async () => {
	const h = setup()
	const preview = h.previews.createWorkspace({ callId: 'call', repo: 'repo', prompt: 'Exact draft' })
	const request = { token: preview.token, action: 'approve' }
	const results = await Promise.all([h.request('POST', 'call', request), h.request('POST', 'call', request)])
	expect(results.map(result => result.status).sort()).toEqual([200, 409])
	await new Promise(resolve => setImmediate(resolve))
	expect(h.createWorkspace).toHaveBeenCalledTimes(1)
	expect(h.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo', prompt: 'Exact draft' }))
	h.end()
	expect(await h.request('POST', 'call', request)).toMatchObject({ status: 409 })
	expect(await h.request('GET', 'call')).toMatchObject({
		status: 200,
		data: {
			drafts: [
				expect.objectContaining({ outcome: expect.objectContaining({ state: 'completed', workspaceId: 'created-id' }) })
			]
		}
	})
})
it('refuses a foreign call and prevents an old revision from approving an edited draft', async () => {
	const h = setup()
	const preview = h.previews.createWorkspace({ callId: 'call', repo: 'repo', prompt: 'Old' })
	expect(await h.request('POST', 'foreign', { token: preview.token, action: 'approve' })).toMatchObject({ status: 404 })
	expect(await h.request('POST', 'call', { token: preview.token, action: 'edit', text: 'Changed' })).toMatchObject({
		status: 200
	})
	expect(await h.request('POST', 'call', { token: preview.token, action: 'approve' })).toMatchObject({ status: 409 })
	expect(h.createWorkspace).not.toHaveBeenCalled()
})
