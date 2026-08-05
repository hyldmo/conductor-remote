import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, client } from './lib/api.ts'
import type { PushSupport } from './lib/push.ts'
import { currentSubscription, deviceLabel, pushSupport, subscribe, syncSubscription, toJson } from './lib/push.ts'
import type { TranscriptEntry } from './lib/types.ts'
import { useApp } from './store.ts'

/**
 * Drag-to-open the mobile workspace drawer, and hijack iOS/Chrome's left-edge
 * back-swipe so it opens the drawer instead of navigating history. A touch that
 * begins in the leftmost `EDGE` px (drawer closed) or anywhere over the open
 * drawer is tracked; once it reads as horizontal we `preventDefault` — the
 * non-passive `touchmove` listener is the *only* thing that actually cancels
 * iOS's native edge gesture (`touch-action`/`overscroll-behavior` don't) — and
 * translate the drawer live, committing open/closed on release. Only active
 * below `md`, where the drawer is a floating overlay; the static desktop rail
 * is left alone.
 */
export function useEdgeSwipeDrawer(drawerRef: RefObject<HTMLElement | null>) {
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	const open = useApp(s => s.sidebarOpen)
	const openRef = useRef(open)
	openRef.current = open

	useEffect(() => {
		const EDGE = 28 // px from the left where an opening swipe may begin
		const COMMIT = 0.4 // fraction of the drawer that must show to snap open
		const desktop = window.matchMedia('(min-width: 768px)')
		const drawer = () => drawerRef.current

		let tracking = false
		let horizontal = false
		let bailed = false
		let startX = 0
		let startY = 0
		let width = 0
		let appliedX = 0

		const paint = (x: number) => {
			const node = drawer()
			if (!node) return
			node.style.transition = 'none'
			node.style.transform = `translateX(${x}px)`
			appliedX = x
		}
		const release = () => {
			const node = drawer()
			if (!node) return
			// Drop the inline overrides so the CSS class + transition drive the snap.
			node.style.transition = ''
			node.style.transform = ''
		}

		const onStart = (e: TouchEvent) => {
			if (desktop.matches || e.touches.length !== 1) return
			const t = e.touches[0]
			if (openRef.current) {
				const right = drawer()?.getBoundingClientRect().right ?? 0
				if (t.clientX > right) return // drag must start over the drawer to close it
			} else if (t.clientX > EDGE) return // …or at the very edge to open it
			tracking = true
			horizontal = false
			bailed = false
			startX = t.clientX
			startY = t.clientY
			width = drawer()?.offsetWidth ?? 0
		}

		const onMove = (e: TouchEvent) => {
			if (!tracking || bailed) return
			const t = e.touches[0]
			const dx = t.clientX - startX
			const dy = t.clientY - startY
			if (!horizontal) {
				if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
					bailed = true // vertical intent → let it scroll (and it won't trigger back)
					return
				}
				if (Math.abs(dx) < 6) return
				horizontal = true
			}
			e.preventDefault()
			const base = openRef.current ? 0 : -width
			paint(Math.max(-width, Math.min(0, base + dx)))
		}

		const onEnd = () => {
			if (!tracking) return
			tracking = false
			if (!horizontal || bailed) return release()
			const shown = width ? (appliedX + width) / width : 0
			release()
			setSidebarOpen(shown > COMMIT)
		}

		window.addEventListener('touchstart', onStart, { passive: true })
		window.addEventListener('touchmove', onMove, { passive: false })
		window.addEventListener('touchend', onEnd)
		window.addEventListener('touchcancel', onEnd)
		return () => {
			window.removeEventListener('touchstart', onStart)
			window.removeEventListener('touchmove', onMove)
			window.removeEventListener('touchend', onEnd)
			window.removeEventListener('touchcancel', onEnd)
		}
	}, [drawerRef, setSidebarOpen])
}

const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])'

/**
 * Shrink the layout to fit above the iOS software keyboard — but *only* while the
 * keyboard is actually up. On iOS, `dvh`/`vh` ignore the keyboard (only
 * `window.visualViewport` reflects it), so a bottom-pinned composer got scrolled
 * up on focus and stranded above the bottom on dismiss. The obvious fix — always
 * sizing html/body/#root to `visualViewport.height` — backfires: at rest on a
 * standalone PWA (viewport-fit=cover), `visualViewport.height` is the *safe*
 * viewport, short of the home-indicator inset, so binding to it unconditionally
 * ends the app above the physical bottom (the exact regression #24 fixed).
 *
 * So we only write `--app-height` (read by html/body/#root in index.css) when the
 * keyboard is up; otherwise we clear it and let `100dvh` fill the whole screen.
 * Three things decide "keyboard is up", because a bare `innerHeight - vv.height`
 * threshold answered it wrong in both directions:
 *
 * 1. **A text field must be focused.** This is the ground truth iOS gives us, and
 *    it's what makes dismissal reliable: `focusout` clears the override on the
 *    spot instead of waiting for a resize event iOS may report late, mid-animation,
 *    or (on a swipe-to-dismiss) not at all. That stranded the app at keyboard
 *    height after the field closed.
 * 2. **The page must not be zoomed.** iOS auto-zooms on focusing a sub-16px field
 *    and does *not* zoom back out on blur; a zoom shrinks `vv.height` exactly like
 *    a keyboard does, so the old check locked the app into the zoomed box forever.
 *    (The fields are all ≥16px now so the auto-zoom shouldn't fire, but a pinch
 *    must not be able to resurrect this.)
 * 3. **The drop is measured against the resting height, not `innerHeight`.** The
 *    resting gap is a per-device safe-area inset, so a fixed 120px threshold was a
 *    guess; sampling `vv.height` whenever nothing is focused calibrates it live —
 *    but only at plausible resting values: a blur lands *before* the keyboard has
 *    animated away, so an unguarded sample poisoned `rest` with a keyboard-height
 *    reading and the next focus measured "no drop" (composer left behind the
 *    keyboard).
 * 4. **The exit can't be event-driven alone.** Standalone iOS swallows the vv
 *    resize / focusout that should end the override — backgrounding the PWA with
 *    the keyboard up is the reliable repro (iOS drops the keyboard while the page
 *    is suspended and never delivers the matching events on resume). Once in that
 *    state nothing the user taps re-enters this code, so the app stayed shrunk
 *    with a dead gap under the composer until a full relaunch. Two backstops: a
 *    watchdog re-checks on a short interval while in the keyboard state (a fresh
 *    read of `vv.height` is accurate even when the event never fired), and going
 *    hidden blurs the field and drops the override outright so a resume always
 *    starts at full height.
 *
 * The height also adds `vv.offsetTop` — when iOS shifts the layout viewport under
 * a fixed visual one, that's how much further down the column must reach for its
 * bottom edge to meet the top of the keyboard. Forcing residual page scroll back
 * to 0 kills the leftover offset iOS leaves behind on dismiss.
 */
export function useVisualViewportHeight() {
	useEffect(() => {
		const vv = window.visualViewport
		if (!vv) return
		const root = document.documentElement
		// Tells index.css to size the app off `vh` instead of `dvh` — see the comment
		// there. `navigator.standalone` is the iOS-only fallback for versions whose
		// home-screen apps don't match the display-mode query.
		if (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone)
			root.setAttribute('data-standalone', '')
		// Visual-viewport height with no keyboard up, measured rather than assumed.
		let rest = 0
		let watchdog: ReturnType<typeof setInterval> | undefined
		const clear = () => {
			root.style.removeProperty('--app-height') // no keyboard → 100dvh fills the screen
			root.removeAttribute('data-keyboard')
		}
		// Watchdog while a field is focused or the override is live (trap 4): idle at
		// rest, and a stuck override self-heals within a tick instead of never.
		const watch = (on: boolean) => {
			if (on && !watchdog) watchdog = setInterval(apply, 300)
			else if (!on && watchdog) {
				clearInterval(watchdog)
				watchdog = undefined
			}
		}
		const apply = () => {
			const el = document.activeElement
			const typing = el instanceof HTMLElement && el.matches(EDITABLE)
			const zoomed = vv.scale > 1.01
			if (!typing || zoomed) {
				// Recalibrate only near the full window height (trap 3): mid-dismiss and
				// backgrounded readings still carry the keyboard, never the resting inset.
				if (!zoomed && window.innerHeight - vv.height < 120) rest = vv.height
				clear()
			} else if ((rest || window.innerHeight) - vv.height > 40) {
				root.style.setProperty('--app-height', `${Math.round(vv.height + vv.offsetTop)}px`)
				root.setAttribute('data-keyboard', '')
			} else {
				clear()
			}
			watch(typing || root.hasAttribute('data-keyboard'))
			// The column always fits the visible area, so any page scroll is iOS's
			// keyboard residual — undo it.
			if (window.scrollY !== 0) window.scrollTo(0, 0)
		}
		// Focus changes land before iOS has resized anything, so also re-check once the
		// keyboard animation has settled.
		let settle: ReturnType<typeof setTimeout>
		const onFocusChange = () => {
			apply()
			clearTimeout(settle)
			settle = setTimeout(apply, 350)
		}
		// Going hidden, exit the keyboard state deliberately (trap 4); coming back,
		// re-measure now and again once the resume has settled.
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') {
				const el = document.activeElement
				if (el instanceof HTMLElement && el.matches(EDITABLE)) el.blur()
				clear()
				watch(false)
			} else onFocusChange()
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		window.addEventListener('pageshow', onFocusChange)
		document.addEventListener('visibilitychange', onVisibility)
		document.addEventListener('focusin', onFocusChange)
		document.addEventListener('focusout', onFocusChange)
		return () => {
			clearTimeout(settle)
			watch(false)
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
			window.removeEventListener('pageshow', onFocusChange)
			document.removeEventListener('visibilitychange', onVisibility)
			document.removeEventListener('focusin', onFocusChange)
			document.removeEventListener('focusout', onFocusChange)
			clear()
		}
	}, [])
}

/** Surface a 401 so the app can bounce back to the token gate. */
function useOnline() {
	const setOnline = useApp(s => s.setOnline)
	const setToken = useApp(s => s.setToken)
	return useCallback(
		(ok: boolean, err?: unknown) => {
			setOnline(ok)
			if (err instanceof ApiError && err.status === 401) setToken(null)
		},
		[setOnline, setToken]
	)
}

export function useWorkspaces() {
	const report = useOnline()
	const setUpdate = useApp(s => s.setUpdate)
	const query = useQuery({
		queryKey: ['state'],
		queryFn: () => client.state(),
		refetchInterval: 2500
	})
	useEffect(() => {
		if (query.isSuccess) {
			report(true)
			setUpdate(query.data.update ?? null)
		}
		if (query.isError) report(false, query.error)
	}, [query.isSuccess, query.isError, query.error, query.data, report, setUpdate])
	return query
}

/** All (non-hidden) sessions in a workspace — the desktop app's "tabs". */
/** Repos Conductor knows about — static enough to fetch once per app load. */
export function useRepos() {
	return useQuery({ queryKey: ['repos'], queryFn: () => client.repos(), staleTime: 60_000 })
}

export function useSessions(workspaceId: string | undefined) {
	const report = useOnline()
	const query = useQuery({
		queryKey: ['sessions', workspaceId],
		queryFn: () => client.sessions(workspaceId as string),
		enabled: !!workspaceId,
		refetchInterval: 2000
	})
	useEffect(() => {
		if (query.isError) report(false, query.error)
	}, [query.isError, query.error, report])
	return query
}

export function useDiff(workspaceId: string | undefined, enabled: boolean) {
	const report = useOnline()
	const query = useQuery({
		queryKey: ['diff', workspaceId],
		queryFn: () => client.diff(workspaceId as string),
		enabled: enabled && !!workspaceId,
		refetchInterval: 5000
	})
	useEffect(() => {
		if (query.isError) report(false, query.error)
	}, [query.isError, query.error, report])
	return query
}

/**
 * A repo's icon as an object URL, fetched with the auth header so the token stays out of the image URL
 * (query strings can leak into proxy/Funnel logs). Deduped and cached for the session across every card
 * that shares the repo — icons rarely change, so it never refetches or revokes within a session.
 */
export function useRepoIcon(repoName: string | null | undefined) {
	return useQuery({
		queryKey: ['repoIcon', repoName],
		queryFn: () => client.repoIcon(repoName as string),
		enabled: !!repoName,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}

/**
 * The relay's log, polled while the viewer is open. Deliberately outside the offline reporter: a 404
 * for a log file that doesn't exist yet is a fact about that file, not a dead relay, and flipping the
 * whole app to "Offline" over it would be a lie. Retries are off for the same reason.
 */
export function useLogs(file: string | null, enabled: boolean) {
	return useQuery({
		queryKey: ['logs', file],
		queryFn: () => client.logs(file),
		enabled,
		refetchInterval: 3000,
		retry: false
	})
}

export interface TranscriptState {
	entries: TranscriptEntry[]
	loading: boolean
	error: string | null
}

/**
 * Incremental transcript polling. Keeps a rowid cursor and appends only new
 * rows, so long sessions don't re-transfer on every tick.
 */
export function useTranscript(sessionId: string | null): TranscriptState {
	const report = useOnline()
	const [state, setState] = useState<TranscriptState>({ entries: [], loading: true, error: null })
	const cursor = useRef(0)

	useEffect(() => {
		if (!sessionId) {
			setState({ entries: [], loading: false, error: null })
			return
		}
		cursor.current = 0
		setState({ entries: [], loading: true, error: null })
		let alive = true

		const tick = async () => {
			try {
				const { entries, cursor: next } = await client.messages(sessionId, cursor.current)
				if (!alive) return
				report(true)
				if (entries.length) {
					cursor.current = next
					setState(prev => ({ entries: [...prev.entries, ...entries], loading: false, error: null }))
				} else {
					setState(prev => (prev.loading ? { ...prev, loading: false } : prev))
				}
			} catch (err) {
				if (!alive) return
				report(false, err)
				setState(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }))
			}
		}

		tick()
		// 1s cadence keeps the chat feeling live; incremental (cursor) fetches mean
		// an idle tick is a tiny empty response, cheap even over Tailscale.
		const timer = setInterval(tick, 1000)
		return () => {
			alive = false
			clearInterval(timer)
		}
	}, [sessionId, report])

	return state
}

/**
 * Send a prompt with an optimistic in-chat bubble. Adds a `sending` pending
 * immediately, then relies on the relay's delivery read-back: on `ok` the real
 * user row lands via the transcript poll and reconciles the bubble away (a
 * fallback purge covers the rare no-match); on failure the bubble flips to an
 * inline error with Retry. Reused by the Composer and the Transcript's Retry
 * button — pass the pending's `id` to retry in place. There is no green "Sent"
 * toast: a delivered prompt simply appears in the chat, a failed one shows an error.
 */
export function useSendPrompt() {
	const queryClient = useQueryClient()
	const addPending = useApp(s => s.addPending)
	const failPending = useApp(s => s.failPending)
	const removePending = useApp(s => s.removePending)
	const markWorking = useApp(s => s.markWorking)

	return useCallback(
		async (opts: { id?: string; sessionId: string; workspaceId: string; text: string }): Promise<boolean> => {
			const text = opts.text.trim()
			if (!text) return false
			const id = opts.id ?? crypto.randomUUID()
			const { sessionId, workspaceId } = opts
			addPending({ id, sessionId, workspaceId, text })
			try {
				const r = await client.sendPrompt(sessionId, text, workspaceId)
				if (r.ok) {
					markWorking(sessionId)
					queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] })
					// A send by hand supersedes any first prompt the relay was still holding, and
					// the relay drops that entry — so re-read the list the queued bubble comes from.
					queryClient.invalidateQueries({ queryKey: ['state'] })
					// The confirmed row surfaces on the next poll and hides this bubble;
					// purge it after a beat so a text-match miss can't leave a duplicate.
					setTimeout(() => removePending(id), 4000)
					return true
				}
				failPending(id, r.error || 'Send failed')
			} catch (err) {
				failPending(id, err instanceof Error ? err.message : String(err))
			}
			return false
		},
		[addPending, failPending, removePending, markWorking, queryClient]
	)
}

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

/**
 * Route a notification tap. The service worker focuses the open app and posts the
 * target instead of navigating it (see public/push-sw.js) — a real navigation
 * would remount the token-gated SPA and drop whatever was half-typed.
 */
export function usePushRouting(): void {
	const navigate = useNavigate()
	useEffect(() => {
		if (!('serviceWorker' in navigator)) return
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string } | null
			if (data?.type === 'push-navigate' && typeof data.url === 'string' && data.url.startsWith('/')) {
				navigate(data.url)
			}
		}
		navigator.serviceWorker.addEventListener('message', onMessage)
		return () => navigator.serviceWorker.removeEventListener('message', onMessage)
	}, [navigate])
}
