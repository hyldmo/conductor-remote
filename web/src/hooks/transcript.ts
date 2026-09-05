import { useEffect, useMemo, useRef, useState } from 'react'
import { client } from '../lib/api.ts'
import { mergeEntries, withQueuedEntries } from '../lib/transcript/merge.ts'
import type { TranscriptEntry } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { useOnline } from './browser.ts'

export interface TranscriptState {
	entries: TranscriptEntry[]
	loading: boolean
	error: string | null
}

interface TranscriptPollState extends TranscriptState {
	/** Replaced from the full outbox snapshot on every successful poll. */
	queued: TranscriptEntry[]
}

const sameQueuedEntries = (a: readonly TranscriptEntry[], b: readonly TranscriptEntry[]) =>
	a.length === b.length && a.every((entry, index) => entry.id === b[index].id && entry.text === b[index].text)

/**
 * Incremental transcript polling. Keeps a rowid cursor and appends only new
 * rows, so long sessions don't re-transfer on every tick.
 *
 * **One request at a time, or the chat grows a second copy of itself.** This is the
 * only read in the app that *appends* — every other one is a react-query key, which
 * replaces its data and single-flights per key, so neither hazard exists there. Here
 * the cursor is read when a tick starts and written when it answers, so two ticks
 * overlapping that gap both fetch from the same rowid and both append what came back.
 * The mount is where it bites: the first fetch carries the whole chat (cursor 0), and
 * every 1s tick that lands before it answers repeats the whole chat. On a chat one
 * message long — a workspace just created from the phone, its first prompt the only
 * row — that reads as the prompt having been sent four or six times, the count being
 * however many ticks the round trip outlasted. Nothing was sent twice; Conductor's DB
 * holds one row and remounting the view (leaving the chat and coming back) clears it,
 * which is what the report looked like from the outside.
 *
 * Skipping a tick costs nothing: the cursor hasn't moved, so the next fetch carries
 * everything the skipped one would have. A slow link polls a beat slower and stays
 * correct, which is the trade this had backwards.
 */
export function useTranscript(sessionId: string | null, poll = true): TranscriptState {
	const report = useOnline()
	const [state, setState] = useState<TranscriptPollState>({ entries: [], queued: [], loading: true, error: null })
	const cursor = useRef(0)
	// This poll is also the "I am reading this chat" heartbeat the relay uses to keep a
	// turn ending on screen off the lock screen. Held in a ref rather than in the effect's
	// deps: the id arrives after mount (usePushSync reconciles the subscription), and
	// restarting the effect would reset the cursor and re-fetch the whole chat.
	const readingAs = useApp(s => s.push.deviceId)
	const readingRef = useRef(readingAs)
	readingRef.current = readingAs

	useEffect(() => {
		if (!sessionId) {
			setState({ entries: [], queued: [], loading: false, error: null })
			return
		}
		cursor.current = 0
		setState({ entries: [], queued: [], loading: true, error: null })
		let alive = true
		let inFlight = false

		const tick = async () => {
			if (inFlight) return
			inFlight = true
			try {
				// Claimed only while the page is visible — the same test that moves the read mark
				// (SessionView). A chat left on screen behind a locked phone is one you walked away
				// from, and its notification is the point.
				const reading = document.visibilityState === 'visible' ? readingRef.current : null
				const { entries, queued = [], cursor: next } = await client.messages(sessionId, cursor.current, reading)
				if (!alive) return
				report(true)
				cursor.current = next
				setState(prev => {
					// Durable rows append; the outbox is a full snapshot and must replace its prior
					// value so a dispatched or cancelled prompt disappears on the next tick.
					const nextEntries = entries.length ? mergeEntries(prev.entries, entries) : prev.entries
					const sameQueued = sameQueuedEntries(prev.queued, queued)
					if (nextEntries === prev.entries && sameQueued && !prev.loading && !prev.error) return prev
					return {
						entries: nextEntries,
						queued: sameQueued ? prev.queued : queued,
						loading: false,
						error: null
					}
				})
			} catch (err) {
				if (!alive) return
				report(false, err)
				setState(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }))
			} finally {
				inFlight = false
			}
		}

		tick()
		// 1s cadence keeps the chat feeling live; incremental (cursor) fetches mean
		// an idle tick is a tiny empty response, cheap even over Tailscale. An archived
		// chat has no next message, so it is fetched once and left alone.
		const timer = poll ? setInterval(tick, 1000) : undefined
		return () => {
			alive = false
			if (timer) clearInterval(timer)
		}
	}, [sessionId, poll, report])

	const visibleEntries = useMemo(() => withQueuedEntries(state.entries, state.queued), [state.entries, state.queued])
	return { entries: visibleEntries, loading: state.loading, error: state.error }
}
