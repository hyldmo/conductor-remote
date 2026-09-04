/** Short-lived SIP tickets issued to a native client authenticated to the main relay. */
import type { VoiceConfig } from './config.ts'
import { MARKER_MAX_AGE_SECONDS, mintMarker, sipTicketUri } from './twiml.ts'

export interface SipTicket {
	/** Complete URI for the SIP stack. It contains no OpenAI API key. */
	uri: string
	/** ISO-8601 instant after which the relay marker will be refused. */
	expiresAt: string
}

/** Settings required before a ticket has any chance of becoming an accepted call. */
export function missingTicketConfig(config: VoiceConfig): string[] {
	const missing: string[] = []
	if (!config.projectId) missing.push('voice.project-id')
	if (!config.openaiKey) missing.push('voice.openai-key')
	if (!config.webhookSecret) missing.push('voice.webhook-secret')
	if (!config.publicBaseUrl) missing.push('voice.public-url')
	return missing
}

/** Mint only after `missingTicketConfig` is empty. The marker's nonce makes every URI fresh. */
export function mintSipTicket(config: VoiceConfig, nowMs: number = Date.now()): SipTicket {
	if (!config.projectId) throw new Error('voice.project-id is not configured')
	return {
		uri: sipTicketUri(config.projectId, mintMarker(config.trunkSecret, nowMs), config.sipHost),
		expiresAt: new Date(nowMs + MARKER_MAX_AGE_SECONDS * 1000).toISOString()
	}
}
