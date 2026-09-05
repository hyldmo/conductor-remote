import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api.ts'
import { hasSelection, overSelection } from '../lib/selection.ts'
import { useApp } from '../store.ts'

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
 *
 * The drag paints an inline `transform`, which outranks the class that opens and
 * closes the drawer — so a touch sequence that never reports its end strands the
 * drawer wherever the finger left it, deaf to the close button and the scrim, and
 * only a relaunch clears it. iOS ends touches silently more often than it should:
 * the system claiming the swipe for its own edge gesture, a call arriving, the PWA
 * being backgrounded mid-drag. Two guards, because the stranding shows up twice —
 * the drawer stuck on screen, and a stale `tracking` flag dragging it back out of
 * the next scroll: `abort` ends an orphaned gesture on the next touch or on the app
 * going away, and the committed state gets the last word (see the effect below).
 */
export function useEdgeSwipeDrawer(drawerRef: RefObject<HTMLElement | null>) {
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	const open = useApp(s => s.sidebarOpen)
	const openRef = useRef(open)
	openRef.current = open

	// Whatever the app believes is what's on screen: every committed open/close drops
	// the drag's overrides, so a tap can always undo a gesture that stranded them.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs for the committed state, which the body doesn't read
	useEffect(() => {
		const node = drawerRef.current
		if (!node) return
		node.style.transition = ''
		node.style.transform = ''
	}, [open, drawerRef])

	useEffect(() => {
		// 44px, Apple's minimum touch target — 28 was under it, and a thumb reaching
		// across the phone lands short of the glass often enough to feel broken.
		const EDGE = 44 // px from the left where an opening swipe may begin
		const COMMIT = 0.4 // fraction of the drawer that must show to snap open
		const desktop = window.matchMedia('(min-width: 768px)')
		const drawer = () => drawerRef.current

		let tracking = false
		let horizontal = false
		let bailed = false
		let selecting = false
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

		// A wider edge reaches over things that scroll sideways themselves — a code
		// block, a diff, the tab strip — and those start at the left of the pane, so
		// the zone now overlaps them. One already pushed off its left end is being
		// read, not swiped from: leave it alone rather than yank the drawer out.
		const overScrolledContent = (target: EventTarget | null) => {
			for (let el = target as HTMLElement | null; el; el = el.parentElement) {
				if (el.scrollLeft > 0) return true
			}
			return false
		}

		// End a gesture that never reported its own end, and hand the drawer back to its
		// class. A no-op unless one is stranded, so it costs nothing on the normal path.
		const abort = () => {
			if (!tracking) return
			tracking = false
			release()
		}

		const onStart = (e: TouchEvent) => {
			abort()
			if (desktop.matches || e.touches.length !== 1) return
			const t = e.touches[0]
			if (openRef.current) {
				const right = drawer()?.getBoundingClientRect().right ?? 0
				if (t.clientX > right) return // drag must start over the drawer to close it
			} else if (t.clientX > EDGE || overScrolledContent(e.target)) return // …or at the edge to open it
			// A selection handle sits within reach of the left margin often enough, and
			// dragging one is a horizontal drag we would `preventDefault` — cancelling the
			// selection and sliding the drawer out in its place.
			if (overSelection(t.clientX, t.clientY)) return
			tracking = true
			horizontal = false
			bailed = false
			selecting = hasSelection()
			startX = t.clientX
			startY = t.clientY
			width = drawer()?.offsetWidth ?? 0
		}

		const onMove = (e: TouchEvent) => {
			if (!tracking || bailed) return
			// Text selected under a finger that arrived with none is a long press, not a
			// swipe: the drag from here belongs to the handles.
			if (!selecting && hasSelection()) {
				bailed = true
				return
			}
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
		// Backgrounding is the one silent ending we get told about — iOS suspends the PWA
		// with the finger still down and delivers nothing on resume.
		document.addEventListener('visibilitychange', abort)
		return () => {
			window.removeEventListener('touchstart', onStart)
			window.removeEventListener('touchmove', onMove)
			window.removeEventListener('touchend', onEnd)
			window.removeEventListener('touchcancel', onEnd)
			document.removeEventListener('visibilitychange', abort)
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
export function useOnline() {
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

/** Hold a fast-changing value still until it settles, so a keystroke isn't a request. */
export function useDebounced<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value)
	useEffect(() => {
		const t = setTimeout(() => setSettled(value), ms)
		return () => clearTimeout(t)
	}, [value, ms])
	return settled
}
