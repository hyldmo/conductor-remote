import crypto from 'node:crypto'

import path from 'node:path'

import { stateDir } from '../../config.ts'
import { attachPrStatus } from '../../git/pr.ts'
import { handleRpc } from '../../mcp/dispatcher.ts'

import { readPrefs, writePrefs } from '../../prefs.ts'

import { routes } from '../../routes.ts'

import { VoiceBriefBoard } from '../../voice/brief.ts'

import { VoiceBroker } from '../../voice/broker.ts'

import { openAIOriginForSipHost, readVoiceConfig } from '../../voice/config.ts'

import { readVoiceChatContext } from '../../voice/context.ts'

import { createVoiceGateway } from '../../voice/gateway.ts'

import { VoiceHistory } from '../../voice/history.ts'

import { PreviewStore, type WorkspacePreview } from '../../voice/preview.ts'

import { createVoiceServer } from '../../voice/server.ts'

import { createVoiceTools } from '../../voice/tools.ts'

import type { CreateWorkspaceResult } from '../../wire.ts'

import { screenLocked } from '../../writes/guards.ts'
import type { BaseServices } from './base.ts'

export function createVoiceServices(services: Pick<BaseServices, 'cfg' | 'reads'>) {
	const { cfg, reads } = services

	// The voice process surface shares this process (and therefore the one UI lock) but not
	// this server's port. Only its three scoped routes are mounted through Funnel.
	const voiceConfig = readVoiceConfig()

	// Stable but useless outside this OpenAI abuse-control header. Hashing the relay
	// bearer means neither that bearer nor a device identifier leaves the Mac.
	const voiceSafetyIdentifier = crypto.createHash('sha256').update(`conductor-remote:${cfg.token}`).digest('hex')

	const voiceBoards = new Map<string, VoiceBriefBoard>()

	const voicePreviews = new PreviewStore(path.join(stateDir(), 'voice-previews.json'))

	const voiceHistory = new VoiceHistory(path.join(stateDir(), 'voice-history.db'))

	process.on('exit', () => voiceHistory.close())

	const voiceBroker = voiceConfig.openaiKey
		? new VoiceBroker({
				apiKey: voiceConfig.openaiKey,
				apiOrigin: openAIOriginForSipHost(voiceConfig.sipHost),
				model: voiceConfig.model,
				voice: voiceConfig.voice,
				mcpUrl: voiceConfig.publicBaseUrl ? `${voiceConfig.publicBaseUrl}/mcp` : null,
				mcpToken: voiceConfig.mcpToken,
				stateFile: path.join(stateDir(), 'voice-calls.json'),
				history: voiceHistory,
				tools: callId => voiceToolsForCall(callId),
				onClose: callId => voiceBoards.delete(callId)
			})
		: null

	function voiceBoard(callId: string): VoiceBriefBoard {
		let board = voiceBoards.get(callId)
		if (board) return board
		board = new VoiceBriefBoard({
			reads: {
				listWorkspaces: () => {
					const workspaces = reads.listWorkspaces()
					attachPrStatus(workspaces)
					return workspaces
				},
				listSessionStates: () => reads.listSessionStates(),
				lastAssistantText: sessionId => reads.lastAssistantText(sessionId),
				lastQuestionInput: sessionId => reads.lastQuestionInput(sessionId)
			},
			locked: async () => (await screenLocked()) === true,
			readPrefs,
			writePrefs
		})
		voiceBoards.set(callId, board)
		return board
	}

	function voiceRelayOrigin(): string {
		const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host
		return `http://${host}:${cfg.port}`
	}

	async function dispatchVoicePreview(preview: {
		workspaceId: string
		sessionId: string
		text: string
		token: string
	}): Promise<{ ok: boolean; parked?: boolean; error?: string }> {
		const timeoutMs = 75_000
		const res = await fetch(`${voiceRelayOrigin()}${routes.sendPrompt.path(preview.sessionId)}`, {
			method: routes.sendPrompt.method,
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${cfg.token}`,
				'content-type': 'application/json',
				'x-relay-client': 'voice',
				'x-client-timeout-ms': String(timeoutMs)
			},
			body: JSON.stringify({
				workspaceId: preview.workspaceId,
				text: preview.text,
				clientId: preview.token
			})
		})
		const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; parked?: boolean; error?: string }
		return {
			ok: payload.ok === true,
			parked: payload.parked === true,
			error: payload.error ?? (!res.ok ? `HTTP ${res.status}` : undefined)
		}
	}

	async function createVoiceWorkspace(preview: WorkspacePreview): Promise<{
		ok: boolean
		workspaceId?: string
		warning?: string
		error?: string
	}> {
		// Creation runs behind the shared Conductor UI lease. The call already returned
		// "queued", so keep enough room for one in-flight interactive action to finish
		// before the deep link and its workspace-row receipt run.
		const timeoutMs = 75_000
		const res = await fetch(`${voiceRelayOrigin()}${routes.createWorkspace.path()}`, {
			method: routes.createWorkspace.method,
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${cfg.token}`,
				'content-type': 'application/json',
				'x-relay-client': 'voice',
				'x-client-timeout-ms': String(timeoutMs)
			},
			body: JSON.stringify({ repo: preview.repo, prompt: preview.prompt, sendImmediately: true })
		})
		const payload = (await res.json().catch(() => ({}))) as CreateWorkspaceResult
		return {
			ok: res.ok && payload.ok === true,
			workspaceId: payload.workspaceId,
			warning: payload.warning,
			error: payload.error ?? (!res.ok ? `HTTP ${res.status}` : undefined)
		}
	}

	function voiceToolsForCall(callId: string) {
		return createVoiceTools({
			callId,
			board: voiceBoard(callId),
			previews: voicePreviews,
			findSession: sessionId => reads.listSessionStates().find(state => state.sessionId === sessionId) ?? null,
			listRepos: () => reads.listRepos().map(repo => ({ name: repo.name, defaultBranch: repo.default_branch })),
			createWorkspace: createVoiceWorkspace,
			readChatContext: target => readVoiceChatContext(reads, target),
			dispatch: dispatchVoicePreview,
			announce: spoken => {
				if (!voiceBroker?.inject(callId, spoken)) console.warn(`[voice] ${callId} could not receive a delivery nudge`)
			}
		})
	}

	const voiceGateway = createVoiceGateway({
		config: () => voiceConfig,
		broker: () => voiceBroker,
		rpc: (callId, request) => handleRpc(voiceToolsForCall(callId), request)
	})

	const voiceServer = createVoiceServer({
		routes: voiceGateway,
		mcpToken: () => voiceConfig.mcpToken,
		log: line => console.warn(line)
	})
	return { voiceHistory, voiceConfig, voiceBroker, voiceSafetyIdentifier, voiceServer }
}
export type VoiceServices = ReturnType<typeof createVoiceServices>
