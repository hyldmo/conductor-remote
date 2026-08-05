import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, client } from './lib/api.ts'
import type { ParkedPrompt } from './lib/firstPrompt.ts'
import { clearFirstPrompt, listFirstPrompts, noteFirstPromptAttempt } from './lib/firstPrompt.ts'
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
	const clearDraftIfEqual = useApp(s => s.clearDraftIfEqual)

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
					// An undeliverable prompt gets stashed into the draft; once it does go,
					// that copy has to leave with it or the next tap sends it a second time.
					clearDraftIfEqual(workspaceId, text)
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
		[addPending, failPending, removePending, markWorking, clearDraftIfEqual, queryClient]
	)
}

/** Sends spent on a parked first prompt before it is handed back to the composer. */
const FIRST_PROMPT_ATTEMPTS = 3
/** A workspace that never turned ready this long ago is not going to — stop waiting on it. */
const FIRST_PROMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Deliver the first prompt of a workspace created from the phone, once its
 * worktree has finished setting up and its chat exists.
 *
 * Mounted on the app shell rather than in the session view, because that view is
 * the one place the phone reliably *isn't*: setup measured 30s+, and a locked
 * phone, a tap back to the list, or an iOS relaunch (which reopens at `/`, not
 * the workspace) all left a watcher scoped to that route waiting for a mount
 * that never came, with the prompt sitting invisibly in localStorage.
 *
 * Guarded on `last_user_message_at` being null: if the prompt already went —
 * because it was sent from the Mac, where the deep link left it pre-filled in the
 * composer — this must not send it a second time. That same guard is what makes
 * retrying safe, since an attempt whose read-back timed out but which actually
 * landed shows up as a user row before the next one goes.
 *
 * Nothing is ever dropped on the floor: after `FIRST_PROMPT_ATTEMPTS` failures
 * (or once the workspace is plainly never turning ready) the text is stashed in
 * that workspace's composer draft, so it is sitting in the chat box one tap from
 * going instead of disappearing.
 */
export function useFirstPromptDelivery(): void {
	const { data } = useWorkspaces()
	const [parked, setParked] = useState<ParkedPrompt[]>(listFirstPrompts)
	const sendPrompt = useSendPrompt()
	const stashDraft = useApp(s => s.stashDraft)
	const busy = useRef(false)

	// One at a time, oldest first: keeps this to a single extra sessions poll, and
	// there is realistically never more than one workspace mid-creation anyway.
	const next = parked[0]
	const ws = next ? data?.workspaces.find(w => w.id === next.workspaceId) : undefined
	const { data: sessionsData } = useSessions(ws?.state === 'ready' ? ws.id : undefined)
	const sessions = sessionsData?.sessions ?? []
	const session = sessions.find(s => s.id === ws?.active_session_id) ?? sessions[0]

	useEffect(() => {
		if (!next || busy.current) return
		const forget = () => {
			clearFirstPrompt(next.workspaceId)
			setParked(listFirstPrompts())
		}
		const retire = () => {
			stashDraft(next.workspaceId, next.text)
			forget()
		}
		if (Date.now() - next.createdAt > FIRST_PROMPT_MAX_AGE_MS) return retire()
		// Deliberately no "workspace missing → give up": the list poll that would say
		// so is up to 2.5s stale, and the freshly-created workspace is missing from it
		// by definition, so acting on that would retire every prompt on the spot. A
		// workspace that really is gone falls out via the age cap above.
		if (ws?.state !== 'ready' || !session) return
		if (session.last_user_message_at) return forget()

		busy.current = true
		const attempt = noteFirstPromptAttempt(next.workspaceId)
		const target = { id: `first:${next.workspaceId}`, sessionId: session.id, workspaceId: next.workspaceId }
		;(async () => {
			// One pending id across attempts, so retries reuse the bubble instead of stacking.
			// `sendPrompt` reports failure rather than throwing; the catch is the backstop
			// that stops an unexpected throw from retrying this forever.
			const ok = await sendPrompt({ ...target, text: next.text }).catch(() => false)
			if (ok) forget()
			else if (attempt >= FIRST_PROMPT_ATTEMPTS) retire()
			else setParked(listFirstPrompts())
			busy.current = false
		})()
	}, [next, ws, session, sendPrompt, stashDraft])
}
