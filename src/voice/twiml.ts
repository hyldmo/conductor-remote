/**
 * The Twilio side of the caller gate, and the TwiML it answers with.
 *
 * The number authenticates nobody — anyone who dials it reaches whatever answers (eng review's
 * correction to P3), so three things happen before OpenAI is bridged. `X-Twilio-Signature` proves
 * Twilio sent the request. The `From` allowlist proves it is a phone we know. The DTMF PIN proves
 * it is a person who knows the secret rather than a stolen handset. Only then does the `<Dial>`
 * go out, carrying a trunk marker the OpenAI webhook re-checks, so a stranger who guesses the
 * project id and dials the SIP address directly still reaches nothing.
 *
 * The marker carries no phone number and no call id. It is a timestamp, a nonce and an HMAC over
 * both, which is all the webhook needs to know the leg came from here and came recently — and it
 * transits OpenAI's servers, so putting the caller's number in it would be leaking the one piece
 * of PII this whole path otherwise avoids.
 */
import crypto from 'node:crypto'
import type { Verdict } from './webhook.ts'

/** A marker older than this is refused. A Twilio bridge takes seconds; this is generous. */
export const MARKER_MAX_AGE_SECONDS = 120

const bad = (reason: string): Verdict => ({ ok: false, reason })

function equal(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/**
 * Twilio signs the exact URL it requested plus every POST parameter, sorted by name and
 * concatenated as `name + value` with no separators, HMAC-SHA1 under the account's auth token.
 * The URL must be the public one Twilio dialled, not the loopback path this process sees.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
	const payload = Object.keys(params)
		.sort()
		.reduce((acc, key) => acc + key + params[key], url)
	return crypto.createHmac('sha1', authToken).update(payload).digest('base64')
}

export function verifyTwilioSignature(
	url: string,
	params: Record<string, string>,
	authToken: string,
	signature: string | null
): Verdict {
	if (!signature) return bad('missing X-Twilio-Signature')
	return equal(signature, twilioSignature(url, params, authToken)) ? { ok: true } : bad('X-Twilio-Signature mismatch')
}

/** `application/x-www-form-urlencoded`, which is what Twilio posts. Last value wins, as Twilio sends one each. */
export function parseForm(body: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of new URLSearchParams(body)) out[key] = value
	return out
}

/**
 * E.164 comparison that tolerates the spacing and punctuation a person types into a settings file.
 * Anything that is not a digit or a leading plus is noise; two numbers match when their digits do.
 */
export function sameNumber(a: string, b: string): boolean {
	const digits = (s: string) => s.replace(/[^\d]/g, '')
	return digits(a).length > 0 && digits(a) === digits(b)
}

export function callerAllowed(from: string | undefined, allowlist: string[]): boolean {
	return Boolean(from) && allowlist.some(entry => sameNumber(entry, from as string))
}

// ── the trunk marker ────────────────────────────────────────────────────────────────────────

function markerMac(secret: string, stamp: string, nonce: string): string {
	return crypto.createHmac('sha256', secret).update(`${stamp}.${nonce}`).digest('base64url')
}

/** `<unix seconds>.<nonce>.<mac>` — URL- and SIP-header-safe, since base64url avoids `+/=`. */
export function mintMarker(secret: string, nowMs: number = Date.now(), nonce?: string): string {
	const stamp = String(Math.floor(nowMs / 1000))
	const n = nonce ?? crypto.randomBytes(9).toString('base64url')
	return `${stamp}.${n}.${markerMac(secret, stamp, n)}`
}

export function verifyMarker(
	marker: string | null,
	secret: string,
	nowMs: number = Date.now(),
	maxAgeSeconds: number = MARKER_MAX_AGE_SECONDS
): Verdict {
	if (!marker) return bad('no trunk marker on the call')
	const parts = marker.split('.')
	if (parts.length !== 3) return bad('trunk marker is malformed')
	const [stamp, nonce, mac] = parts
	const sent = Number(stamp)
	if (!Number.isFinite(sent)) return bad('trunk marker has no timestamp')
	const age = nowMs / 1000 - sent
	// A marker from the future is a clock problem or a forgery; either way it is not ours.
	if (age < -maxAgeSeconds || age > maxAgeSeconds) return bad(`trunk marker is ${Math.round(age)}s old`)
	return equal(mac, markerMac(secret, stamp, nonce)) ? { ok: true } : bad('trunk marker does not verify')
}

// ── TwiML ───────────────────────────────────────────────────────────────────────────────────

/** Everything interpolated below is either ours or a caller-controlled string, so all of it escapes. */
export function xmlEscape(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

const doc = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>\n`

/** The answer to anything that fails a check. Says nothing about which check, or that it was close. */
export function twimlReject(): string {
	return doc('<Reject reason="rejected"/>')
}

/** Ask for the PIN. `action` is the public URL Twilio should post the digits back to. */
export function twimlGatherPin(action: string, digits: number): string {
	return doc(
		`<Gather input="dtmf" numDigits="${digits}" timeout="10" action="${xmlEscape(action)}" method="POST">` +
			'<Say>Enter your pin.</Say>' +
			'</Gather>' +
			'<Say>No pin entered.</Say>' +
			'<Reject reason="rejected"/>'
	)
}

/**
 * The short-lived address used by both Twilio and the native app. Keep it in one
 * function so neither path can accidentally normalise the case-sensitive project id
 * or omit TLS/the relay marker.
 */
export function sipTicketUri(projectId: string, marker: string, host = 'sip.api.openai.com'): string {
	return `sip:${projectId}@${host};transport=tls?X-Relay-Call=${marker}`
}

/**
 * Bridge to OpenAI. The project id is **case-sensitive** in the SIP user part (P3: Linphone
 * lowercasing it is what demoted the softphone path), so it is interpolated exactly as configured
 * and never normalised here.
 */
export function twimlDialSip(projectId: string, marker: string, host = 'sip.api.openai.com'): string {
	const uri = sipTicketUri(projectId, marker, host)
	return doc(`<Dial answerOnBridge="true"><Sip>${xmlEscape(uri)}</Sip></Dial>`)
}
