/** OpenAI SIP/WebRTC setup plus the authenticated sideband controller for one live call. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from '../mcp/types.ts'
import type { VoiceLanguage } from '../shared.ts'
import { DEFAULT_VOICE_SPEED, type VoiceReasoningEffort, voiceReasoning } from './config.ts'
import type { VoiceHistory } from './history.ts'
import { VOICE_INSTRUCTIONS } from './prompt.ts'
import { VOICE_TOOL_NAMES } from './tools.ts'
import { voiceTranscription } from './transcription.ts'

export interface BrokerSocket {
	readonly readyState: number
	send(data: string): void
	close(): void
	addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void
}

export type BrokerSocketFactory = (url: string, headers: Record<string, string>) => BrokerSocket

interface AcceptBodyInput {
	callId: string
	model: string
	reasoningEffort?: VoiceReasoningEffort
	voice: string
	speed?: number
	mcpUrl: string
	mcpToken: string
	instructions: string
	language?: VoiceLanguage
}

/** Current Realtime call-accept shape, kept pure so upstream API drift has a snapshot-sized test. */
export function buildAcceptBody(input: AcceptBodyInput): Record<string, unknown> {
	return {
		type: 'realtime',
		model: input.model,
		...voiceReasoning(input.model, input.reasoningEffort),
		instructions: input.instructions,
		max_output_tokens: 800,
		audio: {
			input: { transcription: voiceTranscription(input.language) },
			output: { voice: input.voice, speed: input.speed ?? DEFAULT_VOICE_SPEED }
		},
		tools: [
			{
				type: 'mcp',
				server_label: 'conductor_voice',
				server_url: input.mcpUrl,
				headers: {
					authorization: `Bearer ${input.mcpToken}`,
					'x-voice-call-id': input.callId
				},
				allowed_tools: [...VOICE_TOOL_NAMES],
				require_approval: 'never'
			}
		]
	}
}

interface TokenDetails {
	text_tokens?: number
	audio_tokens?: number
	cached_tokens?: number
	cached_tokens_details?: { text_tokens?: number; audio_tokens?: number }
}

export interface RealtimeUsage {
	input_tokens?: number
	output_tokens?: number
	total_tokens?: number
	input_token_details?: TokenDetails
	output_token_details?: TokenDetails
}

// USD per million tokens: https://developers.openai.com/api/docs/models/gpt-realtime-2.1
// Mini remains configurable: https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
const REALTIME_RATES = new Map([
	[
		'gpt-realtime-2.1',
		{
			text: { input: 4, cached: 0.4, output: 24 },
			audio: { input: 32, cached: 0.4, output: 64 }
		}
	],
	[
		'gpt-realtime-2.1-mini',
		{
			text: { input: 0.6, cached: 0.06, output: 2.4 },
			audio: { input: 10, cached: 0.3, output: 20 }
		}
	]
])

/** USD estimate from the configured model's published text and audio rates. */
export function estimateRealtimeCost(model: string, usage: RealtimeUsage): number | null {
	const rates = REALTIME_RATES.get(model)
	if (!rates) return null
	const input = usage.input_token_details ?? {}
	const output = usage.output_token_details ?? {}
	const cachedText = input.cached_tokens_details?.text_tokens ?? 0
	const cachedAudio = input.cached_tokens_details?.audio_tokens ?? 0
	const uncachedText = Math.max(0, (input.text_tokens ?? 0) - cachedText)
	const uncachedAudio = Math.max(0, (input.audio_tokens ?? 0) - cachedAudio)
	return (
		(uncachedText * rates.text.input +
			cachedText * rates.text.cached +
			uncachedAudio * rates.audio.input +
			cachedAudio * rates.audio.cached +
			(output.text_tokens ?? 0) * rates.text.output +
			(output.audio_tokens ?? 0) * rates.audio.output) /
		1_000_000
	)
}

interface StoredCall {
	callId: string
	acceptedAt: number
	mode: 'mcp' | 'function'
	ready: boolean
	greeted: boolean
	/** Older browser sessions still let provider VAD create responses. */
	managedTurns?: boolean
}

interface Runtime {
	callId: string
	socket: BrokerSocket
	mode: StoredCall['mode']
	managedTurns: boolean
	ready: boolean
	open: boolean
	toolsReady: boolean
	greeted: boolean
	started: boolean
	responseActive: boolean
	responseDone: boolean
	responseHadTool: boolean
	responseId: string | null
	inputEpoch: number
	userSpeaking: boolean
	waitingForUserResponse: boolean
	userTurnPending: boolean
	finishedResponses: Set<string>
	responseStartedAt: number
	firstOutputAt: number | null
	playing: boolean
	typed: string[]
	toolEpoch: Map<string, number>
	pending: string[]
	pendingTools: Set<string>
	handledTools: Set<string>
	toolStarted: Map<string, number>
}

interface BrokerDeps {
	apiKey: string
	apiOrigin: string
	model: string
	reasoningEffort?: VoiceReasoningEffort
	voice: string
	speed?: number
	mcpUrl?: string | null
	mcpToken?: string | null
	stateFile: string
	fetch?: typeof fetch
	socket?: BrokerSocketFactory
	log?: (line: string) => void
	now?: () => number
	instructions?: string
	/** Function tools are used only for relay-created WebRTC calls. */
	tools?: (callId: string) => Tool[]
	onClose?: (callId: string) => void
	history?: VoiceHistory
}

export interface VoiceCallOptions {
	/** Chosen before the call is accepted; OpenAI does not allow changing it after audio begins. */
	voice?: string
	/** Per-call language or presentation instructions layered over the relay default. */
	instructions?: string
	language?: VoiceLanguage
}

function defaultSocket(url: string, headers: Record<string, string>): BrokerSocket {
	// Node 24's built-in client accepts an undici options object here. DOM's constructor
	// type still describes the browser's `protocols` argument, hence the narrow cast.
	const Client = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => BrokerSocket
	return new Client(url, { headers })
}

function messageText(raw: unknown): string {
	if (typeof raw === 'string') return raw
	if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
	if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
	return String(raw ?? '')
}

function safeNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export class VoiceBroker {
	readonly stateFile: string
	private readonly deps: BrokerDeps
	private readonly fetcher: typeof fetch
	private readonly sockets: BrokerSocketFactory
	private readonly log: (line: string) => void
	private readonly now: () => number
	private readonly apiOrigin: string
	private readonly websocketOrigin: string
	private readonly calls = new Map<string, StoredCall>()
	private readonly runtimes = new Map<string, Runtime>()

	constructor(deps: BrokerDeps) {
		this.deps = deps
		this.stateFile = deps.stateFile
		this.fetcher = deps.fetch ?? fetch
		this.sockets = deps.socket ?? defaultSocket
		this.log = deps.log ?? console.info
		this.now = deps.now ?? Date.now
		this.apiOrigin = deps.apiOrigin.replace(/\/+$/, '')
		this.websocketOrigin = this.apiOrigin.replace(/^https:/, 'wss:')
		this.readCalls()
	}

	private readCalls(): void {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
			if (!Array.isArray(parsed)) return
			for (const raw of parsed) {
				const call = raw as Partial<StoredCall>
				if (typeof call.callId === 'string' && typeof call.acceptedAt === 'number') {
					this.calls.set(call.callId, {
						callId: call.callId,
						acceptedAt: call.acceptedAt,
						// Records written before WebRTC support were all SIP/MCP calls.
						mode: call.mode === 'function' ? 'function' : 'mcp',
						ready: call.ready ?? true,
						greeted: call.greeted ?? false,
						managedTurns: call.managedTurns === true
					})
				}
			}
		} catch {
			// First run or a recoverable partial file: the webhook can repopulate it.
		}
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
		fs.writeFileSync(this.stateFile, `${JSON.stringify([...this.calls.values()], null, 2)}\n`, { mode: 0o600 })
		fs.chmodSync(this.stateFile, 0o600)
	}

	async accept(callId: string, options: VoiceCallOptions = {}): Promise<void> {
		if (!this.deps.mcpUrl || !this.deps.mcpToken) throw new Error('SIP voice MCP is not configured')
		const response = await this.fetcher(`${this.apiOrigin}/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.deps.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(
				buildAcceptBody({
					callId,
					model: this.deps.model,
					reasoningEffort: this.deps.reasoningEffort,
					voice: options.voice ?? this.deps.voice,
					speed: this.deps.speed,
					language: options.language,
					mcpUrl: this.deps.mcpUrl,
					mcpToken: this.deps.mcpToken,
					instructions: options.instructions ?? this.deps.instructions ?? VOICE_INSTRUCTIONS
				})
			)
		})
		if (!response.ok) throw new Error(`OpenAI call accept returned ${response.status}: ${await response.text()}`)
		this.calls.set(callId, {
			callId,
			acceptedAt: this.now(),
			mode: 'mcp',
			ready: true,
			greeted: false
		})
		this.persist()
		this.deps.history?.start({
			callId,
			startedAt: this.now(),
			transport: 'sip',
			model: this.deps.model,
			voice: options.voice ?? this.deps.voice,
			language: options.language ?? 'auto'
		})
		this.attach(callId)
	}

	async reject(callId: string, statusCode = 603): Promise<void> {
		const response = await this.fetcher(`${this.apiOrigin}/v1/realtime/calls/${encodeURIComponent(callId)}/reject`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.deps.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status_code: statusCode })
		})
		if (!response.ok) throw new Error(`OpenAI call reject returned ${response.status}: ${await response.text()}`)
	}

	/** Reattach every call whose socket was alive when a self-update stopped this process. */
	async restore(): Promise<void> {
		this.deps.history?.recover()
		for (const call of this.calls.values()) {
			this.deps.history?.start(
				{
					callId: call.callId,
					startedAt: call.acceptedAt,
					transport: call.mode === 'function' ? 'webrtc' : 'sip',
					model: this.deps.model,
					voice: this.deps.voice,
					language: 'auto'
				},
				true
			)
			this.attach(call.callId)
		}
	}

	private attach(callId: string): void {
		if (this.runtimes.has(callId)) return
		const call = this.calls.get(callId)
		if (!call) return
		const socket = this.sockets(`${this.websocketOrigin}/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
			authorization: `Bearer ${this.deps.apiKey}`
		})
		const runtime: Runtime = {
			callId,
			socket,
			mode: call.mode,
			managedTurns: call.managedTurns === true,
			ready: call.ready,
			open: socket.readyState === 1,
			toolsReady: call.mode === 'function',
			greeted: call.greeted,
			started: call.greeted,
			responseActive: false,
			responseDone: false,
			responseHadTool: false,
			responseId: null,
			inputEpoch: 0,
			userSpeaking: false,
			waitingForUserResponse: false,
			userTurnPending: false,
			finishedResponses: new Set(),
			responseStartedAt: 0,
			firstOutputAt: null,
			playing: false,
			typed: [],
			toolEpoch: new Map(),
			pending: [],
			pendingTools: new Set(),
			handledTools: new Set(),
			toolStarted: new Map()
		}
		this.runtimes.set(callId, runtime)
		socket.addEventListener('open', () => {
			runtime.open = true
			this.maybeStart(runtime)
			this.flush(runtime)
		})
		socket.addEventListener('message', event => this.onEvent(callId, runtime, messageText(event.data)))
		socket.addEventListener('error', () => this.log(`[voice] ${callId} observer socket error`))
		socket.addEventListener('close', event => {
			if (this.runtimes.get(callId) !== runtime) return
			this.forget(callId, runtime)
			this.deps.history?.finish(callId, event.code === 1000 ? 'ended' : 'interrupted')
			this.log(`[voice] ${callId} observer closed`)
		})
		this.maybeStart(runtime)
	}

	private send(runtime: Runtime, value: unknown): void {
		if (runtime.socket.readyState !== 1) return
		runtime.socket.send(JSON.stringify(value))
	}

	private forget(callId: string, runtime?: Runtime): void {
		if (runtime && this.runtimes.get(callId) !== runtime) return
		const existed = this.calls.delete(callId)
		this.runtimes.delete(callId)
		if (!existed) return
		this.persist()
		this.deps.onClose?.(callId)
	}

	private createResponse(runtime: Runtime): boolean {
		if (
			runtime.responseActive ||
			runtime.userSpeaking ||
			runtime.waitingForUserResponse ||
			runtime.socket.readyState !== 1
		)
			return false
		runtime.responseActive = true
		runtime.responseDone = false
		runtime.responseHadTool = false
		this.send(runtime, { type: 'response.create' })
		return true
	}

	private maybeStart(runtime: Runtime): void {
		if (!runtime.open || !runtime.ready || !runtime.toolsReady || runtime.started) return
		runtime.started = this.createResponse(runtime)
	}

	private flush(runtime: Runtime): void {
		if (
			!runtime.toolsReady ||
			!runtime.greeted ||
			runtime.responseActive ||
			runtime.userSpeaking ||
			runtime.waitingForUserResponse ||
			runtime.playing ||
			runtime.socket.readyState !== 1
		)
			return
		const text = runtime.pending.shift()
		if (!text) return
		const itemId = `relay_${crypto.randomBytes(10).toString('hex')}`
		this.deps.history?.internal(runtime.callId, itemId)
		this.send(runtime, {
			type: 'conversation.item.create',
			item: { id: itemId, type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
		})
		this.createResponse(runtime)
	}

	/** OpenAI may finish the response before or after its tool calls. Both are a barrier. */
	private continueAfterTools(runtime: Runtime): void {
		if (!runtime.responseDone || !runtime.responseHadTool || runtime.userSpeaking || runtime.waitingForUserResponse)
			return
		if ([...runtime.pendingTools].some(id => runtime.toolEpoch.get(id) === runtime.inputEpoch)) return
		runtime.responseDone = false
		runtime.responseHadTool = false
		this.createResponse(runtime)
	}

	private finishTool(callId: string, runtime: Runtime, event: Record<string, unknown>): void {
		const item = (event.item ?? {}) as Record<string, unknown>
		const id = typeof event.item_id === 'string' ? event.item_id : typeof item.id === 'string' ? item.id : null
		const started = id ? runtime.toolStarted.get(id) : undefined
		const current = !id || runtime.toolEpoch.get(id) === runtime.inputEpoch
		if (id) {
			runtime.toolStarted.delete(id)
			runtime.pendingTools.delete(id)
			runtime.toolEpoch.delete(id)
		}
		const name = typeof item.name === 'string' ? item.name : (id ?? 'unknown tool')
		const latency = started === undefined ? 'unknown latency' : `${this.now() - started}ms`
		this.log(`[voice] ${callId} tool ${name}: ${latency}`)
		if (!current) return
		runtime.responseHadTool = true
		// Remote MCP results do not automatically continue, but OpenAI requires the
		// original response *and every MCP call in it* to finish before the next one.
		this.continueAfterTools(runtime)
	}

	private startFunction(callId: string, runtime: Runtime, event: Record<string, unknown>): void {
		if (runtime.mode !== 'function') return
		const item = (event.item ?? {}) as Record<string, unknown>
		const invocationId =
			typeof event.call_id === 'string' ? event.call_id : typeof item.call_id === 'string' ? item.call_id : null
		const name = typeof event.name === 'string' ? event.name : typeof item.name === 'string' ? item.name : null
		const encodedArgs =
			typeof event.arguments === 'string' ? event.arguments : typeof item.arguments === 'string' ? item.arguments : '{}'
		if (!invocationId || !name || runtime.handledTools.has(invocationId)) return
		runtime.handledTools.add(invocationId)
		if (
			runtime.userSpeaking ||
			runtime.waitingForUserResponse ||
			(typeof event.response_id === 'string' &&
				(runtime.finishedResponses.has(event.response_id) ||
					(runtime.responseId && event.response_id !== runtime.responseId)))
		) {
			this.send(runtime, {
				type: 'conversation.item.create',
				item: {
					type: 'function_call_output',
					call_id: invocationId,
					output: JSON.stringify({
						status: 'interrupted',
						spoken: 'The call was interrupted before this tool started. No action was executed.'
					})
				}
			})
			return
		}
		runtime.pendingTools.add(invocationId)
		runtime.toolStarted.set(invocationId, this.now())
		const inputEpoch = runtime.inputEpoch
		runtime.toolEpoch.set(invocationId, inputEpoch)
		runtime.responseHadTool = true

		void (async () => {
			let output: string
			try {
				const parsed: unknown = JSON.parse(encodedArgs)
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
					throw new Error('tool arguments must be an object')
				const tool = this.deps.tools?.(callId).find(candidate => candidate.name === name)
				if (!tool) throw new Error(`tool ${name} is not available in this call`)
				output = await tool.run(parsed as Record<string, unknown>)
			} catch (error) {
				output = JSON.stringify({
					status: 'error',
					spoken: `The relay could not run that action: ${error instanceof Error ? error.message : String(error)}`
				})
			}
			this.send(runtime, {
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: invocationId, output }
			})
			const started = runtime.toolStarted.get(invocationId)
			runtime.toolStarted.delete(invocationId)
			runtime.pendingTools.delete(invocationId)
			runtime.toolEpoch.delete(invocationId)
			const latency = started === undefined ? 'unknown latency' : `${this.now() - started}ms`
			this.log(`[voice] ${callId} tool ${name}: ${latency}`)
			if (inputEpoch === runtime.inputEpoch) this.continueAfterTools(runtime)
		})()
	}

	private logUsage(callId: string, usage: RealtimeUsage): void {
		const input = safeNumber(usage.input_tokens)
		const output = safeNumber(usage.output_tokens)
		const detailedInput =
			safeNumber(usage.input_token_details?.text_tokens) + safeNumber(usage.input_token_details?.audio_tokens)
		const detailedOutput =
			safeNumber(usage.output_token_details?.text_tokens) + safeNumber(usage.output_token_details?.audio_tokens)
		const tokens = safeNumber(usage.total_tokens) || input + output || detailedInput + detailedOutput
		const cost = estimateRealtimeCost(this.deps.model, usage)
		this.log(`[voice] ${callId} ${tokens} tokens${cost === null ? '' : `, estimated $${cost.toFixed(4)}`}`)
	}

	private onEvent(callId: string, runtime: Runtime, raw: string): void {
		let event: Record<string, unknown>
		try {
			event = JSON.parse(raw) as Record<string, unknown>
		} catch {
			this.log(`[voice] ${callId} sent an unreadable observer event`)
			return
		}
		this.deps.history?.record(callId, event)
		const type = event.type
		if (
			typeof type === 'string' &&
			/^response\.(output_audio_transcript|audio_transcript|output_text)\.delta$/.test(type) &&
			runtime.firstOutputAt === null
		)
			runtime.firstOutputAt = this.now()
		if (type === 'input_audio_buffer.speech_started') {
			runtime.inputEpoch++
			runtime.userSpeaking = true
			runtime.waitingForUserResponse = true
			runtime.responseDone = false
			runtime.responseHadTool = false
			return
		}
		if (type === 'input_audio_buffer.speech_stopped') {
			runtime.userSpeaking = false
			// Wait for committed input, not transcription (which can arrive much later).
			return
		}
		if (type === 'input_audio_buffer.committed' && runtime.managedTurns) {
			runtime.waitingForUserResponse = false
			runtime.userTurnPending = true
			this.respondToUser(runtime)
			return
		}
		if (type === 'output_audio_buffer.started') {
			runtime.playing = true
			return
		}
		if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
			runtime.playing = false
			this.flush(runtime)
			return
		}
		if (type === 'mcp_list_tools.completed') {
			if (runtime.mode !== 'mcp') return
			runtime.toolsReady = true
			this.maybeStart(runtime)
			this.flush(runtime)
			return
		}
		if (type === 'mcp_list_tools.failed') {
			this.log(`[voice] ${callId} could not import the scoped voice tools`)
			return
		}
		if (type === 'response.created') {
			// Server VAD can start a response without this sideband having sent
			// `response.create`; broker nudges must not collide with it.
			runtime.responseActive = true
			runtime.responseId = (event.response as { id?: string })?.id ?? null
			runtime.responseStartedAt = this.now()
			runtime.firstOutputAt = null
			runtime.responseDone = false
			runtime.responseHadTool = false
			if (!runtime.managedTurns) runtime.waitingForUserResponse = false
			else if (runtime.userSpeaking || runtime.waitingForUserResponse) this.send(runtime, { type: 'response.cancel' })
			return
		}
		if (type === 'response.mcp_call.in_progress' && typeof event.item_id === 'string') {
			runtime.responseHadTool = true
			runtime.pendingTools.add(event.item_id)
			runtime.toolStarted.set(event.item_id, this.now())
			runtime.toolEpoch.set(event.item_id, runtime.inputEpoch)
			return
		}
		if (type === 'response.function_call_arguments.done') {
			this.startFunction(callId, runtime, event)
			return
		}
		if (type === 'response.output_item.done' && (event.item as { type?: unknown } | undefined)?.type === 'mcp_call') {
			this.finishTool(callId, runtime, event)
			return
		}
		if (
			type === 'response.output_item.done' &&
			(event.item as { type?: unknown } | undefined)?.type === 'function_call'
		) {
			this.startFunction(callId, runtime, event)
			return
		}
		if (type === 'response.mcp_call.failed') {
			this.finishTool(callId, runtime, event)
			return
		}
		if (type === 'response.done') {
			const response = (event.response ?? {}) as {
				id?: string
				status?: string
				status_details?: { reason?: string; error?: { code?: string; type?: string } }
				usage?: RealtimeUsage | null
				output?: Record<string, unknown>[]
			}
			if (response.usage) this.logUsage(callId, response.usage)
			// Keep terminal outcomes even for an empty/cancelled answer, without logging prompts or errors containing secrets.
			const safe = (value: unknown) =>
				typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) : 'none'
			this.log(
				`[voice] ${callId} response ${safe(response.id)} status=${safe(response.status)} reason=${safe(response.status_details?.reason)} code=${safe(response.status_details?.error?.code ?? response.status_details?.error?.type)} first_output_ms=${runtime.firstOutputAt === null ? 'none' : runtime.firstOutputAt - runtime.responseStartedAt}`
			)
			if (response.id && runtime.finishedResponses.has(response.id)) return
			if (response.id) {
				runtime.finishedResponses.add(response.id)
				if (runtime.finishedResponses.size > 256)
					runtime.finishedResponses.delete(runtime.finishedResponses.values().next().value!)
			}
			if (response.id && runtime.responseId && response.id !== runtime.responseId) return
			runtime.responseActive = false
			runtime.responseId = null
			runtime.responseDone = !response.status || response.status === 'completed'
			if (runtime.typed.length) {
				this.flushTyped(runtime)
				return
			}
			if (runtime.userTurnPending) {
				this.respondToUser(runtime)
				return
			}
			if (!runtime.responseDone || runtime.waitingForUserResponse) {
				runtime.responseHadTool = false
				return
			}
			for (const item of response.output ?? []) {
				if (item.type === 'mcp_call') runtime.responseHadTool = true
				if (item.type === 'function_call') this.startFunction(callId, runtime, { item })
			}
			if (runtime.responseHadTool) {
				this.continueAfterTools(runtime)
				return
			}
			runtime.responseDone = false
			if (!runtime.greeted) {
				runtime.greeted = true
				const call = this.calls.get(callId)
				if (call) {
					call.greeted = true
					this.persist()
				}
			}
			this.flush(runtime)
		}
	}

	private flushTyped(runtime: Runtime): void {
		if (runtime.responseActive || !runtime.typed.length) return
		for (const text of runtime.typed.splice(0)) {
			this.send(runtime, {
				type: 'conversation.item.create',
				item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
			})
		}
		this.createResponse(runtime)
	}

	private respondToUser(runtime: Runtime): void {
		if (runtime.userTurnPending && this.createResponse(runtime)) runtime.userTurnPending = false
	}

	/** All typed turns share the sideband scheduler with tools and background receipts. */
	sendText(callId: string, text: string): boolean {
		const runtime = this.runtimes.get(callId)
		if (runtime?.mode !== 'function' || !runtime.ready || runtime.socket.readyState !== 1) return false
		runtime.inputEpoch++
		runtime.userSpeaking = false
		runtime.waitingForUserResponse = false
		runtime.userTurnPending = false
		runtime.responseDone = false
		runtime.responseHadTool = false
		runtime.typed.push(text)
		this.send(runtime, { type: 'input_audio_buffer.clear' })
		if (runtime.responseActive) this.send(runtime, { type: 'response.cancel' })
		this.send(runtime, { type: 'output_audio_buffer.clear' })
		this.flushTyped(runtime)
		return true
	}

	isBrowserCall(callId: string): boolean {
		return this.calls.get(callId)?.mode === 'function'
	}

	/** Attach the relay sideband before the browser receives its SDP answer. */
	registerWebRtc(callId: string, options: VoiceCallOptions = {}): void {
		this.calls.set(callId, {
			callId,
			acceptedAt: this.now(),
			mode: 'function',
			managedTurns: true,
			ready: false,
			greeted: false
		})
		this.persist()
		this.deps.history?.start({
			callId,
			startedAt: this.now(),
			transport: 'webrtc',
			model: this.deps.model,
			voice: options.voice ?? this.deps.voice,
			language: options.language ?? 'auto'
		})
		this.attach(callId)
	}

	/** The browser calls this only after it has installed the remote SDP answer. */
	beginWebRtc(callId: string): boolean {
		const call = this.calls.get(callId)
		if (call?.mode !== 'function') return false
		call.ready = true
		this.persist()
		const runtime = this.runtimes.get(callId)
		if (runtime) {
			runtime.ready = true
			this.maybeStart(runtime)
		}
		return true
	}

	/** End only a relay-created browser call; SIP calls remain owned by their phone leg. */
	async hangupWebRtc(callId: string): Promise<boolean> {
		const call = this.calls.get(callId)
		if (call?.mode !== 'function') return false
		const response = await this.fetcher(`${this.apiOrigin}/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.deps.apiKey}` }
		})
		const runtime = this.runtimes.get(callId)
		// Retire the observer before closing it: a synchronous close callback must
		// not label this deliberate hang-up as a missing stretch of conversation.
		this.forget(callId, runtime)
		try {
			runtime?.socket.close()
		} finally {
			this.deps.history?.finish(callId, response.ok ? 'ended' : 'interrupted')
		}
		if (!response.ok) throw new Error(`OpenAI call hangup returned ${response.status}: ${await response.text()}`)
		return true
	}

	/** Queue a broker-authored line; it cannot overtake tool import or the call's greeting. */
	inject(callId: string, text: string): boolean {
		const runtime = this.runtimes.get(callId)
		if (!runtime) return false
		runtime.pending.push(text)
		this.flush(runtime)
		return true
	}
}
