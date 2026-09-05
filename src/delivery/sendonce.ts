/**
 * One prompt per intent, however many requests carry it.
 *
 * `deliverPrompt` already makes a send safe to repeat *within* a request: it
 * snapshots the transcript cursor, runs, and watches for the matching user row, so
 * a run that landed late is reported as delivered rather than typed again. What that
 * cannot see is a copy landed by a **different request**, because the snapshot is
 * taken when the request starts and the earlier copy is behind it.
 *
 * Which is the duplicate the chats here actually hold. The failure is not the relay
 * fumbling a send, it is the *answer* going missing: the funnel ingress goes stale on
 * a network change (a documented failure on this setup), or the phone is suspended,
 * or the 75s client budget runs out while the relay is still inside its own 55s one.
 * The prompt is in Conductor, the phone never hears so, the bubble flips to failed,
 * and Retry is right there. Two rows, seconds apart, and nothing in relay.log —
 * every retry the relay *did* log landed exactly once, which is how the two were told
 * apart.
 *
 * So the phone names the intent instead. `PendingMessage.id` already exists and the
 * Retry button already reuses it (a fresh send makes a fresh one), so it is a UUID
 * per thing-the-user-meant-to-say, and that is the key here. Deliberately saying
 * "yes" twice is two ids and still two prompts; tapping Retry on one failed bubble is
 * one id and stays one prompt. Nothing is matched on text, which is what keeps this
 * from swallowing a repeat someone meant.
 *
 * Three properties:
 *
 * - **A failure is never remembered.** Retry after a send that really didn't land
 *   must run again. Memoising failures would turn one bad minute into a Retry button
 *   that does nothing for as long as the entry lives, which is worse than the
 *   duplicate this exists to stop. `keep` decides, and it is given the outcome.
 * - **In flight counts as delivered-in-progress.** The phone gives up at 75s and the
 *   relay's own budget is 55s, so a Retry can arrive while the first run is still
 *   holding `uiTurn`. A second run would then queue behind the first and type the
 *   same prompt again the moment it finished. Joining the first is both the correct
 *   answer and the faster one.
 * - **No key, no memo.** An MCP caller or an older cached PWA sends none, and gets
 *   exactly today's behaviour rather than a guess about what it meant.
 */

interface Settled<T> {
	at: number
	value: T
}

/**
 * How long a delivered outcome stays worth answering with. It only has to outlast
 * the gap between a lost answer and the tap that follows it — the phone's 75s budget,
 * then however long it takes someone to look at their screen. Generous is free here:
 * the key is a UUID, so an entry can never match an intent it didn't come from, and
 * the only cost of keeping one is the row in the map.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000

/**
 * Runs keyed work at most once per key: concurrent callers share one run, and a
 * kept outcome answers later ones without running at all.
 */
export class SendOnce<T> {
	private readonly inFlight = new Map<string, Promise<T>>()
	private readonly settled = new Map<string, Settled<T>>()
	private readonly ttlMs: number
	private readonly keep: (value: T) => boolean

	constructor(opts: { keep: (value: T) => boolean; ttlMs?: number }) {
		this.keep = opts.keep
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
	}

	/**
	 * `key` undefined runs `fn` plainly — see "No key, no memo" above. Otherwise the
	 * first caller runs it, callers arriving while it runs await that same run, and
	 * callers arriving after a *kept* outcome get it back without running.
	 */
	async run(key: string | undefined, fn: () => Promise<T>): Promise<T> {
		if (!key) return fn()
		const remembered = this.recall(key)
		if (remembered) return remembered.value
		const running = this.inFlight.get(key)
		if (running) return running
		// Wrapped rather than called bare, so a synchronous throw leaves no entry behind
		// and reaches the caller as a rejection like every other failure.
		const started = (async () => fn())()
		this.inFlight.set(key, started)
		try {
			const value = await started
			if (this.keep(value)) {
				this.prune()
				this.settled.set(key, { at: Date.now(), value })
			}
			return value
		} finally {
			this.inFlight.delete(key)
		}
	}

	/** Whether this key already has an outcome worth answering with — the test's window in. */
	recall(key: string): Settled<T> | null {
		const found = this.settled.get(key)
		if (!found) return null
		if (Date.now() - found.at > this.ttlMs) {
			this.settled.delete(key)
			return null
		}
		return found
	}

	/** Entries expire on their own; this is what stops the map outliving them. */
	private prune(): void {
		const cutoff = Date.now() - this.ttlMs
		for (const [key, entry] of this.settled) if (entry.at <= cutoff) this.settled.delete(key)
	}
}
