/**
 * The browser half of push notifications: permission, subscription, and the two
 * conversions the Push API insists on (base64url ⇄ raw bytes).
 *
 * The interesting part is *why a device can't subscribe*, because on a phone that
 * is nearly always one of three specific things and the answer determines what the
 * user has to do:
 * - **`needs-install`** — iOS only exposes Notification/PushManager to a web app
 *   that has been added to the Home Screen. In a Safari tab the APIs simply don't
 *   exist, so "unsupported" would be a lie: it's one Share-sheet tap away.
 * - **`insecure`** — a service worker needs a secure context. `127.0.0.1` counts,
 *   the tailnet HTTPS URL counts, a plain `http://100.x` does not. This is the one
 *   people hit when they skip `yarn deploy` and browse the LAN IP directly.
 * - **`unsupported`** — genuinely no service worker or no Push API.
 */

import { client } from './api.ts'

export type PushSupport = 'ok' | 'needs-install' | 'insecure' | 'unsupported'

/** Subscription in the shape the relay stores (`PushSubscription.toJSON()`, narrowed). */
export interface PushSubscriptionJson {
	endpoint: string
	keys: { p256dh: string; auth: string }
}

function isIos(): boolean {
	// iPadOS reports as a Mac; the touch points give it away.
	return (
		/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	)
}

/** True when running as an installed app (Home Screen / standalone window) rather than a browser tab. */
export function isStandalone(): boolean {
	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	)
}

export function pushSupport(): PushSupport {
	if (!window.isSecureContext) return 'insecure'
	if (!('serviceWorker' in navigator)) return 'unsupported'
	if (!('PushManager' in window) || !('Notification' in window)) {
		return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
	}
	return 'ok'
}

/** A name for this device in the relay's subscriber list. Coarse on purpose — it's a label, not a fingerprint. */
export function deviceLabel(): string {
	const ua = navigator.userAgent
	const kind = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: 'Browser'
	return isStandalone() ? kind : `${kind} (browser)`
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
	const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

function bytesToBase64Url(buffer: ArrayBuffer): string {
	let binary = ''
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The active service-worker registration. `navigator.serviceWorker.ready` never
 * rejects — in a dev server (where vite-plugin-pwa registers no worker) it just
 * hangs — so it is raced against a timeout rather than awaited bare.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null
	const existing = await navigator.serviceWorker.getRegistration()
	if (existing) return existing
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<null>(resolve => setTimeout(() => resolve(null), 5000))
	])
}

/**
 * Close any notification already on the lock screen for one chat. The relay stops
 * *sending* for a chat being read (src/notify.ts), but one delivered before it was
 * opened is already there, and it outlives the news it carried.
 *
 * The notifier tags per chat, so `tag` is the session id and a sibling chat's own
 * notification is left alone. `getNotifications` is not in every browser that can show
 * a notification, so a missing method is a no-op rather than a throw.
 */
export async function closeNotifications(tag: string): Promise<void> {
	const reg = await registration()
	if (typeof reg?.getNotifications !== 'function') return
	try {
		for (const shown of await reg.getNotifications({ tag })) shown.close()
	} catch {
		// Permission was never granted, or the browser refuses to enumerate. Nothing to clear.
	}
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await registration()
	return (await reg?.pushManager.getSubscription()) ?? null
}

/**
 * Whether a subscription was minted against the relay's *current* VAPID key. A
 * mismatch means the relay lost (or rotated) its keypair, and every push to this
 * subscription will be rejected forever — silently. Caught here so the app can
 * re-subscribe instead of looking enabled while delivering nothing.
 */
export function matchesKey(sub: PushSubscription, publicKey: string): boolean {
	const applied = sub.options.applicationServerKey
	return !!applied && bytesToBase64Url(applied) === publicKey
}

export async function subscribe(publicKey: string): Promise<PushSubscription> {
	const reg = await registration()
	if (!reg) throw new Error('the app’s service worker isn’t running yet — reload and try again')
	return reg.pushManager.subscribe({
		// Required by every browser that implements push: no silent data-only pushes.
		userVisibleOnly: true,
		applicationServerKey: base64UrlToBytes(publicKey) as BufferSource
	})
}

export function toJson(sub: PushSubscription): PushSubscriptionJson {
	const json = sub.toJSON()
	const keys = json.keys ?? {}
	if (!json.endpoint || !keys.p256dh || !keys.auth) throw new Error('the browser returned an incomplete subscription')
	return { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

/**
 * Reconcile this device's subscription with the relay, and report where it ended
 * up. Null means "not subscribed" — never an error: the two sides drift apart for
 * ordinary reasons and the caller's job is only to show the truth.
 *
 * The re-registration is not redundant. The relay's copy of a subscription is the
 * only thing that makes a push happen, and it can go missing without the browser
 * noticing: a wiped store, a different relay behind the same URL, or an endpoint
 * the browser quietly rotated (iOS does, after a long idle). Re-sending what we
 * hold is what puts it back. A *key* mismatch is the worse case — the relay minted
 * a new VAPID keypair, so this subscription is permanently unpushable — and it is
 * repaired by subscribing again, silently, since permission is already granted.
 */
export async function syncSubscription(publicKey: string): Promise<{ id: string | null; devices: number } | null> {
	let sub = await currentSubscription()
	if (sub && !matchesKey(sub, publicKey)) {
		await sub.unsubscribe().catch(() => {})
		sub = Notification.permission === 'granted' ? await subscribe(publicKey) : null
	}
	if (!sub) return null
	const result = await client.pushSubscribe(toJson(sub), deviceLabel())
	return { id: result.id ?? null, devices: result.devices.length }
}
