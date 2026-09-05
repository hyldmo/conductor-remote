/**
 * The voice layer's own secrets and knobs, in `stateDir()/voice.json` at 0600.
 *
 * Separate from the relay's token file for one reason (design ▸ D4): the token that reaches
 * OpenAI's session store must not be the one that drives this Mac. The relay token is full
 * remote control; this one reaches `createVoiceTools` and nothing else. They are different
 * secrets in different files so that no future refactor can quietly make them the same.
 *
 * Not `settings.json`, which `/api/settings` serves to the phone. Not the LaunchAgent plist,
 * which is user-readable and which `scripts/service.ts` already keeps the relay token out of.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../config.ts'
import { isVoiceSpeed } from '../shared.ts'

export const VOICE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type VoiceReasoningEffort = (typeof VOICE_REASONING_EFFORTS)[number]
export const DEFAULT_VOICE_REASONING_EFFORT: VoiceReasoningEffort = 'medium'
export const DEFAULT_VOICE_SPEED = 1.25

function isVoiceReasoningEffort(value: unknown): value is VoiceReasoningEffort {
	return typeof value === 'string' && (VOICE_REASONING_EFFORTS as readonly string[]).includes(value)
}

/** Older non-reasoning voice models remain selectable through voice.model. */
export function voiceReasoning(model: string, effort = DEFAULT_VOICE_REASONING_EFFORT) {
	return /^gpt-realtime-2(?:[.-]|$)/.test(model) ? { reasoning: { effort } } : {}
}

/** The listener's loopback port. Non-secret, so it may ride the plist like its siblings. */
export function voicePort(): number {
	const raw = Number(process.env.VOICE_PORT)
	return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 8788
}

export interface VoiceConfig {
	/** Scoped bearer for `/voice/mcp`. Minted on first read; never the relay token. */
	mcpToken: string
	/** HMAC key carried through Twilio and re-checked on the OpenAI webhook. */
	trunkSecret: string
	/** OpenAI's Standard Webhooks signing secret for `realtime.call.incoming` (`whsec_…`). */
	webhookSecret: string | null
	/** OpenAI API key: accepts the call and opens the observer socket. */
	openaiKey: string | null
	/** Twilio auth token, for the `X-Twilio-Signature` check on the TwiML leg. */
	twilioAuthToken: string | null
	/** Caller ids allowed as far as the PIN prompt. Empty means nobody, which is the safe default. */
	allowedCallers: string[]
	/** DTMF PIN gathered before OpenAI is bridged. Null disables the bridge outright. */
	pin: string | null
	/** Case-sensitive OpenAI project id used as the SIP user part. */
	projectId: string | null
	/** Public mount, e.g. `https://mac.example.ts.net/voice`. */
	publicBaseUrl: string | null
	model: string
	reasoningEffort: VoiceReasoningEffort
	voice: string
	/** Realtime output multiplier; applied to both WebRTC and SIP calls. */
	speed: number
	sipHost: string
}

export function voiceConfigPath(): string {
	return path.join(stateDir(), 'voice.json')
}

const EMPTY: Omit<VoiceConfig, 'mcpToken' | 'trunkSecret'> = {
	webhookSecret: null,
	openaiKey: null,
	twilioAuthToken: null,
	allowedCallers: [],
	pin: null,
	projectId: null,
	publicBaseUrl: null,
	model: 'gpt-realtime-2.1',
	reasoningEffort: DEFAULT_VOICE_REASONING_EFFORT,
	voice: 'marin',
	speed: DEFAULT_VOICE_SPEED,
	sipHost: 'sip.api.openai.com'
}

export function openAIOriginForSipHost(sipHost: string): string {
	switch (sipHost) {
		case 'sip.api.openai.com':
			return 'https://api.openai.com'
		case 'sip-eu.api.openai.com':
			return 'https://eu.api.openai.com'
		default:
			throw new Error('voice.sip-host must be sip.api.openai.com or sip-eu.api.openai.com')
	}
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedPublicUrl(value: string | null): string | null {
	if (!value) return null
	const trimmed = value.replace(/\/+$/, '')
	return trimmed.endsWith('/voice') ? trimmed : `${trimmed}/voice`
}

/**
 * Read the file, minting the scoped token on first use. A malformed file is treated as an empty
 * one rather than thrown: the listener refusing to start is a worse failure than a re-mint, and
 * every secret in here is re-enterable while a lost token only costs one dashboard edit.
 */
export function readVoiceConfig(file: string = voiceConfigPath()): VoiceConfig {
	let raw: Record<string, unknown> = {}
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
	} catch {
		// absent or unreadable — fall through to defaults and mint below
	}
	const config: VoiceConfig = {
		...EMPTY,
		mcpToken: asStringOrNull(raw.mcpToken) ?? crypto.randomBytes(16).toString('hex'),
		trunkSecret: asStringOrNull(raw.trunkSecret) ?? crypto.randomBytes(32).toString('hex'),
		webhookSecret: asStringOrNull(raw.webhookSecret),
		openaiKey: asStringOrNull(raw.openaiKey),
		twilioAuthToken: asStringOrNull(raw.twilioAuthToken),
		allowedCallers: Array.isArray(raw.allowedCallers)
			? raw.allowedCallers.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).map(c => c.trim())
			: [],
		pin: asStringOrNull(raw.pin),
		projectId: asStringOrNull(raw.projectId),
		publicBaseUrl: normalizedPublicUrl(asStringOrNull(raw.publicBaseUrl)),
		model: asStringOrNull(raw.model) ?? EMPTY.model,
		reasoningEffort: isVoiceReasoningEffort(raw.reasoningEffort) ? raw.reasoningEffort : EMPTY.reasoningEffort,
		voice: asStringOrNull(raw.voice) ?? EMPTY.voice,
		speed: isVoiceSpeed(raw.speed) ? raw.speed : EMPTY.speed,
		sipHost: asStringOrNull(raw.sipHost) ?? EMPTY.sipHost
	}
	if (asStringOrNull(raw.mcpToken) !== config.mcpToken || asStringOrNull(raw.trunkSecret) !== config.trunkSecret)
		writeVoiceConfig(config, file)
	return config
}

/** Write 0600, creating the directory. The mode is set explicitly on an existing file too. */
export function writeVoiceConfig(config: VoiceConfig, file: string = voiceConfigPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
	try {
		fs.chmodSync(file, 0o600)
	} catch {
		// a file we just wrote; if the mode cannot be set the write above already failed loudly
	}
}

export const VOICE_SETTING_NAMES = [
	'voice.openai-key',
	'voice.webhook-secret',
	'voice.twilio-auth-token',
	'voice.allowed-callers',
	'voice.pin',
	'voice.project-id',
	'voice.public-url',
	'voice.model',
	'voice.reasoning-effort',
	'voice.voice',
	'voice.speed',
	'voice.sip-host'
] as const

/** Apply one CLI setting without ever returning or printing the secret value. `unset` clears nullable fields. */
export function setVoiceSetting(name: string, value: string, file: string = voiceConfigPath()): VoiceConfig {
	if (!(VOICE_SETTING_NAMES as readonly string[]).includes(name)) throw new Error(`unknown voice setting "${name}"`)
	const config = readVoiceConfig(file)
	const nullable = value === 'unset' ? null : value.trim() || null
	switch (name) {
		case 'voice.openai-key':
			config.openaiKey = nullable
			break
		case 'voice.webhook-secret':
			config.webhookSecret = nullable
			break
		case 'voice.twilio-auth-token':
			config.twilioAuthToken = nullable
			break
		case 'voice.allowed-callers':
			config.allowedCallers =
				value === 'unset'
					? []
					: value
							.split(',')
							.map(item => item.trim())
							.filter(Boolean)
			break
		case 'voice.pin':
			if (nullable && !/^\d{4,12}$/.test(nullable)) throw new Error('voice.pin must be 4–12 digits or unset')
			config.pin = nullable
			break
		case 'voice.project-id':
			config.projectId = nullable
			break
		case 'voice.public-url':
			if (nullable && !/^https:\/\/[^/]+(?:\/voice)?\/?$/.test(nullable))
				throw new Error('voice.public-url must be an HTTPS origin optionally ending in /voice, or unset')
			config.publicBaseUrl = normalizedPublicUrl(nullable)
			break
		case 'voice.model':
			if (!nullable) throw new Error('voice.model cannot be unset')
			config.model = nullable
			break
		case 'voice.reasoning-effort':
			if (!isVoiceReasoningEffort(nullable))
				throw new Error(`voice.reasoning-effort must be one of ${VOICE_REASONING_EFFORTS.join(', ')}`)
			config.reasoningEffort = nullable
			break
		case 'voice.voice':
			if (!nullable) throw new Error('voice.voice cannot be unset')
			config.voice = nullable
			break
		case 'voice.speed': {
			const speed = value === 'unset' ? DEFAULT_VOICE_SPEED : Number(value)
			if (!isVoiceSpeed(speed)) throw new Error('voice.speed must be a number from 0.25 to 1.5, or unset')
			config.speed = speed
			break
		}
		case 'voice.sip-host':
			if (!nullable) throw new Error('voice.sip-host cannot be unset')
			openAIOriginForSipHost(nullable)
			config.sipHost = nullable
			break
	}
	writeVoiceConfig(config, file)
	return config
}
