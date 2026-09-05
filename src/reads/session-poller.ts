/**
 * One clock and one base SQLite read for every live-session observer.
 *
 *   setInterval ──▶ Reads.listSessionStates()
 *                         │ same immutable-by-convention snapshot
 *                  ┌──────┴────────┐
 *                  ▼               ▼
 *             notifications   delegation details
 *                               (targeted reads only)
 *
 * Listeners are launched synchronously and never awaited. A slow push/network
 * continuation therefore cannot delay the next SQLite tick or delegation wakeup.
 */
import type { SessionState } from './types.ts'

export type SessionPollListener = (states: SessionState[]) => void | Promise<void>

interface SessionPollerOptions {
	intervalMs?: number
	onError?: (message: string) => void
}

const DEFAULT_INTERVAL_MS = 2_000

export class SessionPoller {
	private readonly read: () => SessionState[]
	private readonly intervalMs: number
	private readonly onError: (message: string) => void
	private readonly listeners = new Set<SessionPollListener>()
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(read: () => SessionState[], options: SessionPollerOptions = {}) {
		this.read = read
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
		this.onError = options.onError ?? (message => console.warn(`[relay] ${message}`))
	}

	subscribe(listener: SessionPollListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** One tick, public so startup/tests can baseline without waiting for the timer. */
	tick(): void {
		let states: SessionState[]
		try {
			states = this.read()
		} catch (err) {
			this.onError(`session poll failed: ${err instanceof Error ? err.message : err}`)
			return
		}
		for (const listener of this.listeners) {
			try {
				const pending = listener(states)
				if (pending && typeof pending.then === 'function') {
					void pending.catch(err =>
						this.onError(`session poll listener failed: ${err instanceof Error ? err.message : err}`)
					)
				}
			} catch (err) {
				this.onError(`session poll listener failed: ${err instanceof Error ? err.message : err}`)
			}
		}
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.intervalMs)
		this.timer.unref()
	}

	stop(): void {
		if (!this.timer) return
		clearInterval(this.timer)
		this.timer = null
	}
}
