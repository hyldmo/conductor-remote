import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '../src/mcp-tools.ts'
import {
	type BrokerSocket,
	type BrokerSocketFactory,
	buildAcceptBody,
	estimateRealtimeCost,
	VoiceBroker
} from '../src/voice/broker.ts'
import { VOICE_INSTRUCTIONS } from '../src/voice/prompt.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

class FakeSocket implements BrokerSocket {
	readyState = 0
	sent: string[] = []
	private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()

	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
		const list = this.listeners.get(type) ?? []
		list.push(listener)
		this.listeners.set(type, list)
	}

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.emit('close')
	}

	emit(type: string, data?: unknown): void {
		if (type === 'open') this.readyState = 1
		for (const listener of this.listeners.get(type) ?? []) listener({ data })
	}

	event(value: unknown): void {
		this.emit('message', JSON.stringify(value))
	}
}

function setup(apiOrigin = 'https://api.openai.com') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-broker-'))
	dirs.push(dir)
	const sockets: FakeSocket[] = []
	const socketFactory: BrokerSocketFactory = vi.fn(() => {
		const socket = new FakeSocket()
		sockets.push(socket)
		return socket
	})
	const fetcher = vi.fn(
		async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
			new Response(null, { status: 200 })
	)
	const logs: string[] = []
	const onClose = vi.fn()
	const functionToolRun = vi.fn(async (args: Record<string, unknown>) =>
		JSON.stringify({ spoken: `fleet ${args.cursor}` })
	)
	const functionTools: Tool[] = [
		{
			name: 'voice_roll_call',
			description: 'Roll call',
			inputSchema: { type: 'object' },
			run: functionToolRun
		}
	]
	let now = 1_000
	const broker = new VoiceBroker({
		apiKey: 'sk-test-secret',
		apiOrigin,
		model: 'gpt-realtime-2.1-mini',
		voice: 'marin',
		mcpUrl: 'https://mac.example/voice/mcp',
		mcpToken: 'voice-only-token',
		stateFile: path.join(dir, 'voice-calls.json'),
		fetch: fetcher,
		socket: socketFactory,
		log: line => logs.push(line),
		tools: () => functionTools,
		onClose,
		now: () => now
	})
	return {
		broker,
		sockets,
		socketFactory,
		fetcher,
		logs,
		onClose,
		functionToolRun,
		advance: (ms: number) => (now += ms)
	}
}

describe('the call accept payload', () => {
	it('uses the current mini model and exposes only the scoped MCP tools', () => {
		const body = buildAcceptBody({
			callId: 'rtc_1',
			model: 'gpt-realtime-2.1-mini',
			voice: 'marin',
			mcpUrl: 'https://mac.example/voice/mcp',
			mcpToken: 'voice-only-token',
			instructions: VOICE_INSTRUCTIONS
		})
		expect(body).toMatchObject({
			type: 'realtime',
			model: 'gpt-realtime-2.1-mini',
			instructions: VOICE_INSTRUCTIONS,
			audio: { output: { voice: 'marin' } },
			tools: [
				{
					type: 'mcp',
					server_label: 'conductor_voice',
					server_url: 'https://mac.example/voice/mcp',
					headers: { authorization: 'Bearer voice-only-token', 'x-voice-call-id': 'rtc_1' },
					require_approval: 'never',
					allowed_tools: [
						'voice_roll_call',
						'voice_workspace_overview',
						'voice_next_decision',
						'voice_list_repos',
						'voice_create_workspace_preview',
						'voice_create_workspace',
						'voice_send_preview',
						'voice_send'
					]
				}
			]
		})
	})
})

describe('VoiceBroker', () => {
	it('accepts, persists, and opens the authenticated observer socket', async () => {
		const { broker, sockets, socketFactory, fetcher } = setup()
		await broker.accept('rtc_1')
		expect(fetcher).toHaveBeenCalledWith(
			'https://api.openai.com/v1/realtime/calls/rtc_1/accept',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ authorization: 'Bearer sk-test-secret' })
			})
		)
		expect(socketFactory).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?call_id=rtc_1', {
			authorization: 'Bearer sk-test-secret'
		})
		expect(sockets).toHaveLength(1)
		expect(JSON.parse(fs.readFileSync(broker.stateFile, 'utf8'))).toEqual([
			{ callId: 'rtc_1', acceptedAt: 1_000, mode: 'mcp', ready: true, greeted: false }
		])
		expect(fs.statSync(broker.stateFile).mode & 0o777).toBe(0o600)
	})

	it('applies a voice and language prompt to one call without changing broker defaults', async () => {
		const { broker, fetcher } = setup()
		await broker.accept('rtc_nb', { voice: 'cedar', instructions: 'Speak Norwegian Bokmål.' })
		const request = fetcher.mock.calls[0]?.[1]
		const body = JSON.parse(String(request?.body)) as {
			instructions: string
			audio: { output: { voice: string } }
		}
		expect(body.audio.output.voice).toBe('cedar')
		expect(body.instructions).toBe('Speak Norwegian Bokmål.')

		await broker.accept('rtc_default')
		const defaultRequest = fetcher.mock.calls[1]?.[1]
		const defaultBody = JSON.parse(String(defaultRequest?.body)) as {
			instructions: string
			audio: { output: { voice: string } }
		}
		expect(defaultBody.audio.output.voice).toBe('marin')
		expect(defaultBody.instructions).toBe(VOICE_INSTRUCTIONS)
	})

	it('attaches a browser call before waiting for the ready receipt to greet', () => {
		const { broker, sockets } = setup()
		broker.registerWebRtc('rtc_browser')
		const socket = sockets[0]
		socket.emit('open')
		expect(socket.sent).toEqual([])
		expect(broker.beginWebRtc('rtc_browser')).toBe(true)
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'response.create' }])
		expect(JSON.parse(fs.readFileSync(broker.stateFile, 'utf8'))).toEqual([
			{ callId: 'rtc_browser', acceptedAt: 1_000, mode: 'function', ready: true, greeted: false }
		])
	})

	it('executes browser function calls locally and continues after both barriers finish', async () => {
		const { broker, sockets, functionToolRun } = setup()
		broker.registerWebRtc('rtc_browser')
		const socket = sockets[0]
		socket.emit('open')
		broker.beginWebRtc('rtc_browser')
		socket.sent.splice(0)

		socket.event({
			type: 'response.function_call_arguments.done',
			call_id: 'fn_1',
			item_id: 'item_1',
			name: 'voice_roll_call',
			arguments: '{"cursor":2}'
		})
		await vi.waitFor(() => expect(functionToolRun).toHaveBeenCalledWith({ cursor: 2 }))
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([
			{
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: 'fn_1', output: '{"spoken":"fleet 2"}' }
			}
		])

		socket.event({
			type: 'response.done',
			response: {
				output: [
					{
						type: 'function_call',
						call_id: 'fn_1',
						name: 'voice_roll_call',
						arguments: '{"cursor":2}'
					}
				]
			}
		})
		expect(socket.sent.map(value => JSON.parse(value)).at(-1)).toEqual({ type: 'response.create' })
		expect(functionToolRun).toHaveBeenCalledTimes(1)
	})

	it('hangs up only a browser-owned call and drops its persisted state', async () => {
		const { broker, sockets, fetcher } = setup()
		broker.registerWebRtc('rtc_browser')
		sockets[0].emit('open')
		await expect(broker.hangupWebRtc('rtc_browser')).resolves.toBe(true)
		expect(fetcher).toHaveBeenCalledWith(
			'https://api.openai.com/v1/realtime/calls/rtc_browser/hangup',
			expect.objectContaining({ method: 'POST' })
		)
		expect(JSON.parse(fs.readFileSync(broker.stateFile, 'utf8'))).toEqual([])
		await expect(broker.hangupWebRtc('rtc_missing')).resolves.toBe(false)
	})

	it('waits for tool import and the greeting before injecting a nudge', async () => {
		const { broker, sockets } = setup()
		await broker.accept('rtc_1')
		const socket = sockets[0]
		expect(broker.inject('rtc_1', 'The build failed.')).toBe(true)
		socket.emit('open')
		expect(socket.sent).toEqual([])
		socket.event({ type: 'mcp_list_tools.completed' })
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'response.create' }])
		socket.event({ type: 'response.done', response: { usage: null } })
		expect(socket.sent.map(value => JSON.parse(value)).slice(1)).toEqual([
			{
				type: 'conversation.item.create',
				item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The build failed.' }] }
			},
			{ type: 'response.create' }
		])
	})

	it('does not inject a broker nudge over a response already in flight', async () => {
		const { broker, sockets } = setup()
		await broker.accept('rtc_1')
		const socket = sockets[0]
		socket.emit('open')
		socket.event({ type: 'mcp_list_tools.completed' })
		socket.event({ type: 'response.done', response: {} })
		socket.sent.splice(0)

		socket.event({ type: 'response.created' })
		expect(broker.inject('rtc_1', 'The send parked.')).toBe(true)
		expect(socket.sent).toEqual([])
		socket.event({ type: 'response.done', response: {} })
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([
			{
				type: 'conversation.item.create',
				item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The send parked.' }] }
			},
			{ type: 'response.create' }
		])
	})

	it('waits for response.done after an MCP result before continuing', async () => {
		const { broker, sockets, logs, advance } = setup()
		await broker.accept('rtc_1')
		const socket = sockets[0]
		socket.emit('open')
		socket.event({ type: 'response.mcp_call.in_progress', item_id: 'm1' })
		advance(125)
		socket.event({
			type: 'response.output_item.done',
			item: { id: 'm1', type: 'mcp_call', name: 'voice_roll_call', server_label: 'conductor_voice' }
		})
		expect(socket.sent).toEqual([])
		expect(logs.some(line => line.includes('voice_roll_call') && line.includes('125ms'))).toBe(true)

		socket.event({
			type: 'response.done',
			response: {
				output: [{ id: 'm1', type: 'mcp_call', status: 'completed' }],
				usage: {
					input_token_details: { text_tokens: 1_000, audio_tokens: 2_000, cached_tokens: 0 },
					output_token_details: { text_tokens: 500, audio_tokens: 1_000 }
				}
			}
		})
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'response.create' }])
		expect(logs.some(line => line.includes('tokens') && line.includes('$0.0418'))).toBe(true)
	})

	it('also waits for a still-running MCP call when response.done arrives first', async () => {
		const { broker, sockets } = setup()
		await broker.accept('rtc_1')
		const socket = sockets[0]
		socket.emit('open')
		socket.event({ type: 'response.mcp_call.in_progress', item_id: 'm1' })
		socket.event({
			type: 'response.done',
			response: { output: [{ id: 'm1', type: 'mcp_call', status: 'in_progress' }] }
		})
		expect(socket.sent).toEqual([])
		socket.event({
			type: 'response.output_item.done',
			item: { id: 'm1', type: 'mcp_call', name: 'voice_roll_call', server_label: 'conductor_voice' }
		})
		expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'response.create' }])
	})

	it('reattaches persisted active calls after a relay restart', async () => {
		const first = setup()
		await first.broker.accept('rtc_1')
		const restoredSockets: FakeSocket[] = []
		const restored = new VoiceBroker({
			apiKey: 'sk-test-secret',
			apiOrigin: 'https://api.openai.com',
			model: 'gpt-realtime-2.1-mini',
			voice: 'marin',
			mcpUrl: 'https://mac.example/voice/mcp',
			mcpToken: 'voice-only-token',
			stateFile: first.broker.stateFile,
			fetch: async () => new Response(null, { status: 200 }),
			socket: () => {
				const socket = new FakeSocket()
				restoredSockets.push(socket)
				return socket
			},
			log: () => {}
		})
		await restored.restore()
		expect(restoredSockets).toHaveLength(1)
	})

	it('releases per-call state when the observer closes', async () => {
		const { broker, sockets, onClose } = setup()
		await broker.accept('rtc_1')
		sockets[0].close()
		expect(onClose).toHaveBeenCalledWith('rtc_1')
		expect(JSON.parse(fs.readFileSync(broker.stateFile, 'utf8'))).toEqual([])
	})

	it("keeps accept and observer traffic on an EU project's regional origin", async () => {
		const { broker, fetcher, socketFactory } = setup('https://eu.api.openai.com')
		await broker.accept('rtc_eu')
		expect(fetcher).toHaveBeenCalledWith(
			'https://eu.api.openai.com/v1/realtime/calls/rtc_eu/accept',
			expect.any(Object)
		)
		expect(socketFactory).toHaveBeenCalledWith('wss://eu.api.openai.com/v1/realtime?call_id=rtc_eu', {
			authorization: 'Bearer sk-test-secret'
		})
	})
})

describe('estimateRealtimeCost', () => {
	it('uses the published mini text and audio rates', () => {
		expect(
			estimateRealtimeCost('gpt-realtime-2.1-mini', {
				input_token_details: { text_tokens: 1_000, audio_tokens: 2_000, cached_tokens: 0 },
				output_token_details: { text_tokens: 500, audio_tokens: 1_000 }
			})
		).toBeCloseTo(0.0418, 8)
	})
})
