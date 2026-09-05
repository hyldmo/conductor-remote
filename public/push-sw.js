// Push handlers for the generated service worker.
//
// vite-plugin-pwa runs in `generateSW` mode, so Workbox owns `sw.js` and there is no
// hand-written worker to add listeners to — this file is pulled in by
// `workbox.importScripts` (see vite.config.ts). It is plain JS on purpose: it is served
// as a static asset, never bundled. Being part of the precache manifest is what makes a
// change here produce a new `sw.js`, so edits actually ship.
//
// Four rules this obeys, every one of them learned from iOS:
// 1. **Every push shows a notification.** Safari treats a push that resolves without one
//    as abuse and can revoke the subscription, so there is no "suppress if the app is
//    open" branch — the relay only sends when something genuinely happened.
// 2. **A tap prefers focusing the existing window** over navigating it. The app is a
//    token-gated SPA; `openWindow` on a live client would remount the whole thing and
//    throw away in-progress composer text, so we focus and post a route instead.
// 3. **A focus that didn't land still owes the tap a window.** Nothing here happens by
//    default: a notification click fires this handler and the app comes forward only
//    because the handler asks it to. iOS returns a backgrounded home-screen web app as
//    a live window client whose `focus()` can settle without foregrounding it, so
//    treating "we found a client" as success ended the tap with the phone exactly where
//    it was — a notification that ignores your finger. `focusClient` therefore reports
//    whether the app really came up, and `openWindow` is the fallback rather than the
//    branch for an app that isn't running.
// 4. **The route is also parked in Cache Storage**, because on iOS neither of the two
//    direct routes survives. A backgrounded home-screen web app is resumed on whatever
//    screen it was left on — `openWindow`'s path is ignored, and a `postMessage` to a
//    frozen page is dropped (WebKit, reported from iOS 17.1 through 18.x and still
//    open). The cache outlives both, so the app reads its target when it comes back to
//    the front; see `usePushRouting` in web/src/hooks/push.ts.

/** One entry, overwritten per tap: only the newest tap can still be waiting to land. */
const ROUTE_CACHE = 'push-route'
const ROUTE_KEY = '/__push-route'

async function parkRoute(url) {
	try {
		const cache = await caches.open(ROUTE_CACHE)
		await cache.put(ROUTE_KEY, new Response(JSON.stringify({ url, ts: Date.now() })))
	} catch {
		// Storage refused it (quota, a private window). The two direct routes below still stand.
	}
}

/**
 * Is this client one of ours? Parsed in a `try`, because an unparseable client URL
 * throwing here would take the whole handler down and `openWindow` with it — the tap
 * would then do nothing, which is the failure this file is trying to end.
 */
function sameOrigin(clientUrl) {
	try {
		return new URL(clientUrl).origin === self.location.origin
	} catch {
		return false
	}
}

/**
 * Bring an already-open app window to the front, and say whether it really came.
 *
 * That answer is the whole point. A notification click has no default action — the app
 * comes forward only because this handler asks it to — so a `focus()` that quietly does
 * nothing ends the tap with the phone exactly where it was, which reads as a
 * notification that ignores your finger. iOS hands back a backgrounded home-screen web
 * app as a live window client, and `focus()` on it can settle without foregrounding
 * anything, so "we found a client" is not "the app is up".
 *
 * A refusal, a resolve with nothing, and a client that reports itself unfocused all
 * count as "no". Answering "no" too readily costs at worst a second `openWindow` on a
 * platform that had already handled the tap; answering "yes" too readily costs the tap.
 */
async function focusClient(client) {
	try {
		const focused = await client.focus()
		return !!focused && focused.focused !== false
	} catch {
		// Refused (some platforms want a user activation this event doesn't carry).
		return false
	}
}

self.addEventListener('push', event => {
	const fallback = { title: 'Conductor Remote', body: 'Something changed in a workspace.', url: '/', tag: 'conductor' }
	let data = fallback
	if (event.data) {
		try {
			data = Object.assign({}, fallback, event.data.json())
		} catch {
			// Not ours / not JSON — still show something rather than a browser-generic notice.
			data = Object.assign({}, fallback, { body: event.data.text() })
		}
	}
	event.waitUntil(
		self.registration.showNotification(data.title, {
			body: data.body,
			// Tagged per chat by the relay: a chatty agent replaces its own notification
			// instead of stacking, while a sibling chat keeps its own (they open different
			// screens). `renotify` keeps the replacement audible.
			tag: data.tag,
			renotify: true,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			timestamp: data.ts || Date.now(),
			data: { url: data.url || '/' }
		})
	)
})

self.addEventListener('notificationclick', event => {
	event.notification.close()
	const url = (event.notification.data && event.notification.data.url) || '/'
	event.waitUntil(
		(async () => {
			// Park first. Everything below can succeed and still leave the phone on the wrong
			// screen, and this is the copy the app reads when it wakes up.
			await parkRoute(url)
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			for (const client of clients) {
				if (!sameOrigin(client.url)) continue
				// Handled in web/src/hooks/push.ts (usePushRouting) — an in-app route change, so the
				// token gate and React state survive the tap. Posted before the focus, since a
				// refused focus is no reason to skip a message the page may well receive.
				client.postMessage({ type: 'push-navigate', url })
				if (await focusClient(client)) return
				break
			}
			// Nothing is open, or the focus above never landed. `openWindow` is the only lever
			// left that can put the app on screen, and on an installed iOS web app it launches
			// or resumes the one instance rather than adding a second — the path is what it
			// drops, and the parked route above is what covers that.
			await self.clients.openWindow(url)
		})()
	)
})
