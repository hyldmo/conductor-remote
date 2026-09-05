/**
 * Where Tailscale fronts the relay (`src/host/tailscale.ts` ▸ `relayServeState`), read off saved
 * `tailscale serve status --json` output.
 *
 * The reader used to look up one key, `<host>:443`, and answered "not reachable" for a relay served on
 * any other port — which is the arrangement on the Mac this was written on (2026-09-02): OpenAI's cloud
 * only dials :443, so the voice listener owns that port via Funnel and the relay sits tailnet-only on
 * :8787. `service status` printed no URL and no QR, and `yarn deploy` would have run
 * `tailscale serve --bg 8787`, mounting `/` on :443 over the top of the `/voice` mount the webhook points
 * at. Both halves are string-and-map work over the JSON, so a fixture drives them: no tailscale binary,
 * and nothing here can touch a live config — which is the constraint the fix was written under.
 */
import { describe, expect, test } from 'vitest'
import { freeServePort, parseServeStatus, relayServeState, serveUrl } from '../../src/host/tailscale.ts'

const DNS = 'mbp5.taila6dcd6.ts.net'
const RELAY = 'http://127.0.0.1:8787'
const VOICE = 'http://127.0.0.1:3333'

/** `tailscale serve status --json` on this Mac, verbatim, the day the bug was filed. */
const THIS_MAC = JSON.stringify({
	TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '8787': { HTTPS: true } },
	Web: {
		[`${DNS}:443`]: { Handlers: { '/voice': { Proxy: VOICE } } },
		[`${DNS}:8443`]: { Handlers: { '/': { Proxy: VOICE } } },
		[`${DNS}:8787`]: { Handlers: { '/': { Proxy: RELAY } } }
	},
	AllowFunnel: { [`${DNS}:443`]: true, [`${DNS}:8443`]: true }
})

function status(web: Record<string, Record<string, string>>, funnel: string[] = []) {
	const Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {}
	for (const [port, mounts] of Object.entries(web)) {
		Web[`${DNS}:${port}`] = { Handlers: Object.fromEntries(Object.entries(mounts).map(([m, p]) => [m, { Proxy: p }])) }
	}
	return { Web, AllowFunnel: Object.fromEntries(funnel.map(port => [`${DNS}:${port}`, true])) }
}

describe('relayServeState', () => {
	test('finds the relay on a port other than 443, tailnet-only, beside a Funnel voice listener', () => {
		const state = relayServeState(parseServeStatus(THIS_MAC), 8787)
		expect(state.port).toBe(8787)
		expect(state.funnelOn).toBe(false)
		expect(state.shared).toEqual([])
		expect([...state.taken.entries()]).toEqual([
			[443, [`/voice → ${VOICE}`]],
			[8443, [`/ → ${VOICE}`]]
		])
	})

	test('the plain :443 default reads as before, public or tailnet-only', () => {
		const pub = relayServeState(status({ 443: { '/': RELAY } }, ['443']), '8787')
		expect(pub).toMatchObject({ port: 443, funnelOn: true, shared: [] })
		expect(pub.taken.size).toBe(0)
		const priv = relayServeState(status({ 443: { '/': RELAY } }), '8787')
		expect(priv).toMatchObject({ port: 443, funnelOn: false })
	})

	test('nothing configured is nothing fronting, whatever the CLI printed', () => {
		for (const out of ['null', '{}', '', 'not json', '"a string"']) {
			const state = relayServeState(parseServeStatus(out), 8787)
			expect(state.port, out).toBeNull()
			expect(state.funnelOn, out).toBe(false)
			expect(state.taken.size, out).toBe(0)
		}
	})

	test('a port the relay shares names the other mounts', () => {
		const state = relayServeState(status({ 443: { '/': RELAY, '/voice': VOICE } }, ['443']), 8787)
		expect(state.port).toBe(443)
		expect(state.funnelOn).toBe(true)
		expect(state.shared).toEqual([`/voice → ${VOICE}`])
	})

	test('prefers :443 when the relay is served on several ports', () => {
		const state = relayServeState(status({ 8787: { '/': RELAY }, 443: { '/': RELAY }, 8443: { '/': RELAY } }), 8787)
		expect(state.port).toBe(443)
		const noDefault = relayServeState(status({ 10000: { '/': RELAY }, 8787: { '/': RELAY } }, ['10000']), 8787)
		expect(noDefault.port).toBe(8787)
		expect(noDefault.funnelOn).toBe(false)
	})

	test('a relay mount off the root is neither the phone URL nor a stranger', () => {
		const state = relayServeState(status({ 443: { '/relay': RELAY } }), 8787)
		expect(state.port).toBeNull()
		expect(state.taken.size).toBe(0)
	})

	test('the localhost spelling of the loopback target is the relay too', () => {
		const state = relayServeState(status({ 443: { '/': 'http://localhost:8787' } }), 8787)
		expect(state.port).toBe(443)
	})

	test('another relay port is a stranger, and so is a raw TCP forward', () => {
		const other = relayServeState(status({ 443: { '/': 'http://127.0.0.1:9000' } }), 8787)
		expect(other.port).toBeNull()
		expect(other.taken.get(443)).toEqual(['/ → http://127.0.0.1:9000'])
		const tcp = relayServeState({ TCP: { '443': { TCPForward: '127.0.0.1:5432' } } }, 8787)
		expect(tcp.taken.get(443)).toEqual(['tcp → 127.0.0.1:5432'])
	})

	test('a file or text mount is described without a proxy', () => {
		const state = relayServeState(
			{ Web: { [`${DNS}:443`]: { Handlers: { '/': { Path: '/srv/www' }, '/hi': { Text: 'hello' } } } } },
			8787
		)
		expect(state.taken.get(443)).toEqual(['/ → /srv/www', '/hi → text'])
	})
})

describe('freeServePort', () => {
	test('steps around every port someone else holds, in the order given', () => {
		const state = relayServeState(parseServeStatus(THIS_MAC), 9999)
		expect(freeServePort(state, [443, 8443, 10000])).toBe(10000)
		expect(freeServePort(state, [443, 9999, 8443, 10000])).toBe(9999)
		expect(freeServePort(state, [443, 8443])).toBeNull()
		expect(freeServePort(relayServeState({}, 8787), [443, 8443, 10000])).toBe(443)
	})
})

describe('serveUrl', () => {
	test('carries the port unless it is 443', () => {
		expect(serveUrl(DNS, 443)).toBe(`https://${DNS}/`)
		expect(serveUrl(DNS, 8787)).toBe(`https://${DNS}:8787/`)
	})
})
