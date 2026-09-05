/**
 * The caller gate (`src/voice/webhook.ts`, `src/voice/twiml.ts`).
 *
 * Every check here is the only thing standing between a stranger and a session that can dispatch
 * prompts into real workspaces, and each one fails open in a way that passes a happy-path test.
 * A signature check that accepts a missing header, a tolerance window that forgets to reject the
 * far future, a marker comparison that short-circuits on length, a replay guard that never
 * evicts: all four typecheck, and all four look identical to a working gate when you hand them a
 * valid request. So the assertions here are mostly negative, and the signatures are computed with
 * real HMACs rather than stubbed, since a stub would pass whatever the implementation happens to do.
 *
 * The XML escaping is here for a different reason. A caller-controlled string reaches TwiML, and
 * an unescaped quote there does not throw — it changes which SIP address Twilio dials.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	callerAllowed,
	MARKER_MAX_AGE_SECONDS,
	mintMarker,
	parseForm,
	twilioSignature,
	twimlDialSip,
	twimlGatherPin,
	verifyMarker,
	verifyTwilioSignature,
	xmlEscape
} from '../../src/voice/twiml.ts'
import {
	parseIncomingCall,
	ReplayGuard,
	SIGNATURE_TOLERANCE_SECONDS,
	sipHeader,
	verifyWebhookSignature,
	webhookKey
} from '../../src/voice/webhook.ts'

const SECRET = `whsec_${Buffer.from('a-shared-signing-secret').toString('base64')}`
const NOW = 1_788_347_464_000
const BODY = JSON.stringify({ type: 'realtime.call.incoming', data: { call_id: 'rtc_1', sip_headers: [] } })

function signed(body: string, id = 'wh_1', at = Math.floor(NOW / 1000), secret = SECRET) {
	const mac = crypto.createHmac('sha256', webhookKey(secret)).update(`${id}.${at}.${body}`).digest('base64')
	return { 'webhook-id': id, 'webhook-timestamp': String(at), 'webhook-signature': `v1,${mac}` }
}

describe('the OpenAI webhook signature', () => {
	it('accepts a delivery signed with the shared secret', () => {
		expect(verifyWebhookSignature(BODY, signed(BODY), SECRET, NOW)).toEqual({ ok: true })
	})

	it('accepts one signature out of a rotation list', () => {
		const h = signed(BODY)
		h['webhook-signature'] = `v1,ZmFrZQ== ${h['webhook-signature']}`
		expect(verifyWebhookSignature(BODY, h, SECRET, NOW).ok).toBe(true)
	})

	it('refuses a missing header rather than treating absence as a pass', () => {
		for (const drop of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
			const h: Record<string, string | undefined> = { ...signed(BODY) }
			h[drop] = undefined
			expect(verifyWebhookSignature(BODY, h, SECRET, NOW).ok).toBe(false)
		}
	})

	it('refuses a body changed after signing, even by one byte', () => {
		const h = signed(BODY)
		expect(verifyWebhookSignature(`${BODY} `, h, SECRET, NOW).ok).toBe(false)
	})

	it('refuses the wrong secret', () => {
		const other = `whsec_${Buffer.from('someone-elses-secret').toString('base64')}`
		expect(verifyWebhookSignature(BODY, signed(BODY, 'wh_1', Math.floor(NOW / 1000), other), SECRET, NOW).ok).toBe(
			false
		)
	})

	it('refuses a timestamp outside tolerance in both directions', () => {
		const old = Math.floor(NOW / 1000) - SIGNATURE_TOLERANCE_SECONDS - 1
		const future = Math.floor(NOW / 1000) + SIGNATURE_TOLERANCE_SECONDS + 1
		expect(verifyWebhookSignature(BODY, signed(BODY, 'wh_1', old), SECRET, NOW).ok).toBe(false)
		expect(verifyWebhookSignature(BODY, signed(BODY, 'wh_1', future), SECRET, NOW).ok).toBe(false)
	})

	it('reads the secret with or without its dashboard prefix', () => {
		expect(webhookKey(SECRET)).toEqual(webhookKey(SECRET.slice('whsec_'.length)))
	})
})

describe('the replay guard', () => {
	it('takes an id once and refuses it after', () => {
		const guard = new ReplayGuard(1000)
		expect(guard.accept('wh_1', NOW)).toBe(true)
		expect(guard.accept('wh_1', NOW + 10)).toBe(false)
		expect(guard.accept('wh_2', NOW + 10)).toBe(true)
	})

	it('forgets an id once it is older than the window, so memory cannot grow forever', () => {
		const guard = new ReplayGuard(1000)
		expect(guard.accept('wh_1', NOW)).toBe(true)
		expect(guard.accept('wh_1', NOW + 1001)).toBe(true)
	})
})

describe('the event body', () => {
	it('reads a call id and its SIP headers', () => {
		const body = JSON.stringify({
			type: 'realtime.call.incoming',
			data: {
				call_id: 'rtc_9',
				sip_headers: [
					{ name: 'X-Relay-Call', value: 'marker' },
					{ name: 1, value: 2 }
				]
			}
		})
		const call = parseIncomingCall(body)
		expect(call?.callId).toBe('rtc_9')
		expect(call?.sipHeaders).toEqual([{ name: 'X-Relay-Call', value: 'marker' }])
		expect(sipHeader(call?.sipHeaders ?? [], 'x-relay-call')).toBe('marker')
	})

	it('is null for another event type, a missing call id, or nonsense', () => {
		expect(parseIncomingCall(JSON.stringify({ type: 'realtime.call.ended' }))).toBeNull()
		expect(parseIncomingCall(JSON.stringify({ type: 'realtime.call.incoming', data: {} }))).toBeNull()
		expect(parseIncomingCall('not json')).toBeNull()
	})
})

describe('the trunk marker', () => {
	it('verifies one it just minted', () => {
		expect(verifyMarker(mintMarker('trunk-secret', NOW), 'trunk-secret', NOW)).toEqual({ ok: true })
	})

	it('refuses another secret, a tampered field, and a malformed shape', () => {
		const marker = mintMarker('trunk-secret', NOW, 'nonce')
		expect(verifyMarker(marker, 'other-secret', NOW).ok).toBe(false)
		expect(verifyMarker(marker.replace('nonce', 'nonc3'), 'trunk-secret', NOW).ok).toBe(false)
		expect(verifyMarker('two.parts', 'trunk-secret', NOW).ok).toBe(false)
		expect(verifyMarker(null, 'trunk-secret', NOW).ok).toBe(false)
	})

	it('expires, and refuses one dated in the future', () => {
		const marker = mintMarker('trunk-secret', NOW)
		expect(verifyMarker(marker, 'trunk-secret', NOW + (MARKER_MAX_AGE_SECONDS + 1) * 1000).ok).toBe(false)
		expect(verifyMarker(marker, 'trunk-secret', NOW - (MARKER_MAX_AGE_SECONDS + 1) * 1000).ok).toBe(false)
	})

	it('mints a fresh nonce, so two calls in the same second do not share a marker', () => {
		const a = mintMarker('trunk-secret', NOW)
		const b = mintMarker('trunk-secret', NOW)
		expect(a).not.toBe(b)
		expect(a.split('.')[0]).toBe(b.split('.')[0])
		expect(verifyMarker(b, 'trunk-secret', NOW).ok).toBe(true)
	})
})

describe('the Twilio signature and allowlist', () => {
	const url = 'https://mbp5.taila6dcd6.ts.net/voice/twiml'
	const params = { CallSid: 'CA1', From: '+4712345678', To: '+4787654321' }

	it('verifies a request signed the way Twilio signs it', () => {
		const sig = twilioSignature(url, params, 'auth-token')
		expect(verifyTwilioSignature(url, params, 'auth-token', sig)).toEqual({ ok: true })
	})

	it('refuses a changed parameter, a changed URL and a missing signature', () => {
		const sig = twilioSignature(url, params, 'auth-token')
		expect(verifyTwilioSignature(url, { ...params, From: '+4700000000' }, 'auth-token', sig).ok).toBe(false)
		expect(verifyTwilioSignature(`${url}?x=1`, params, 'auth-token', sig).ok).toBe(false)
		expect(verifyTwilioSignature(url, params, 'auth-token', null).ok).toBe(false)
	})

	it('sorts parameters by name, so ordering cannot change the signature', () => {
		const reordered = { To: params.To, From: params.From, CallSid: params.CallSid }
		expect(twilioSignature(url, reordered, 'auth-token')).toBe(twilioSignature(url, params, 'auth-token'))
	})

	it('matches an allowlisted caller through the punctuation a person types', () => {
		expect(callerAllowed('+4712345678', ['+47 123 45 678'])).toBe(true)
		expect(callerAllowed('+4712345678', ['+4787654321'])).toBe(false)
		expect(callerAllowed(undefined, ['+4712345678'])).toBe(false)
		expect(callerAllowed('+4712345678', [])).toBe(false)
	})

	it('parses the form Twilio posts', () => {
		expect(parseForm('From=%2B4712345678&Digits=1234')).toEqual({ From: '+4712345678', Digits: '1234' })
	})
})

describe('the TwiML', () => {
	it('escapes anything interpolated, so a crafted value cannot redirect the dial', () => {
		expect(xmlEscape(`"><Dial>evil</Dial><x a='`)).toBe('&quot;&gt;&lt;Dial&gt;evil&lt;/Dial&gt;&lt;x a=&apos;')
		expect(twimlGatherPin('https://x/voice/twiml?step="2"', 4)).toContain('step=&quot;2&quot;')
	})

	it('keeps the project id exactly as configured, since the SIP user part is case-sensitive', () => {
		const xml = twimlDialSip('proj_8UZ3Mu16lN4xvgFFIxxiHly0', 'marker')
		expect(xml).toContain('sip:proj_8UZ3Mu16lN4xvgFFIxxiHly0@sip.api.openai.com;transport=tls')
		expect(xml).toContain('X-Relay-Call=marker')
	})
})
