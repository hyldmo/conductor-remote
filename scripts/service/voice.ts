import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { freeServePort, magicDnsName, relayServeState, tailscaleBin } from '../../src/host/tailscale.ts'
import { readVoiceConfig } from '../../src/voice/config.ts'
import {
	inspectVoiceFunnel,
	readVoiceFunnelReceipt,
	type VoiceFunnelReceipt,
	voiceFunnelReceiptPath,
	writeVoiceFunnelReceipt
} from '../../src/voice/funnel.ts'
import { RELAY_PORT, VOICE_PORT } from './environment.ts'
import { mountRelay, rawTailscaleStatus } from './network.ts'

/**
 * Give OpenAI the only public route it needs while keeping the control panel tailnet-only.
 * Port-wide changes happen only when every live handler is either the relay root or the exact
 * voice target named by our receipt; a foreign or merely manual mount is left untouched.
 */
export function ensureVoiceFunnel(): void {
	const voice = readVoiceConfig()
	const bin = tailscaleBin()
	if (!voice.publicBaseUrl) {
		const receipt = readVoiceFunnelReceipt()
		if (!bin || !receipt) return
		const inspected = inspectVoiceFunnel(rawTailscaleStatus(bin), VOICE_PORT, RELAY_PORT, receipt)
		if (!inspected.owned || inspected.relayAtRoot || inspected.conflicts.length) return
		try {
			execFileSync(bin, ['serve', '--yes', '--https=443', 'off'], { stdio: 'pipe' })
			fs.rmSync(voiceFunnelReceiptPath())
			console.info('✓ removed the receipt-owned voice Funnel mount')
		} catch (error) {
			console.info(
				`  ⚠ could not remove the receipt-owned voice Funnel (${error instanceof Error ? error.message : error})`
			)
		}
		return
	}
	if (!bin) {
		console.info(`\n  ⚠ voice is configured but Tailscale is unavailable. Mount by hand:`)
		console.info(`      tailscale funnel --bg --yes --https=443 --set-path=/voice ${VOICE_PORT}`)
		return
	}
	const dns = magicDnsName(bin)
	if (!dns) {
		console.info('\n  ⚠ voice is configured but this node has no MagicDNS name; Funnel was not changed.')
		return
	}
	let configuredHost: string
	try {
		configuredHost = new URL(voice.publicBaseUrl).hostname
	} catch {
		console.info('\n  ⚠ voice.public-url is invalid; Funnel was not changed.')
		return
	}
	if (configuredHost !== dns) {
		console.info(`\n  ⚠ voice.public-url names ${configuredHost}, but this node is ${dns}; Funnel was not changed.`)
		console.info(`    Fix with: conductor-remote config set voice.public-url https://${dns}/voice`)
		return
	}

	let status = rawTailscaleStatus(bin)
	const oldReceipt = readVoiceFunnelReceipt()
	let inspected = inspectVoiceFunnel(status, VOICE_PORT, RELAY_PORT, oldReceipt)
	if (inspected.conflicts.length) {
		console.info(`\n  ⚠ :443 carries ${inspected.conflicts.join(', ')}. It is not owned by this receipt; left as is.`)
		return
	}
	if (inspected.owned && inspected.targetMatches && inspected.funnelOn && !inspected.relayAtRoot) {
		console.info(`✓ voice Funnel already exposes https://${dns}/voice → 127.0.0.1:${VOICE_PORT}`)
		return
	}

	if (inspected.relayAtRoot) {
		const state = relayServeState(status, RELAY_PORT)
		const candidates = [Number(RELAY_PORT), 8443, 10000].filter(
			(port, index, all) => Number.isInteger(port) && port !== 443 && all.indexOf(port) === index
		)
		const destination = freeServePort(state, candidates)
		if (destination === null) {
			console.info(
				`\n  ⚠ the relay must leave :443 for voice, but ${candidates.map(p => `:${p}`).join(', ')} are occupied.`
			)
			return
		}
		const failed = mountRelay(bin, 'serve', destination)
		if (failed) {
			console.info(`\n  ⚠ could not move the relay to tailnet-only :${destination} (${failed}). Voice was not changed.`)
			return
		}
		try {
			execFileSync(bin, ['serve', '--yes', '--https=443', 'off'], { stdio: 'pipe' })
		} catch (error) {
			console.info(
				`\n  ⚠ relay moved, but :443 could not be cleared (${error instanceof Error ? error.message : error}).`
			)
			return
		}
		console.info(`✓ relay moved to https://${dns}:${destination}/ (tailnet-only) so voice can own :443`)
	}

	try {
		execFileSync(bin, ['funnel', '--bg', '--yes', '--https=443', '--set-path=/voice', VOICE_PORT], {
			stdio: 'pipe'
		})
	} catch (error) {
		console.info(`\n  ⚠ could not mount voice Funnel (${error instanceof Error ? error.message : error}).`)
		console.info(`    Run by hand: tailscale funnel --bg --yes --https=443 --set-path=/voice ${VOICE_PORT}`)
		return
	}
	const receipt: VoiceFunnelReceipt = {
		version: 1,
		host: dns,
		path: '/voice',
		target: `http://127.0.0.1:${VOICE_PORT}`
	}
	status = rawTailscaleStatus(bin)
	inspected = inspectVoiceFunnel(status, VOICE_PORT, RELAY_PORT, receipt)
	if (!inspected.owned || !inspected.targetMatches || !inspected.funnelOn || inspected.relayAtRoot) {
		console.info('\n  ⚠ Tailscale accepted the voice command, but the isolated public mount could not be verified.')
		return
	}
	writeVoiceFunnelReceipt(receipt)
	console.info(`✓ voice Funnel exposes https://${dns}/voice → 127.0.0.1:${VOICE_PORT} (receipt recorded)`)
}
