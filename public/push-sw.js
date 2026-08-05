// Push handlers for the generated service worker.
//
// vite-plugin-pwa runs in `generateSW` mode, so Workbox owns `sw.js` and there is no
// hand-written worker to add listeners to — this file is pulled in by
// `workbox.importScripts` (see vite.config.ts). It is plain JS on purpose: it is served
// as a static asset, never bundled. Being part of the precache manifest is what makes a
// change here produce a new `sw.js`, so edits actually ship.
//
// Two rules this obeys, both learned from iOS:
// 1. **Every push shows a notification.** Safari treats a push that resolves without one
//    as abuse and can revoke the subscription, so there is no "suppress if the app is
//    open" branch — the relay only sends when something genuinely happened.
// 2. **A tap focuses the existing window** rather than navigating it. The app is a
//    token-gated SPA; `openWindow` on a live client would remount the whole thing and
//    throw away in-progress composer text, so we focus and post a route instead.

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
			// Tagged per workspace by the relay: a chatty agent replaces its own notification
			// instead of stacking. `renotify` keeps the replacement audible.
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
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			for (const client of clients) {
				if (new URL(client.url).origin !== self.location.origin) continue
				try {
					await client.focus()
					// Handled in web/src/hooks.ts (usePushRouting) — an in-app route change,
					// so the token gate and React state survive the tap.
					client.postMessage({ type: 'push-navigate', url })
					return
				} catch {
					// focus() can be refused (no user activation on some platforms) — fall through to openWindow
				}
			}
			await self.clients.openWindow(url)
		})()
	)
})
