import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSessionsRoutes } from '../../src/http/routes/sessions.ts'
import { createWorkspacesRoutes } from '../../src/http/routes/workspaces.ts'
import type { RelayServices } from '../../src/http/services.ts'
import { ChatHistoryStore } from '../../src/transcript/chat-history.ts'

let directory: string
beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), 'chat-history-route-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fixture() {
	const chats = ['old', 'new'].map(id => ({ id, title: id, created_at: '2026-09-05 12:00:00' }))
	const chatHistory = new ChatHistoryStore(path.join(directory, 'history.json'))
	const services = {
		chatHistory,
		json: (_req: IncomingMessage, _res: ServerResponse, status: number, body: unknown) => ({ status, body }),
		readBody: async () => JSON.stringify({ workspaceId: 'workspace', previousSessionId: 'old' }),
		reads: {
			sessionWorkspaceId: (id: string) =>
				id === 'foreign' ? 'elsewhere' : chats.some(chat => chat.id === id) ? 'workspace' : null,
			listSessions: vi.fn(() => chats),
			listClosedSessions: vi.fn(() => []),
			getWorkspace: () => null
		}
	} as unknown as RelayServices
	const join = (id = 'new') =>
		createSessionsRoutes(services)(
			{ method: 'POST' } as IncomingMessage,
			{} as ServerResponse,
			new URL(`http://relay/api/sessions/${id}/history`)
		)
	return { services, chats, chatHistory, join }
}

describe('chat history HTTP metadata', () => {
	test('joins and re-joins without UI work or changes to the real session list, then returns the link to another device', async () => {
		const f = fixture()
		expect(await f.join()).toEqual({ status: 200, body: { ok: true } })
		expect(await f.join()).toEqual({ status: 200, body: { ok: true } })
		const result = await createWorkspacesRoutes(f.services)(
			{ method: 'GET' } as IncomingMessage,
			{} as ServerResponse,
			new URL('http://relay/api/workspaces/workspace/sessions')
		)
		expect(result).toEqual({
			status: 200,
			body: {
				sessions: f.chats,
				chat_history: { new: { previousSessionId: 'old', title: 'old', createdAt: '2026-09-05 12:00:00' } }
			}
		})
	})

	test('rejects missing or cross-workspace chats before writing any links', async () => {
		const f = fixture()
		expect(await f.join('foreign')).toMatchObject({ status: 404 })
		expect(await f.join('missing')).toMatchObject({ status: 404 })
		expect(f.chatHistory.forWorkspace('workspace')).toEqual({})
	})

	test('keeps earlier history linkable if its real tab was subsequently closed', async () => {
		const f = fixture()
		vi.mocked(f.services.reads.listSessions).mockReturnValue([f.chats[1]] as ReturnType<
			RelayServices['reads']['listSessions']
		>)
		vi.mocked(f.services.reads.listClosedSessions).mockReturnValue([f.chats[0]] as ReturnType<
			RelayServices['reads']['listClosedSessions']
		>)
		expect(await f.join()).toMatchObject({ status: 200 })
		expect(f.chatHistory.forWorkspace('workspace').new.previousSessionId).toBe('old')
	})
})
