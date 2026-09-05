import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { VoiceConfig } from '../../src/voice/config.ts'
import { createVoiceGateway } from '../../src/voice/gateway.ts'
import { mintMarker, twilioSignature } from '../../src/voice/twiml.ts'
import { webhookKey } from '../../src/voice/webhook.ts'

const NOW = 1_788_347_464_000
const SECRET = `whsec_${Buffer.from('webhook signing secret').toString('base64')}`
const config: VoiceConfig = {
	mcpToken: 'mcp-token',
	trunkSecret: 'trunk-secret',
	webhookSecret: SECRET,
	openaiKey: 'sk-test',
	twilioAuthToken: 'twilio-secret',
	allowedCallers: ['+47 123 45 678'],
	pin: '2468',
	projectId: 'proj_CaseSensitive',
	publicBaseUrl: 'https://mac.example/voice',
	model: 'gpt-realtime-2.1-mini',
	reasoningEffort: 'medium',
	voice: 'marin',
	speed: 1.25,
	sipHost: 'sip.api.openai.com'
}

function signed(body: string, id = 'wh_1') {
	const at = Math.floor(NOW / 1000)
	const mac = crypto.createHmac('sha256', webhookKey(SECRET)).update(`${id}.${at}.${body}`).digest('base64')
	return { 'webhook-id': id, 'webhook-timestamp': String(at), 'webhook-signature': `v1,${mac}` }
}

function harness() {
	const broker = { accept: vi.fn(async () => {}), reject: vi.fn(async () => {}) }
	const gateway = createVoiceGateway({
		config: () => config,
		broker: () => broker,
		rpc: async () => null,
		now: () => NOW,
		log: () => {}
	})
	return { gateway, broker }
}

describe('the public voice gateway', () => {
	it('requires the broker-provided call id before creating per-call MCP state', async () => {
		const rpc = vi.fn(async () => ({ ok: true }))
		const gateway = createVoiceGateway({
			config: () => config,
			broker: () => null,
			rpc,
			now: () => NOW,
			log: () => {}
		})
		const request = { jsonrpc: '2.0', id: 4, method: 'tools/list' }
		await expect(gateway.rpc(request, {})).resolves.toMatchObject({ error: { code: -32600 } })
		expect(rpc).not.toHaveBeenCalled()
		await gateway.rpc(request, { 'x-voice-call-id': 'rtc_4' })
		expect(rpc).toHaveBeenCalledWith('rtc_4', request)
	})

	it('gathers a PIN only for a signed, allowlisted Twilio caller', async () => {
		const { gateway } = harness()
		const params = { CallSid: 'CA1', From: '+4712345678', To: '+4700000000' }
		const body = new URLSearchParams(params).toString()
		const reply = await gateway.twiml(body, {
			'x-twilio-signature': twilioSignature(`${config.publicBaseUrl}/twiml`, params, config.twilioAuthToken as string)
		})
		expect(reply.status).toBe(200)
		expect(reply.body).toContain('<Gather')
		expect(reply.body).not.toContain('sip:proj_')
	})

	it('bridges only the exact PIN and preserves the case-sensitive project id', async () => {
		const { gateway } = harness()
		const params = { CallSid: 'CA1', From: '+4712345678', To: '+4700000000', Digits: '2468' }
		const body = new URLSearchParams(params).toString()
		const reply = await gateway.twiml(body, {
			'x-twilio-signature': twilioSignature(`${config.publicBaseUrl}/twiml`, params, config.twilioAuthToken as string)
		})
		expect(reply.status).toBe(200)
		expect(reply.body).toContain('sip:proj_CaseSensitive@sip.api.openai.com;transport=tls')
		expect(reply.body).toContain('X-Relay-Call=')
	})

	it('accepts a signed OpenAI event only when its trunk marker verifies', async () => {
		const { gateway, broker } = harness()
		const body = JSON.stringify({
			type: 'realtime.call.incoming',
			data: {
				call_id: 'rtc_1',
				sip_headers: [{ name: 'X-Relay-Call', value: mintMarker(config.trunkSecret, NOW, 'nonce') }]
			}
		})
		const reply = await gateway.webhook(body, signed(body))
		expect(reply).toMatchObject({ status: 200, body: 'accepted' })
		expect(broker.accept).toHaveBeenCalledWith('rtc_1')
		expect(broker.reject).not.toHaveBeenCalled()
	})

	it('declines a direct SIP dial and refuses a replayed webhook delivery', async () => {
		const { gateway, broker } = harness()
		const body = JSON.stringify({
			type: 'realtime.call.incoming',
			data: { call_id: 'rtc_direct', sip_headers: [] }
		})
		expect(await gateway.webhook(body, signed(body))).toMatchObject({ status: 200, body: 'rejected' })
		expect(broker.reject).toHaveBeenCalledWith('rtc_direct')
		expect(await gateway.webhook(body, signed(body))).toMatchObject({ status: 409 })
	})

	it('allows OpenAI to retry when the first accept attempt failed', async () => {
		const { gateway, broker } = harness()
		broker.accept.mockRejectedValueOnce(new Error('temporary API failure'))
		const body = JSON.stringify({
			type: 'realtime.call.incoming',
			data: {
				call_id: 'rtc_retry',
				sip_headers: [{ name: 'X-Relay-Call', value: mintMarker(config.trunkSecret, NOW, 'retry') }]
			}
		})
		await expect(gateway.webhook(body, signed(body, 'wh_retry'))).rejects.toThrow('temporary API failure')
		await expect(gateway.webhook(body, signed(body, 'wh_retry'))).resolves.toMatchObject({
			status: 200,
			body: 'accepted'
		})
		expect(broker.accept).toHaveBeenCalledTimes(2)
	})
})
