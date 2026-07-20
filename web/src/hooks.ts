import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, client } from './lib/api.ts'
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

/**
 * Bind the layout height to the *visual* viewport so the iOS software keyboard
 * shrinks the app instead of scrolling it. On iOS, `dvh`/`vh` ignore the
 * keyboard — only `window.visualViewport` reflects it — so the bottom-pinned
 * composer got scrolled up on focus and iOS failed to fully restore that scroll
 * on dismiss, stranding it above the screen bottom. Sizing html/body/#root to
 * `visualViewport.height` (via the `--app-height` var read in index.css) keeps
 * the whole column fitted above the keyboard and returns it cleanly; forcing any
 * residual page scroll back to 0 kills the leftover offset iOS leaves behind.
 */
export function useVisualViewportHeight() {
	useEffect(() => {
		const vv = window.visualViewport
		if (!vv) return
		const apply = () => {
			document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
			// The layout exactly fills the visual viewport, so the document can't
			// legitimately scroll; any offset is iOS's keyboard residual — undo it.
			if (window.scrollY !== 0) window.scrollTo(0, 0)
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
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
	const query = useQuery({
		queryKey: ['state'],
		queryFn: () => client.state(),
		refetchInterval: 2500
	})
	useEffect(() => {
		if (query.isSuccess) report(true)
		if (query.isError) report(false, query.error)
	}, [query.isSuccess, query.isError, query.error, report])
	return query
}

/** All (non-hidden) sessions in a workspace — the desktop app's "tabs". */
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
		async (opts: { id?: string; sessionId: string; workspaceId: string; text: string }) => {
			const text = opts.text.trim()
			if (!text) return
			const id = opts.id ?? crypto.randomUUID()
			const { sessionId, workspaceId } = opts
			addPending({ id, sessionId, workspaceId, text })
			try {
				const r = await client.sendPrompt(sessionId, text, workspaceId)
				if (r.ok) {
					markWorking(sessionId)
					queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] })
					// The confirmed row surfaces on the next poll and hides this bubble;
					// purge it after a beat so a text-match miss can't leave a duplicate.
					setTimeout(() => removePending(id), 4000)
				} else {
					failPending(id, r.error || 'Send failed')
				}
			} catch (err) {
				failPending(id, err instanceof Error ? err.message : String(err))
			}
		},
		[addPending, failPending, removePending, markWorking, queryClient]
	)
}
