import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { driftWarningLines, magicDnsName, relayServeState, serveUrl, tailscaleBin } from '../../src/host/tailscale.ts'
import { readVoiceConfig } from '../../src/voice/config.ts'
import { inspectVoiceFunnel, readVoiceFunnelReceipt } from '../../src/voice/funnel.ts'
import { qrLines } from '../qr.ts'
import { currentToken, domain, LABEL, logDir, plistPath, RELAY_PORT, readPlistEnv } from './environment.ts'
import { rawTailscaleStatus, tailscaleState } from './network.ts'

/** Print a scannable QR of `url` (theme-independent black-on-white). Never fatal — QR is a convenience. */
function printQr(url: string): void {
	try {
		console.info(`\n${qrLines(url).join('\n')}`)
	} catch (err) {
		console.info(`  (QR skipped: ${err instanceof Error ? err.message : err})`)
	}
}

export function printUrl(loopbackPort: string = RELAY_PORT): void {
	const token = currentToken()
	const frag = `#token=${token ?? '<starts on first run>'}`
	const bin = tailscaleBin()
	if (bin) {
		const drift = driftWarningLines(bin)
		if (drift.length) console.info(`\n${drift.join('\n')}`)
	}
	const dns = bin ? magicDnsName(bin) : null
	const state = bin ? tailscaleState(bin, loopbackPort) : relayServeState({}, loopbackPort)
	if (dns && state.port !== null) {
		const scope = state.funnelOn ? 'public — any browser, token-gated' : 'same Tailnet only'
		const url = `${serveUrl(dns, state.port)}${frag}`
		console.info(`\n  Phone URL (HTTPS, ${scope}):\n    ${url}`)
		if (token) {
			console.info('\n  Scan to open on your phone:')
			printQr(url)
		}
		return
	}
	// Nothing fronting yet — the relay is only on loopback.
	console.info(`\n  Local URL:\n    http://127.0.0.1:${loopbackPort}/${frag}`)
	console.info(
		`\n  ⚠ Not reachable from your phone yet. Run \`yarn deploy\` (it picks a free port), or by hand \`tailscale funnel --bg ${loopbackPort}\` (public) / \`tailscale serve --bg ${loopbackPort}\` (tailnet)${dns ? ` → https://${dns}/` : ''}, then \`yarn service status\`.`
	)
}

/** Report the public voice path independently of the relay's tailnet-only phone URL. */
export function printVoiceRoute(loopbackPort: string, listenerPort: string): void {
	const voice = readVoiceConfig()
	if (!voice.publicBaseUrl) {
		console.info('voice:     disabled (set voice.public-url to enable)')
		return
	}
	const bin = tailscaleBin()
	if (!bin) {
		console.info(`voice:     configured at ${voice.publicBaseUrl}, but Tailscale is unavailable`)
		return
	}
	const inspected = inspectVoiceFunnel(rawTailscaleStatus(bin), listenerPort, loopbackPort, readVoiceFunnelReceipt())
	if (inspected.owned && inspected.targetMatches && inspected.funnelOn && !inspected.relayAtRoot) {
		console.info(`voice:     ${voice.publicBaseUrl} (public) → 127.0.0.1:${listenerPort}`)
		return
	}
	console.info(`voice:     ${voice.publicBaseUrl} configured, but its isolated Funnel mount is not live`)
}

export function status(): void {
	const installed = fs.existsSync(plistPath)
	console.info(`plist:     ${installed ? plistPath : '(not installed)'}`)
	if (!installed) return
	try {
		const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8', stdio: 'pipe' })
		const state = out.match(/state = (\S+)/)?.[1] ?? 'unknown'
		const pid = out.match(/pid = (\d+)/)?.[1] ?? '—'
		console.info(`state:     ${state}  (pid ${pid})`)
	} catch {
		console.info('state:     loaded but not running (check logs)')
	}
	const env = readPlistEnv()
	const relayPort = env.RELAY_PORT ?? '8787'
	printUrl(relayPort)
	printVoiceRoute(relayPort, env.VOICE_PORT ?? '8788')
}

/**
 * Stream the LaunchAgent's stdout+stderr logs (the same files the plist points at). Follows both by default
 * — `--no-follow` for a one-shot tail, `-n N` for depth. Pure `tail` passthrough so Ctrl-C just detaches.
 */
export function logs(): void {
	const files = ['relay.log', 'relay.err.log'].map(f => path.join(logDir, f)).filter(f => fs.existsSync(f))
	if (files.length === 0) {
		console.info(
			`no logs yet in ${logDir}/ — the relay writes there once the LaunchAgent is running (\`conductor-remote service install\`).`
		)
		return
	}
	const argv = process.argv.slice(3)
	const follow = !argv.includes('--no-follow')
	const nAt = argv.indexOf('-n')
	const count = nAt !== -1 && argv[nAt + 1] ? argv[nAt + 1] : '200'
	const args = ['-n', count, ...(follow ? ['-F'] : []), ...files]
	const res = spawnSync('tail', args, { stdio: 'inherit' })
	// tail exits 0 normally; Ctrl-C kills it via SIGINT (null status). Only surface a genuine non-zero exit.
	if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status)
}
