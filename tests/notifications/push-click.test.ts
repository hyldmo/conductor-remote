import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/**
 * What a tapped notification does (public/push-sw.js ▸ `notificationclick`).
 *
 * A notification click has no default action. The app comes to the front only because
 * this handler asks it to, so every way of ending the handler without asking is a tap
 * that does nothing at all — no window, no error, nothing to report. That is how the
 * bug this pins reached a phone and stayed: the handler focused the first same-origin
 * client and returned whether or not the focus landed, and iOS hands back a
 * backgrounded home-screen web app as a live client whose `focus()` settles without
 * foregrounding anything. Every notification then read as a dead pixel.
 *
 * The file is plain JS served as a static asset, so it is loaded the way the worker
 * loads it — as source, against a stubbed `self` — rather than imported.
 */
const SOURCE = readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://mac.taila6dcd6.ts.net'
const ROUTE_KEY = '/__push-route'

type FakeClient = {
	url: string
	messages: unknown[]
	postMessage: (message: unknown) => void
	focus: () => Promise<unknown>
}

/** A window client that reports itself focused, which is a focus that landed. */
function client(over: Partial<FakeClient> & { focused?: boolean } = {}): FakeClient {
	const messages: unknown[] = []
	const self: FakeClient = {
		url: `${ORIGIN}/w/w1?session=s1`,
		messages,
		postMessage: message => void messages.push(message),
		focus: async () => ({ focused: over.focused ?? true }),
		...over
	}
	return self
}

function loadWorker(clients: FakeClient[]) {
	const listeners = new Map<string, (event: unknown) => void>()
	const opened: string[] = []
	const cache = new Map<string, Response>()
	const worker = {
		addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
		location: { origin: ORIGIN },
		registration: { showNotification: async () => undefined },
		clients: {
			matchAll: async () => clients,
			openWindow: async (url: string) => {
				opened.push(url)
				return null
			}
		}
	}
	const caches = {
		open: async () => ({
			put: async (key: string, value: Response) => void cache.set(key, value),
			match: async (key: string) => cache.get(key),
			delete: async (key: string) => cache.delete(key)
		})
	}
	new Function('self', 'caches', SOURCE)(worker, caches)

	/** Tap a notification and wait for the handler to finish, as the browser would. */
	const click = async (url?: string) => {
		const handler = listeners.get('notificationclick')
		if (!handler) throw new Error('push-sw.js registered no notificationclick handler')
		let closed = false
		const work: Promise<unknown>[] = []
		handler({
			notification: {
				data: url === undefined ? null : { url },
				close: () => {
					closed = true
				}
			},
			waitUntil: (p: Promise<unknown>) => {
				work.push(p)
			}
		})
		await Promise.all(work)
		return { closed }
	}

	const parked = async () => {
		const hit = cache.get(ROUTE_KEY)
		return hit ? ((await hit.json()) as { url: string; ts: number }) : null
	}

	return { click, opened, parked }
}

describe('a tapped notification always ends with the app on screen', () => {
	test('a focus that lands is the whole tap: the open page is routed in place', async () => {
		const page = client()
		const { click, opened } = loadWorker([page])

		await click('/w/w1?session=s1')

		expect(page.messages).toEqual([{ type: 'push-navigate', url: '/w/w1?session=s1' }])
		// Opening a window here would remount the SPA and throw away a half-typed prompt.
		expect(opened).toEqual([])
	})

	test('a focus that resolves without foregrounding still opens a window', async () => {
		// iOS: the backgrounded web app is a live client, and focusing it settles quietly.
		// Taking that for success is the bug — the tap ended here and nothing came up.
		const asleep = client({ focused: false })
		const { click, opened } = loadWorker([asleep])

		await click('/w/w1?session=s1')

		expect(asleep.messages).toHaveLength(1)
		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('a refused focus opens a window', async () => {
		const refuses = client({ focus: async () => Promise.reject(new Error('no user activation')) })
		const { click, opened } = loadWorker([refuses])

		await click('/w/w1?session=s1')

		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('a focus that resolves with nothing opens a window', async () => {
		const vague = client({ focus: async () => undefined })
		const { click, opened } = loadWorker([vague])

		await click('/w/w1?session=s1')

		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('no open page at all opens a window', async () => {
		const { click, opened } = loadWorker([])

		await click('/w/w1?session=s1')

		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('a foreign page is never messaged, and never stands in for ours', async () => {
		const stranger = client({ url: 'https://example.com/w/w1' })
		const { click, opened } = loadWorker([stranger])

		await click('/w/w1?session=s1')

		expect(stranger.messages).toEqual([])
		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('an unparseable client url does not swallow the tap', async () => {
		// A throw inside the scan would take `openWindow` down with it, which is the same
		// dead tap by another route.
		const broken = client({ url: 'not a url' })
		const { click, opened } = loadWorker([broken])

		await click('/w/w1?session=s1')

		expect(opened).toEqual(['/w/w1?session=s1'])
	})

	test('a notification carrying no url still opens the app', async () => {
		const { click, opened } = loadWorker([])

		const { closed } = await click()

		expect(closed).toBe(true)
		expect(opened).toEqual(['/'])
	})
})

describe('the route is parked before anything else', () => {
	test('a tap that opens a window leaves the target for the app to claim', async () => {
		// `openWindow`'s path is ignored on iOS, so the parked copy is what actually
		// carries the chat id across a cold launch (web/src/hooks/push.ts ▸ usePushRouting).
		const { click, parked } = loadWorker([])

		await click('/w/w1?session=s1')

		expect((await parked())?.url).toBe('/w/w1?session=s1')
	})

	test('a tap the open page handled leaves it too, since the message can be dropped', async () => {
		const page = client()
		const { click, parked } = loadWorker([page])

		await click('/w/w1?session=s1')

		expect((await parked())?.url).toBe('/w/w1?session=s1')
	})
})
