import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { client } from '../lib/api.ts'
import type { PushSupport } from '../lib/push.ts'
import {
	closeNotifications,
	currentSubscription,
	deviceLabel,
	pushSupport,
	subscribe,
	syncSubscription,
	toJson
} from '../lib/push.ts'
import { useApp } from '../store.ts'

/** The relay's push config, shared by the shell's sync and the Connect sheet's toggle. */
function usePushConfig(enabled: boolean) {
	return useQuery({ queryKey: ['push'], queryFn: () => client.push(), enabled, staleTime: 30_000 })
}

/**
 * Keep this device's subscription and the relay's copy of it in agreement.
 *
 * Mounted on the app shell, not on the Connect sheet: the failure it repairs —
 * the relay no longer holding a subscription that the browser still has, so the
 * toggle reads "on" while nothing is ever delivered — is invisible from the phone,
 * and waiting for someone to open the sheet and look would mean it usually never
 * gets repaired at all. The whole reconciliation lives in `syncSubscription`; this
 * just runs it whenever the relay's public key appears or changes (a changed key
 * *is* the signal that the relay lost its store).
 */
export function usePushSync(): void {
	const [support] = useState(pushSupport)
	const setPush = useApp(s => s.setPush)
	const { data } = usePushConfig(support === 'ok')
	const publicKey = data?.publicKey
	useEffect(() => {
		if (support !== 'ok' || !publicKey) return
		let alive = true
		void syncSubscription(publicKey)
			.then(result => {
				if (alive) setPush({ deviceId: result?.id ?? null, devices: result?.devices ?? 0 })
			})
			.catch(() => {
				// A failed re-sync isn't worth surfacing: the toggle still reflects the browser's
				// own state, and the next load (or focus refetch) tries again.
			})
		return () => {
			alive = false
		}
	}, [support, publicKey, setPush])
}

export interface PushControls {
	support: PushSupport
	/** The browser's own permission state ('unsupported' where the API doesn't exist). */
	permission: NotificationPermission | 'unsupported'
	/** This device has a live subscription registered with the relay. */
	enabled: boolean
	/** The relay is running with notifications switched off entirely (`PUSH_NOTIFY=off`). */
	relayDisabled: boolean
	busy: boolean
	error: string | null
	/** How many phones this relay will notify, including this one. */
	devices: number
	enable: () => Promise<void>
	disable: () => Promise<void>
	test: () => Promise<void>
}

/**
 * The Notifications switch. Reads the reconciled state `usePushSync` put in the
 * store and owns only the three user actions.
 *
 * Turning them on has to happen inside the user's tap — `requestPermission()`
 * needs that activation — so `enable` asks, subscribes and registers in one go
 * rather than splitting the steps across effects.
 */
export function usePush(): PushControls {
	const [support] = useState(pushSupport)
	const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
		'Notification' in window ? Notification.permission : 'unsupported'
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { deviceId, devices } = useApp(s => s.push)
	const setPush = useApp(s => s.setPush)
	const config = usePushConfig(support === 'ok')
	const publicKey = config.data?.publicKey

	const enable = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const permissionResult = await Notification.requestPermission()
			setPermission(permissionResult)
			if (permissionResult !== 'granted') {
				setError(
					permissionResult === 'denied'
						? 'Notifications are blocked for this app — allow them in your device settings, then try again.'
						: 'Notification permission wasn’t granted.'
				)
				return
			}
			const key = publicKey ?? (await client.push()).publicKey
			const sub = await subscribe(key)
			const result = await client.pushSubscribe(toJson(sub), deviceLabel())
			setPush({ deviceId: result.id ?? null, devices: result.devices.length })
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [publicKey, setPush])

	const disable = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const sub = await currentSubscription()
			let remaining = 0
			if (sub) {
				// Tell the relay first so it stops pushing even if the local unsubscribe fails;
				// if this call is the one that fails, the next push 410s and prunes it anyway.
				const result = await client.pushUnsubscribe(sub.endpoint).catch(() => null)
				remaining = result?.devices.length ?? 0
				await sub.unsubscribe()
			}
			setPush({ deviceId: null, devices: remaining })
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [setPush])

	const test = useCallback(async () => {
		if (!deviceId) return
		setBusy(true)
		setError(null)
		try {
			const result = await client.pushTest(deviceId)
			if (!result.ok) setError(result.error ?? 'The push service rejected it.')
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}, [deviceId])

	return {
		support,
		permission,
		enabled: !!deviceId,
		relayDisabled: config.data?.enabled === false,
		busy,
		error,
		devices,
		enable,
		disable,
		test
	}
}

/** Cache Storage entry the service worker parks a tapped notification's target in. */
const ROUTE_CACHE = 'push-route'

const ROUTE_KEY = '/__push-route'

/**
 * How long a parked target stays worth honouring. The gap between the tap and the app
 * coming up is seconds even on a cold launch, so anything older is a tap that never
 * landed — jumping to it when someone opens the app hours later would be a surprise.
 */
const PARKED_ROUTE_MS = 120_000

/** Read and consume the parked target. Reading it is what spends it — it fires once. */
async function takeParkedRoute(): Promise<string | null> {
	if (!('caches' in window)) return null
	try {
		const cache = await caches.open(ROUTE_CACHE)
		const hit = await cache.match(ROUTE_KEY)
		if (!hit) return null
		await cache.delete(ROUTE_KEY)
		const { url, ts } = (await hit.json()) as { url?: unknown; ts?: unknown }
		if (typeof url !== 'string' || !url.startsWith('/')) return null
		if (typeof ts !== 'number' || Date.now() - ts > PARKED_ROUTE_MS) return null
		return url
	} catch {
		// An unreadable entry is not worth a broken app launch.
		return null
	}
}

/**
 * Route a notification tap, from either half of the handoff in public/push-sw.js.
 *
 * The message is the fast path: the service worker posts the target to a live page, so
 * the token gate and whatever is half-typed both survive — a real navigation would
 * remount the SPA. On iOS neither that message nor `openWindow`'s path can be relied
 * on: a backgrounded web app is resumed on the screen it was left on, which is what
 * "tapping the notification does nothing" is. So the worker also parks the target, and
 * the app claims it on the way back to the front — and once at startup, which is the
 * cold-launch case, where iOS opens the start URL and ignores the one we asked for.
 */
export function usePushRouting(): void {
	const navigate = useNavigate()
	useEffect(() => {
		let live = true
		const claimParked = () => {
			void takeParkedRoute().then(url => {
				if (live && url) navigate(url)
			})
		}
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string } | null
			if (data?.type === 'push-navigate' && typeof data.url === 'string' && data.url.startsWith('/')) {
				// Consume the parked copy of this same tap, or it lands twice.
				void takeParkedRoute()
				navigate(data.url)
			}
		}
		const onVisible = () => {
			if (document.visibilityState === 'visible') claimParked()
		}
		if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onMessage)
		document.addEventListener('visibilitychange', onVisible)
		claimParked()
		return () => {
			live = false
			if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onMessage)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [navigate])
}

/**
 * Clear the lock screen of the chat now on screen.
 *
 * The relay leaves a device out of a notification for the chat it is reading, but one
 * delivered *before* the chat was opened is already on the phone, and it says a turn
 * ended in a conversation you are looking at. `at` is the session's `updated_at`, so
 * this also runs when a turn ends here — which is the one case the relay's own
 * suppression can miss, its claim having gone stale while the app was away.
 */
export function useClearChatNotification(sessionId: string | null, at: string | undefined): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: `at` re-runs this when a turn lands here; the body doesn't read it
	useEffect(() => {
		if (!sessionId) return
		const clear = () => {
			if (document.visibilityState === 'visible') void closeNotifications(sessionId)
		}
		clear()
		// Resuming a backgrounded web app fires this rather than remounting, and that is
		// exactly when the notification to clear is the one already sitting there.
		document.addEventListener('visibilitychange', clear)
		return () => document.removeEventListener('visibilitychange', clear)
	}, [sessionId, at])
}
