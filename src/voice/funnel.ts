/** Ownership receipt and pure inspection for the one public `/voice` Funnel mount. */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../config.ts'
import type { ServeStatus } from '../host/tailscale.ts'

export const VOICE_FUNNEL_PORT = 443
export const VOICE_FUNNEL_PATH = '/voice'

export interface VoiceFunnelReceipt {
	version: 1
	host: string
	path: '/voice'
	target: string
}

export interface VoiceFunnelInspection {
	present: boolean
	targetMatches: boolean
	owned: boolean
	funnelOn: boolean
	relayAtRoot: boolean
	conflicts: string[]
}

export function voiceFunnelReceiptPath(): string {
	return path.join(stateDir(), 'voice-funnel.json')
}

export function readVoiceFunnelReceipt(file: string = voiceFunnelReceiptPath()): VoiceFunnelReceipt | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VoiceFunnelReceipt>
		return raw.version === 1 && typeof raw.host === 'string' && raw.path === '/voice' && typeof raw.target === 'string'
			? (raw as VoiceFunnelReceipt)
			: null
	} catch {
		return null
	}
}

export function writeVoiceFunnelReceipt(receipt: VoiceFunnelReceipt, file: string = voiceFunnelReceiptPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
	fs.chmodSync(file, 0o600)
}

function portOf(hostPort: string): number | null {
	const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1))
	return Number.isInteger(port) ? port : null
}

function hostOf(hostPort: string): string {
	return hostPort.slice(0, hostPort.lastIndexOf(':'))
}

function proxyMatches(proxy: string | undefined, port: string | number): boolean {
	return proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`
}

/**
 * Decide whether a live path is ours before the service script mutates anything. A matching
 * target without a receipt is deliberately *not* adopted: it may be the user's manual mount.
 */
export function inspectVoiceFunnel(
	status: ServeStatus,
	voicePort: string | number,
	relayPort: string | number,
	receipt: VoiceFunnelReceipt | null
): VoiceFunnelInspection {
	let present = false
	let targetMatches = false
	let owned = false
	let funnelOn = false
	let relayAtRoot = false
	const conflicts: string[] = []
	for (const [key, web] of Object.entries(status.Web ?? {})) {
		if (portOf(key) !== VOICE_FUNNEL_PORT) continue
		for (const [mount, handler] of Object.entries(web.Handlers ?? {})) {
			if (mount === '/' && proxyMatches(handler.Proxy, relayPort)) {
				relayAtRoot = true
				continue
			}
			if (mount === VOICE_FUNNEL_PATH && handler.Proxy) {
				present = true
				targetMatches ||= proxyMatches(handler.Proxy, voicePort)
				const target = handler.Proxy
				owned = Boolean(
					receipt && receipt.host === hostOf(key) && receipt.path === VOICE_FUNNEL_PATH && receipt.target === target
				)
				funnelOn ||= status.AllowFunnel?.[key] === true
				if (!proxyMatches(handler.Proxy, voicePort) && !owned) conflicts.push(`${mount} → ${target}`)
				continue
			}
			conflicts.push(`${mount} → ${handler.Proxy ?? handler.Path ?? (handler.Text !== undefined ? 'text' : 'unknown')}`)
		}
	}
	for (const [key, tcp] of Object.entries(status.TCP ?? {})) {
		if (portOf(key) === VOICE_FUNNEL_PORT && tcp.TCPForward) conflicts.push(`tcp → ${tcp.TCPForward}`)
	}
	if (present && !owned && !conflicts.some(value => value.startsWith(`${VOICE_FUNNEL_PATH} →`)))
		conflicts.push(`${VOICE_FUNNEL_PATH} → an unowned matching target`)
	return { present, targetMatches, owned, funnelOn, relayAtRoot, conflicts }
}
