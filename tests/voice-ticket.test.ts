import { describe, expect, it } from 'vitest'
import type { VoiceConfig } from '../src/voice/config.ts'
import { mintSipTicket, missingTicketConfig } from '../src/voice/ticket.ts'
import { MARKER_MAX_AGE_SECONDS, verifyMarker } from '../src/voice/twiml.ts'

const NOW = 1_788_347_464_000
const config: VoiceConfig = {
	mcpToken: 'mcp-token',
	trunkSecret: 'trunk-secret',
	webhookSecret: 'whsec_test',
	openaiKey: 'sk-test',
	twilioAuthToken: null,
	allowedCallers: [],
	pin: null,
	projectId: 'proj_CaseSensitive',
	publicBaseUrl: 'https://mac.example/voice',
	model: 'gpt-realtime',
	reasoningEffort: 'medium',
	voice: 'marin',
	sipHost: 'sip.api.openai.com'
}

describe('native SIP tickets', () => {
	it('preserves the project id, forces TLS, and carries a verifiable relay marker', () => {
		const ticket = mintSipTicket(config, NOW)
		expect(ticket.uri).toMatch(/^sip:proj_CaseSensitive@sip\.api\.openai\.com;transport=tls\?X-Relay-Call=/)
		const marker = new URL(ticket.uri.replace('sip:', 'https://')).searchParams.get('X-Relay-Call')
		expect(verifyMarker(marker, config.trunkSecret, NOW)).toEqual({ ok: true })
		expect(ticket.expiresAt).toBe(new Date(NOW + MARKER_MAX_AGE_SECONDS * 1000).toISOString())
	})

	it('mints a fresh URI for every request', () => {
		expect(mintSipTicket(config, NOW).uri).not.toBe(mintSipTicket(config, NOW).uri)
	})

	it('names every missing setting instead of issuing a ticket that can only fail', () => {
		expect(
			missingTicketConfig({
				...config,
				projectId: null,
				openaiKey: null,
				webhookSecret: null,
				publicBaseUrl: null
			})
		).toEqual(['voice.project-id', 'voice.openai-key', 'voice.webhook-secret', 'voice.public-url'])
	})
})
