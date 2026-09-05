import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, client } from '../lib/api.ts'
import { localPrefsGeneration, localPrefsSnapshot, mergeRemotePrefs, subscribeLocalPrefs } from '../lib/prefs.ts'
import { useApp } from '../store.ts'
import { useOnline } from './browser.ts'

/**
 * Reconcile local-first PWA state with the host without putting the network in the
 * typing path. Local edits flush after a short idle; blur/background flush immediately,
 * and a small poll picks up another device's changes while this one stays open.
 */
export function usePrefsSync(): void {
	const report = useOnline()
	useEffect(() => {
		const DEBOUNCE_MS = 700
		const POLL_MS = 15_000
		let alive = true
		let inFlight = false
		let queuedWrite = false
		let queuedKeepalive = false
		let debounce: ReturnType<typeof setTimeout> | null = null

		const apply = (prefs: Awaited<ReturnType<typeof client.prefs>>['prefs']) => {
			const merged = mergeRemotePrefs(prefs, useApp.getState().focusedDraft)
			useApp.getState().applySyncedPrefs(merged.state)
			if (merged.needsUpload) schedule(false)
		}

		const sync = async (write: boolean, keepalive = false) => {
			if (!alive) return
			if (inFlight) {
				queuedWrite ||= write
				queuedKeepalive ||= keepalive
				return
			}
			inFlight = true
			const generation = localPrefsGeneration()
			try {
				const response = write ? await client.patchPrefs(localPrefsSnapshot(), keepalive) : await client.prefs()
				if (!alive) return
				report(true)
				apply(response.prefs)
				if (localPrefsGeneration() !== generation) schedule(false)
			} catch (err) {
				if (!alive) return
				// A cached new PWA can briefly meet a relay from before this endpoint. Keep
				// local persistence working without misreporting the whole app as offline.
				if (!(err instanceof ApiError && err.status === 404)) report(false, err)
			} finally {
				inFlight = false
				if (alive && queuedWrite) {
					const nextKeepalive = queuedKeepalive
					queuedWrite = false
					queuedKeepalive = false
					void sync(true, nextKeepalive)
				}
			}
		}

		function schedule(immediate: boolean, keepalive = false): void {
			if (debounce) clearTimeout(debounce)
			debounce = null
			if (immediate) void sync(true, keepalive)
			else debounce = setTimeout(() => void sync(true), DEBOUNCE_MS)
		}

		const unsubscribe = subscribeLocalPrefs(immediate => schedule(immediate))
		const poll = setInterval(() => void sync(false), POLL_MS)
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') schedule(true, true)
			else void sync(false)
		}
		const onOnline = () => schedule(true)
		document.addEventListener('visibilitychange', onVisibility)
		window.addEventListener('online', onOnline)
		// PATCH on boot both pulls the canonical host copy and uploads a legacy local
		// draft on the very first run, so migration needs no separate round trip.
		void sync(true)

		return () => {
			alive = false
			if (debounce) clearTimeout(debounce)
			clearInterval(poll)
			unsubscribe()
			document.removeEventListener('visibilitychange', onVisibility)
			window.removeEventListener('online', onOnline)
		}
	}, [report])
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
