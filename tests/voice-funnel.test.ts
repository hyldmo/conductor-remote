import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServeStatus } from '../src/tailscale.ts'
import {
	inspectVoiceFunnel,
	readVoiceFunnelReceipt,
	type VoiceFunnelReceipt,
	writeVoiceFunnelReceipt
} from '../src/voice/funnel.ts'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const receipt: VoiceFunnelReceipt = {
	version: 1,
	host: 'mac.example.ts.net',
	path: '/voice',
	target: 'http://127.0.0.1:8788'
}

function status(extra: Record<string, { Proxy: string }> = {}): ServeStatus {
	return {
		Web: {
			'mac.example.ts.net:443': {
				Handlers: {
					'/': { Proxy: 'http://127.0.0.1:8787' },
					'/voice': { Proxy: 'http://127.0.0.1:8788' },
					...extra
				}
			}
		},
		AllowFunnel: { 'mac.example.ts.net:443': true }
	}
}

describe('the voice Funnel ownership receipt', () => {
	it('owns only the exact live host, path and target named by the receipt', () => {
		expect(inspectVoiceFunnel(status(), 8788, 8787, receipt)).toEqual({
			present: true,
			targetMatches: true,
			owned: true,
			funnelOn: true,
			relayAtRoot: true,
			conflicts: []
		})
		expect(inspectVoiceFunnel(status(), 8788, 8787, null)).toMatchObject({
			present: true,
			targetMatches: true,
			owned: false,
			conflicts: ['/voice → an unowned matching target']
		})
	})

	it('reports a foreign path instead of allowing a port-wide rewrite', () => {
		expect(
			inspectVoiceFunnel(status({ '/other': { Proxy: 'http://127.0.0.1:9999' } }), 8788, 8787, receipt).conflicts
		).toEqual(['/other → http://127.0.0.1:9999'])
	})

	it('recognizes its receipt after the configured listener port changes, so it can replace it', () => {
		const inspected = inspectVoiceFunnel(status(), 8799, 8787, receipt)
		expect(inspected).toMatchObject({
			present: true,
			targetMatches: false,
			owned: true,
			relayAtRoot: true,
			conflicts: []
		})
	})

	it('persists the receipt at 0600', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-funnel-'))
		dirs.push(dir)
		const file = path.join(dir, 'receipt.json')
		writeVoiceFunnelReceipt(receipt, file)
		expect(readVoiceFunnelReceipt(file)).toEqual(receipt)
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
	})
})
