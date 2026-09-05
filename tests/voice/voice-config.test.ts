import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactSecrets } from '../../src/host/logbuf.ts'
import { openAIOriginForSipHost, readVoiceConfig, setVoiceSetting, writeVoiceConfig } from '../../src/voice/config.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function file(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-config-'))
	dirs.push(dir)
	return path.join(dir, 'voice.json')
}

describe('voice config', () => {
	it('mints distinct scoped secrets and defaults to GPT-Realtime-2.1', () => {
		const target = file()
		const config = readVoiceConfig(target)
		expect(config.mcpToken).toHaveLength(32)
		expect(config.trunkSecret).toHaveLength(64)
		expect(config.trunkSecret).not.toBe(config.mcpToken)
		expect(config.model).toBe('gpt-realtime-2.1')
		expect(config.reasoningEffort).toBe('medium')
		expect(config.sipHost).toBe('sip.api.openai.com')
		expect(fs.statSync(target).mode & 0o777).toBe(0o600)
	})

	it('persists effort independently of the model and refuses invalid effort without changing the file', () => {
		const target = file()
		const original = readVoiceConfig(target)
		setVoiceSetting('voice.reasoning-effort', 'low', target)
		expect(readVoiceConfig(target)).toMatchObject({
			model: 'gpt-realtime-2.1',
			reasoningEffort: 'low',
			mcpToken: original.mcpToken
		})
		const saved = fs.readFileSync(target, 'utf8')
		expect(() => setVoiceSetting('voice.reasoning-effort', 'none', target)).toThrow(/voice.reasoning-effort/)
		expect(fs.readFileSync(target, 'utf8')).toBe(saved)
		setVoiceSetting('voice.reasoning-effort', 'medium', target)
		expect(readVoiceConfig(target).reasoningEffort).toBe('medium')
	})

	it('keeps SIP ingress and call control on the same project residency', () => {
		expect(openAIOriginForSipHost('sip.api.openai.com')).toBe('https://api.openai.com')
		expect(openAIOriginForSipHost('sip-eu.api.openai.com')).toBe('https://eu.api.openai.com')
		expect(() => openAIOriginForSipHost('sip.example.com')).toThrow(/voice\.sip-host/)
		expect(() => setVoiceSetting('voice.sip-host', 'sip.example.com', file())).toThrow(/voice\.sip-host/)
	})

	it('round-trips configured values without replacing the generated tokens', () => {
		const target = file()
		const config = readVoiceConfig(target)
		writeVoiceConfig({ ...config, openaiKey: 'sk-live', publicBaseUrl: 'https://mac.example/voice/' }, target)
		const reread = readVoiceConfig(target)
		expect(reread.mcpToken).toBe(config.mcpToken)
		expect(reread.trunkSecret).toBe(config.trunkSecret)
		expect(reread.openaiKey).toBe('sk-live')
		expect(reread.publicBaseUrl).toBe('https://mac.example/voice')
	})

	it('updates secrets, allowlists and PIN through the config setting surface', () => {
		const target = file()
		setVoiceSetting('voice.openai-key', 'sk-live', target)
		setVoiceSetting('voice.allowed-callers', '+47 111 11 111,+47 222 22 222', target)
		setVoiceSetting('voice.pin', '0042', target)
		setVoiceSetting('voice.public-url', 'https://mac.example/voice/', target)
		const config = readVoiceConfig(target)
		expect(config.openaiKey).toBe('sk-live')
		expect(config.allowedCallers).toEqual(['+47 111 11 111', '+47 222 22 222'])
		expect(config.pin).toBe('0042')
		expect(config.publicBaseUrl).toBe('https://mac.example/voice')
		expect(() => setVoiceSetting('voice.pin', '12ab', target)).toThrow(/4–12 digits/)
	})

	it('redacts OpenAI keys and webhook secrets from copyable relay logs', () => {
		const text = 'accept sk-proj-abcdefghijklmnopqrstuvwxyz webhook whsec_YWJjZGVmZ2hpamtsbW5vcA=='
		const redacted = redactSecrets(text, 'relay-token')
		expect(redacted).not.toContain('sk-proj-')
		expect(redacted).not.toContain('whsec_')
		expect(redacted).toBe('accept <openai-key> webhook <webhook-secret>')
	})
})
