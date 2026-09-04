/**
 * The OpenAI side of the caller gate: verify `realtime.call.incoming` before anything answers it.
 *
 * Three independent checks, because each one fails differently. The **Standard Webhooks
 * signature** proves OpenAI sent it. The **replay guard** stops the same signed delivery being
 * re-used, which matters because OpenAI retries for 72 hours and a retry is indistinguishable
 * from a capture. The **trunk marker** proves the call came through our Twilio number rather than
 * from someone who guessed the project id and dialled the SIP address directly — probe 0b
 * (2026-09-02) confirmed a custom SIP header survives into `sip_headers`, so the marker is a real
 * gate rather than the layered fallback the design was prepared to settle for.
 *
 * Everything here is pure apart from the guard's clock, so the vectors in the tests are real
 * bytes rather than mocks.
 */
import crypto from 'node:crypto'

/** OpenAI retries for 72 hours; five minutes is the Standard Webhooks tolerance. */
export const SIGNATURE_TOLERANCE_SECONDS = 300
/** How long a delivered `webhook-id` is remembered. Comfortably past the tolerance above. */
export const REPLAY_MEMORY_MS = 15 * 60 * 1000

export interface SipHeader {
	name: string
	value: string
}

export interface IncomingCall {
	callId: string
	sipHeaders: SipHeader[]
}

export type Verdict = { ok: true } | { ok: false; reason: string }

const bad = (reason: string): Verdict => ({ ok: false, reason })

/** `whsec_<base64>` is the dashboard's spelling; the bytes after the prefix are the key. */
export function webhookKey(secret: string): Buffer {
	const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
	return Buffer.from(raw, 'base64')
}

function sameSignature(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/**
 * Standard Webhooks: the signed content is `id.timestamp.body`, the signature is base64 HMAC-SHA256,
 * and the header carries a space-separated list of `v1,<sig>` so a secret can be rotated without a
 * gap. Any one match is enough, and each is compared in constant time.
 */
export function verifyWebhookSignature(
	body: string,
	headers: Record<string, string | string[] | undefined>,
	secret: string,
	nowMs: number = Date.now()
): Verdict {
	const header = (name: string): string | null => {
		const raw = headers[name] ?? headers[name.toLowerCase()]
		const value = Array.isArray(raw) ? raw[0] : raw
		return typeof value === 'string' && value ? value : null
	}
	const id = header('webhook-id')
	const timestamp = header('webhook-timestamp')
	const signature = header('webhook-signature')
	if (!id || !timestamp || !signature) return bad('missing webhook-id, webhook-timestamp or webhook-signature')

	const sent = Number(timestamp)
	if (!Number.isFinite(sent)) return bad('webhook-timestamp is not a number')
	const skew = Math.abs(nowMs / 1000 - sent)
	if (skew > SIGNATURE_TOLERANCE_SECONDS) return bad(`webhook-timestamp is ${Math.round(skew)}s away from now`)

	const expected = crypto.createHmac('sha256', webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')
	// The header may list several versioned signatures; `v1,` is the only scheme defined today.
	const offered = signature.split(' ').flatMap(part => (part.startsWith('v1,') ? [part.slice('v1,'.length)] : []))
	if (!offered.length) return bad('no v1 signature offered')
	return offered.some(sig => sameSignature(sig, expected)) ? { ok: true } : bad('signature does not match')
}

/**
 * Refuses a `webhook-id` seen before. Bounded by time rather than by count, since the thing it
 * defends against is a *re-delivery*, and OpenAI's own retry window is what sets the horizon.
 */
export class ReplayGuard {
	private seen = new Map<string, number>()
	// Explicit field, never a parameter property: the dev path runs these sources through Node's
	// type *stripping*, which cannot transform one (CLAUDE.md ▸ Traps).
	private memoryMs: number

	constructor(memoryMs: number = REPLAY_MEMORY_MS) {
		this.memoryMs = memoryMs
	}

	/** True the first time an id is offered, false every time after, until it ages out. */
	accept(id: string, nowMs: number = Date.now()): boolean {
		for (const [key, at] of this.seen) if (nowMs - at > this.memoryMs) this.seen.delete(key)
		if (this.seen.has(id)) return false
		this.seen.set(id, nowMs)
		return true
	}

	/** Let OpenAI retry a delivery whose handler failed before it could accept or reject the call. */
	forget(id: string): void {
		this.seen.delete(id)
	}
}

/** The event body, or null when it is not an incoming call we can act on. */
export function parseIncomingCall(body: string): IncomingCall | null {
	let event: { type?: unknown; data?: { call_id?: unknown; sip_headers?: unknown } }
	try {
		event = JSON.parse(body)
	} catch {
		return null
	}
	if (event?.type !== 'realtime.call.incoming') return null
	const callId = event.data?.call_id
	if (typeof callId !== 'string' || !callId) return null
	const raw = Array.isArray(event.data?.sip_headers) ? event.data.sip_headers : []
	const sipHeaders = raw.flatMap((h: unknown) => {
		const entry = h as { name?: unknown; value?: unknown }
		return typeof entry?.name === 'string' && typeof entry?.value === 'string'
			? [{ name: entry.name, value: entry.value }]
			: []
	})
	return { callId, sipHeaders }
}

export function sipHeader(headers: SipHeader[], name: string): string | null {
	const wanted = name.toLowerCase()
	return headers.find(h => h.name.toLowerCase() === wanted)?.value ?? null
}
