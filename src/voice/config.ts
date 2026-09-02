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

/** The listener's loopback port. Non-secret, so it may ride the plist like its siblings. */
export function voicePort(): number {
	const raw = Number(process.env.VOICE_PORT)
	return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 8788
}

export interface VoiceConfig {
	/** Scoped bearer for `/voice/mcp`. Minted on first read; never the relay token. */
	mcpToken: string
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
}

export function voiceConfigPath(): string {
	return path.join(stateDir(), 'voice.json')
}

const EMPTY: Omit<VoiceConfig, 'mcpToken'> = {
	webhookSecret: null,
	openaiKey: null,
	twilioAuthToken: null,
	allowedCallers: [],
	pin: null
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
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
		webhookSecret: asStringOrNull(raw.webhookSecret),
		openaiKey: asStringOrNull(raw.openaiKey),
		twilioAuthToken: asStringOrNull(raw.twilioAuthToken),
		allowedCallers: Array.isArray(raw.allowedCallers)
			? raw.allowedCallers.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).map(c => c.trim())
			: [],
		pin: asStringOrNull(raw.pin)
	}
	if (asStringOrNull(raw.mcpToken) !== config.mcpToken) writeVoiceConfig(config, file)
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
