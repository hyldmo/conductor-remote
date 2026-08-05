/**
 * Web Push, written out of `node:crypto` — VAPID (RFC 8292) plus `aes128gcm`
 * payload encryption (RFC 8291 over RFC 8188).
 *
 * Why by hand rather than the `web-push` package: the tarball ships **zero
 * runtime deps** (see CLAUDE.md ▸ traps) and that is worth keeping — the whole
 * protocol is one ECDH, three HKDF expansions and an AES-GCM record, all of
 * which `node:crypto` already has. Nothing here talks to Conductor; it is a
 * pure encoder plus one `fetch`.
 *
 * Two rules the push services enforce and that a hand-rolled encoder gets to
 * discover the hard way:
 * - **The keypair must be stable.** `applicationServerKey` is baked into the
 *   browser's subscription at subscribe time, and a push signed by a *different*
 *   VAPID key is rejected (403) forever after. So the keys are persisted
 *   (src/notify.ts) and never regenerated behind a live subscription.
 * - **A push must carry a notification the SW actually shows.** Silent pushes
 *   get a subscription dropped on iOS, so the caller always sends a payload and
 *   `public/push-sw.js` always calls `showNotification`.
 */
import crypto from 'node:crypto'

/** What `PushSubscription.toJSON()` hands back in the browser, verbatim. */
export interface PushSubscription {
	endpoint: string
	keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
	/** Raw uncompressed P-256 point, base64url — the browser's `applicationServerKey`. */
	publicKey: string
	/** Private key as a JWK, so persistence doesn't depend on a DER/PEM layout surviving a Node upgrade. */
	privateJwk: crypto.JsonWebKey
}

export interface PushResult {
	ok: boolean
	status: number
	error?: string
	/** The push service says this subscription is dead (404/410) — drop it. */
	gone?: boolean
}

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

/** `0x04 || x || y` — the uncompressed point form both VAPID and ECDH speak on the wire. */
function rawPublicKey(jwk: crypto.JsonWebKey): Buffer {
	if (!jwk.x || !jwk.y) throw new Error('EC JWK missing coordinates')
	return Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])
}

export function generateVapidKeys(): VapidKeys {
	const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const privateJwk = privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey
	return { publicKey: b64u(rawPublicKey(privateJwk)), privateJwk }
}

/** HKDF-Expand for a single 32-byte block — every length we need is ≤ 32, so one HMAC covers it. */
function hkdf(prk: Buffer, info: Buffer, length: number): Buffer {
	const block = crypto
		.createHmac('sha256', prk)
		.update(info)
		.update(Buffer.from([1]))
		.digest()
	return block.subarray(0, length)
}

/**
 * `Authorization: vapid t=<JWT>, k=<public key>` for one push endpoint.
 *
 * The JWT's audience is the endpoint's *origin* (not the full URL) and it is
 * signed ES256 — which for JOSE means the raw `r||s` pair, hence
 * `dsaEncoding: 'ieee-p1363'`; Node's default DER encoding validates as a
 * signature but is rejected by every push service.
 */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string): string {
	const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
	const claims = b64u(
		Buffer.from(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				// Push services cap this at 24h; 12 keeps a clock skew of hours harmless.
				exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
				sub: subject
			})
		)
	)
	const signingInput = `${header}.${claims}`
	const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' })
	const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
	return `vapid t=${signingInput}.${b64u(signature)}, k=${keys.publicKey}`
}

/** Record size we advertise. One record, so it only has to exceed the body; push services cap the POST near 4 KB. */
const RECORD_SIZE = 4096
/** Ciphertext overhead per record: the `0x02` last-record delimiter plus the GCM tag. */
const OVERHEAD = 1 + 16
/** Header: 16-byte salt + 4-byte record size + 1-byte key length + the 65-byte key. */
const HEADER_SIZE = 16 + 4 + 1 + 65

/** Longest plaintext that still fits one `RECORD_SIZE` record — callers clip to it rather than get a 413. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_SIZE - OVERHEAD

/**
 * Encrypt one `aes128gcm` body for a subscription (RFC 8291 §3.4 key schedule).
 *
 * The whole derivation hangs off two secrets the browser gave us — the UA's
 * public key (`p256dh`) and a 16-byte `auth` secret — combined with a fresh
 * ephemeral keypair per message, so no two pushes share a key or nonce.
 */
export function encryptPayload(sub: PushSubscription, payload: Buffer): Buffer {
	if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`payload too large (${payload.length} bytes)`)
	const uaPublic = unb64u(sub.keys.p256dh)
	const authSecret = unb64u(sub.keys.auth)

	const ecdh = crypto.createECDH('prime256v1')
	ecdh.generateKeys()
	const asPublic = ecdh.getPublicKey()
	const sharedSecret = ecdh.computeSecret(uaPublic)

	// Extract with the auth secret, then bind the derived key material to *both*
	// public keys so a captured record can't be replayed against another subscription.
	const prkKey = crypto.createHmac('sha256', authSecret).update(sharedSecret).digest()
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
	const ikm = hkdf(prkKey, keyInfo, 32)

	const salt = crypto.randomBytes(16)
	const prk = crypto.createHmac('sha256', salt).update(ikm).digest()
	const cek = hkdf(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
	const nonce = hkdf(prk, Buffer.from('Content-Encoding: nonce\0'), 12)

	const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
	// 0x02 is the delimiter marking this as the *last* record; 0x01 would promise another.
	const ciphertext = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final()])

	const recordSize = Buffer.alloc(4)
	recordSize.writeUInt32BE(RECORD_SIZE)
	return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext, cipher.getAuthTag()])
}

/**
 * POST one notification. Resolves with the outcome instead of throwing: a dead
 * subscription (`gone`) is a routine fact the caller prunes on, not an error,
 * and a phone that is merely offline is the push service's problem to hold.
 */
export async function sendPush(
	sub: PushSubscription,
	keys: VapidKeys,
	subject: string,
	payload: Buffer,
	ttlSeconds: number
): Promise<PushResult> {
	let body: Buffer
	try {
		body = encryptPayload(sub, payload)
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
	}
	try {
		const res = await fetch(sub.endpoint, {
			method: 'POST',
			headers: {
				authorization: vapidHeader(sub.endpoint, keys, subject),
				'content-encoding': 'aes128gcm',
				'content-type': 'application/octet-stream',
				ttl: String(ttlSeconds),
				urgency: 'normal'
			},
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(10_000)
		})
		if (res.ok) return { ok: true, status: res.status }
		// The body carries the service's own reason ("VAPID credentials mismatch", …) —
		// far more use than the status alone when a push silently stops arriving.
		const detail = await res.text().catch(() => '')
		return {
			ok: false,
			status: res.status,
			gone: res.status === 404 || res.status === 410,
			error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200).trim()}` : ''}`
		}
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
	}
}
