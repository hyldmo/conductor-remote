import { Worker } from 'node:worker_threads'
import { chatCursor } from './chat-cursor.ts'

/**
 * Full-text search over the chat history, in a sidecar DB the relay owns.
 *
 * Two facts decide the whole shape of this file.
 *
 * **Prose is a few percent of the transcript.** Measured over this Mac's 1.7M
 * `session_messages` rows (3,106 MB of `content`): tool_result output is 799 MB,
 * `type:"system"` frames 522 MB, tool_use arguments 162 MB — and what a person
 * would ever search for is prose. So this indexes prose only. A grep of the raw
 * column would be a 3 GB scan, and it would rank a file dump the agent happened
 * to `cat` above the sentence that explained the decision.
 *
 * **Thinking counts as prose, and it is the bigger half.** Re-measured 2026-08-25:
 * assistant text is 36.9 MB over 93,189 blocks, typed prompts 2.6 MB over 19,432
 * rows, and thinking **82.7 MB over 102,776 blocks** — more than the other two
 * together. Skipping it was the original cut and it was wrong: the chat view
 * *renders* thinking, so a hit there opens to something you can read, and the
 * reasoning is where a decision gets explained before the reply summarises it.
 * Note the shape trap behind the worker's source query: **every thinking block sits
 * in a row with no text block beside it** (0 of 102,773 rows carry both), so a
 * prefilter written for `"type":"text"` excludes 100% of thinking rather than
 * some of it — the bug that made this cut invisible.
 *
 * The cost is paid up front and it is bounded. Same machine, same history, five
 * real queries at `CHUNK_LIMIT`: 112,571 chunks → **208,131**, 77 MB → 230 MB,
 * 7.6s → **12.3s** to build, and 12–57ms → **25–137ms** per query. The worst case
 * still fits inside the phone's 250ms search-as-you-type debounce, which is the
 * only latency budget that binds here. (The 1–7ms this comment used to claim was
 * measured on a smaller history and no longer held even before thinking: v1
 * measures 12–57ms today.)
 *
 * **`node:sqlite` ships FTS5.** Porter stemming, `bm25()`, `snippet()`, `NEAR()`
 * all work on the bundled SQLite (3.51.2), so the index costs no runtime
 * dependency — which the tarball rule requires (see CLAUDE.md ▸ Traps).
 *
 * The index is **never** written into `conductor.db`. That handle is read-only and
 * stays that way; this opens its own file under the relay's state dir, and it is
 * disposable — delete it and the next start rebuilds it.
 */

/** How many chunks a query ranks before they are folded into workspaces. */
const CHUNK_LIMIT = 300

/**
 * Snippet highlight markers, from `src/shared.ts` because the phone splits on the
 * same two characters (`web/src/lib/format.ts` ▸ `splitSnippet`). Control characters
 * rather than brackets: they survive JSON, they need no escaping on the way to the
 * phone, and no transcript contains them, so the client needs no parser. The client
 * must not render them literally.
 */
export { HIT_CLOSE, HIT_OPEN } from './shared.ts'

/**
 * Which kind of prose matched. `thinking` is separate from `assistant` on purpose:
 * a hit there is reasoning the agent never said out loud, and labelling it as the
 * agent's answer would misread it. The three are exactly `TranscriptEntry['role']`
 * minus the parts this index skips (`tool`, `system`).
 */
export type SearchRole = 'user' | 'assistant' | 'thinking'

export interface SearchHit {
	sessionId: string
	/** `session_messages.rowid` this text came from — the transcript's own cursor. */
	srcRowid: number
	role: SearchRole
	at: string
	/** Higher is better. BM25 negated, so callers can sum and sort descending. */
	score: number
	/** Matching excerpt, with hits wrapped in HIT_OPEN/HIT_CLOSE. */
	snippet: string
}

export interface IndexStatus {
	/** Chunks indexed so far. */
	chunks: number
	/** True once the backfill has reached the newest message. */
	ready: boolean
	/** 0–1 through the source rows; 1 when caught up. */
	progress: number
	/** Present when the sidecar DB could not be opened at all. */
	error?: string
}

/**
 * Turn a phone query into an FTS5 MATCH expression.
 *
 * Every token is quoted, because FTS5 reads `-`, `*`, `:`, `(`, `AND`, `NEAR` and
 * friends as syntax: an unquoted apostrophe or hyphen is a *parse error*, not a
 * poor result, so a raw query would fail rather than under-match. Tokens are OR'd
 * because someone reaching for a workspace on a phone is recalling it, not
 * filtering it — BM25 is what puts the message matching four of four words above
 * the one matching one, and requiring all four would return nothing whenever a
 * single word is misremembered.
 *
 * OR alone loses the query made of common words, and nothing about sentence
 * boundaries is why — a chunk is a whole prose block. Measured 2026-09-01 against
 * this Mac's 225k-chunk index: "may i run the", a sentence one chat verifiably
 * contains, ranked nowhere in the top 300 chunks, because OR rewards density
 * ("Running the headless artifact render… first run may…") and nothing rewards
 * adjacency. So each run of unquoted words also enters as one FTS5 phrase term
 * OR'd beside its tokens: the phrase is rare where the words are common, its BM25
 * weight is correspondingly large, and the same query then puts the exact sentence
 * first (95ms against 206ms for bare OR, both inside the 250ms debounce). A phrase
 * the index doesn't contain matches nothing and costs nothing.
 *
 * Quotes filter. `"exactly this"` becomes a *required* phrase (AND), because a
 * typed quote is the one signal that the user is filtering rather than recalling;
 * words outside the quotes stay OR'd. Curly `“”` count as quotes — iOS smart
 * punctuation substitutes them for the straight one the user pressed, so the phone
 * mostly never sends `"`. Stemming still applies inside quotes (`"running"` finds
 * "runs"): quoting changes which chunks qualify, not how they were tokenized.
 *
 * The last token gets a prefix `*` so search-as-you-type matches mid-word, but only
 * from three characters: `"a"*` matches a large fraction of the index and would
 * spend the whole query budget on a keystroke that means nothing yet. Inside an
 * unclosed quote the star rides on the phrase itself (`"may i ru"*` — valid FTS5,
 * the last token matches as a prefix), so a phrase still being typed already
 * matches what it is about to say.
 */
export function matchQuery(raw: string): string | null {
	// Split on quote characters: segments alternate unquoted/quoted, and a trailing
	// unclosed quote leaves the last segment quoted — the phrase still being typed.
	const segments = raw.toLowerCase().split(/["“”]/)
	const typing = !/[\s"“”]$/.test(raw)
	const required: string[] = []
	const loose: string[] = []
	for (let i = 0; i < segments.length; i++) {
		const tokens = segments[i].match(/[\p{L}\p{N}_]+/gu)
		if (!tokens?.length) continue
		const star = i === segments.length - 1 && typing && tokens[tokens.length - 1].length >= 3 ? '*' : ''
		const phrase = `"${tokens.join(' ')}"${star}`
		if (i % 2) {
			required.push(phrase)
		} else {
			if (tokens.length > 1) loose.push(phrase)
			loose.push(...tokens.slice(0, -1).map(t => `"${t}"`), `"${tokens[tokens.length - 1]}"${star}`)
		}
	}
	if (!loose.length) return required.length ? required.join(' AND ') : null
	// The OR group is parenthesised because FTS5 binds AND tighter than OR.
	const looseExpr = loose.length > 1 ? `(${loose.join(' OR ')})` : loose[0]
	return required.length ? `${required.join(' AND ')} AND ${looseExpr}` : looseExpr
}

/** The tokens `matchQuery` will search for — what a caller matches names against. */
export { queryTokens } from './shared.ts'

export interface SearchOptions {
	limit?: number
	sessionIds?: string[]
}

interface SearchRequest {
	id: number
	type: 'search'
	raw: string
	options: SearchOptions
}

export type SearchWorkerRequest = SearchRequest

export type SearchWorkerMessage =
	| { type: 'status'; status: IndexStatus }
	| { type: 'log'; level: 'log' | 'warn'; message: string }
	| { type: 'result'; id: number; hits: SearchHit[] }
	| { type: 'error'; id: number; error: string }

interface PendingSearch {
	resolve: (hits: SearchHit[]) => void
	reject: (error: Error) => void
}

/**
 * Main-thread facade for the disposable full-text index.
 *
 * `node:sqlite` is synchronous. Keeping its connection here meant a contended
 * sidecar write, a backfill batch, or an expensive FTS rank stopped every HTTP
 * route even though Conductor's AppleScript process itself is asynchronous. The
 * worker owns both SQLite handles now; only small structured-clone messages cross
 * back to the server thread.
 */
export class SearchIndex {
	private readonly sourceDbPath: string
	private readonly file: string
	private worker: Worker | null = null
	private indexStatus: IndexStatus = { chunks: 0, ready: false, progress: 0 }
	private nextId = 1
	private readonly pending = new Map<number, PendingSearch>()
	private stopping = false

	constructor(sourceDbPath: string, file: string) {
		this.sourceDbPath = sourceDbPath
		this.file = file
	}

	/** Spawn the index worker. Search remains a convenience: startup failure is non-fatal. */
	start(): void {
		if (this.worker) return
		this.stopping = false
		this.indexStatus = { chunks: 0, ready: false, progress: 0 }
		const module = import.meta.url.endsWith('.ts') ? './search-worker.ts' : './search-worker.js'
		try {
			const worker = new Worker(new URL(module, import.meta.url), {
				workerData: { sourceDbPath: this.sourceDbPath, file: this.file },
				// The CLI suppresses node:sqlite's still-experimental warning in the main
				// isolate; warning state does not cross into a worker.
				execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning']
			})
			this.worker = worker
			worker.on('message', message => this.onMessage(message as SearchWorkerMessage))
			worker.on('error', error => {
				if (this.worker === worker) this.workerFailed(error.message)
			})
			worker.on('exit', code => {
				if (this.worker !== worker) return
				this.worker = null
				if (!this.stopping && !this.indexStatus.error) this.workerFailed(`worker exited with code ${code}`)
			})
		} catch (err) {
			this.workerFailed(err instanceof Error ? err.message : String(err))
		}
	}

	async stop(): Promise<void> {
		this.stopping = true
		const worker = this.worker
		this.worker = null
		this.rejectPending('search index stopped')
		if (worker) await worker.terminate()
	}

	status(): IndexStatus {
		return { ...this.indexStatus }
	}

	/**
	 * Top matching chunks, best first. The SQLite work happens entirely in the
	 * worker, so awaiting a slow rank does not stop unrelated API requests.
	 */
	search(raw: string, options: SearchOptions = {}): Promise<SearchHit[]> {
		if (!matchQuery(raw) || (options.sessionIds && !options.sessionIds.length)) return Promise.resolve([])
		const worker = this.worker
		if (!worker || this.indexStatus.error) return Promise.resolve([])

		const id = this.nextId++
		return new Promise<SearchHit[]>((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			try {
				worker.postMessage({
					id,
					type: 'search',
					raw,
					options: { limit: CHUNK_LIMIT, ...options }
				} satisfies SearchRequest)
			} catch (error) {
				this.pending.delete(id)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		})
	}

	private onMessage(message: SearchWorkerMessage): void {
		if (message.type === 'status') {
			this.indexStatus = message.status
			return
		}
		if (message.type === 'log') {
			console[message.level](message.message)
			return
		}

		const pending = this.pending.get(message.id)
		if (!pending) return
		this.pending.delete(message.id)
		if (message.type === 'result') pending.resolve(message.hits)
		else pending.reject(new Error(message.error))
	}

	private workerFailed(error: string): void {
		if (this.indexStatus.error === error) return
		this.indexStatus = { chunks: 0, ready: false, progress: 0, error }
		this.rejectPending(error)
		console.warn(`⚠ search index unavailable (${error}) — /api/search will report it`)
	}

	private rejectPending(message: string): void {
		for (const pending of this.pending.values()) pending.reject(new Error(message))
		this.pending.clear()
	}
}

/** One matching excerpt, as the phone renders it. */
export interface SearchSnippet {
	sessionId: string
	/** Opaque source-message pointer for a bounded `read_chat` around this hit. */
	cursor: string
	role: SearchRole
	at: string
	/** Hits wrapped in HIT_OPEN/HIT_CLOSE. */
	text: string
}

/** A workspace a search matched, with the evidence. */
export interface SearchResult<W> {
	workspace: W
	/** The chat holding this workspace's strongest passage — where a tap should land. */
	sessionId: string | null
	/** Number of matching messages, all of them. */
	hits: number
	/** Higher is better. The summed score of the snippets below, and only those. */
	score: number
	/** Most recent matching message. */
	at: string | null
	snippets: SearchSnippet[]
	/** True when the workspace's own name/branch matched, rather than (only) its chats. */
	byName: boolean
}

const SNIPPETS_PER_RESULT = 3

/**
 * Fold chunk hits up into workspaces.
 *
 * Chunk-level results are the wrong unit here: one long conversation produces a
 * dozen and buries every other workspace. What to do with those dozen is the whole
 * ranking decision, and it was measured rather than guessed — searching this Mac's
 * history for "removing adding lamp manual", where the right answer is a chat that
 * says "Add by name is gone. Removed the form":
 *
 *   summing every hit   → right answer ranks 9th
 *   best single hit     → 5th
 *   sum of the top 3    → 5th, and steadier across other queries
 *
 * Summing everything ranks by *volume*: a 32-message conversation about lamps beat
 * the four messages that actually removed the feature. So only the best
 * `SNIPPETS_PER_RESULT` hits score, which caps what repetition can buy and makes
 * the number mean something the user can check — the score is exactly the strength
 * of the snippets shown under the row. `hits` still counts them all.
 *
 * Hits whose session no longer resolves to a workspace are dropped; a result nobody
 * can open is worse than one fewer result.
 */
export function foldHits<W extends { id: string }>(
	hits: SearchHit[],
	resolve: (sessionId: string) => W | null
): SearchResult<W>[] {
	const byWorkspace = new Map<string, SearchResult<W> & { bestBySession: Map<string, number> }>()
	for (const hit of hits) {
		const workspace = resolve(hit.sessionId)
		if (!workspace) continue
		let entry = byWorkspace.get(workspace.id)
		if (!entry) {
			entry = {
				workspace,
				sessionId: null,
				hits: 0,
				score: 0,
				at: null,
				snippets: [],
				byName: false,
				bestBySession: new Map()
			}
			byWorkspace.set(workspace.id, entry)
		}
		entry.hits++
		if (!entry.at || hit.at > entry.at) entry.at = hit.at
		entry.bestBySession.set(hit.sessionId, Math.max(entry.bestBySession.get(hit.sessionId) ?? 0, hit.score))
		// `hits` arrives in BM25 order, so the first few of a workspace are its best few:
		// scoring and snippeting the same slice needs no second sort.
		if (entry.snippets.length < SNIPPETS_PER_RESULT) {
			entry.score += hit.score
			entry.snippets.push({
				sessionId: hit.sessionId,
				cursor: chatCursor(hit.srcRowid),
				role: hit.role,
				at: hit.at,
				text: hit.snippet
			})
		}
	}
	const results: SearchResult<W>[] = []
	for (const entry of byWorkspace.values()) {
		const { bestBySession, ...rest } = entry
		let sessionId: string | null = null
		let best = -Infinity
		for (const [id, score] of bestBySession) {
			if (score <= best) continue
			best = score
			sessionId = id
		}
		results.push({ ...rest, sessionId })
	}
	return results.sort((a, b) => b.score - a.score)
}
