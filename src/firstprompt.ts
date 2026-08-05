/**
 * The first prompt of a workspace created from the phone, delivered by the relay
 * once Conductor has finished setting the worktree up.
 *
 * Conductor's deep link creates the workspace and *pre-fills* its composer, but
 * never presses Enter — so something has to, ~30s later, when the worktree turns
 * `ready` and the chat exists. That "something" used to be the PWA, which is the
 * worst possible scheduler for it: the phone sleeps, iOS suspends a backgrounded
 * PWA outright, and it may not be on the network at all. Meanwhile the relay is a
 * daemon on the same Mac as the target, already holding the DB and the actuator.
 * So the relay owns delivery and the phone only *watches* it (`/api/state`
 * carries the pending prompt, `DELETE …/prompt` dismisses one).
 *
 * Three properties this has to keep:
 *
 * - **One owner.** If the phone delivered too, `last_user_message_at` wouldn't
 *   save us — it's a read, not a lock, and both sides can read it null. The PWA
 *   no longer parks anything.
 * - **It survives a restart.** `autoupdate` deliberately `exit()`s to reload new
 *   code, and launchd brings us straight back; a queue that only lived in memory
 *   would drop the prompt mid-setup, which is the same swallowed prompt in a new
 *   house. Hence the JSON file, rewritten on every change.
 * - **It gives up in public.** After `MAX_ATTEMPTS` sends or `MAX_AGE_MS` of a
 *   workspace that never turns ready, the entry flips to `failed` *and stays*, so
 *   the phone can show the text with the reason next to it. Nothing is silently
 *   dropped — and the text is still sitting pre-filled in Conductor's composer on
 *   the Mac regardless.
 */
import fs from 'node:fs'
import path from 'node:path'

export type FirstPromptStatus = 'waiting' | 'failed'

export interface FirstPrompt {
	workspaceId: string
	text: string
	status: FirstPromptStatus
	/** Sends already spent on it. */
	attempts: number
	createdAt: number
	/** Why it was given up on — shown on the phone beside the undelivered text. */
	error?: string
}

/** What the queue needs from the outside world; injected so this module stays testable and DB-free. */
export interface DeliveryDeps {
	/**
	 * The DB's current view of a target. `null` means no such workspace row *yet* —
	 * which is normal for a beat after creation, so it is not a reason to give up.
	 */
	inspect: (workspaceId: string) => { ready: boolean; sessionId: string | null; alreadySent: boolean } | null
	/** Drive the actual UI send, read-back included. */
	send: (workspaceId: string, sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>
}

/** How often the loop re-reads the DB while waiting for a worktree. */
const POLL_MS = 1000
/** Breathing room between failed sends — Conductor may be mid-launch or showing a dialog. */
const RETRY_DELAY_MS = 5000
const MAX_ATTEMPTS = 3
/** A workspace that hasn't turned ready in this long isn't going to. */
const MAX_AGE_MS = 15 * 60 * 1000
/** Failed entries the user never dismissed are still dropped eventually. */
const KEEP_FAILED_MS = 7 * 24 * 60 * 60 * 1000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class FirstPromptQueue {
	// Explicit field assignment, not parameter properties: the dev run type-*strips*
	// rather than transforms, and parameter properties need a transform (see CLAUDE.md).
	private readonly file: string
	private readonly deps: DeliveryDeps
	private entries: FirstPrompt[]
	private pumping = false
	/** Resolvers waiting on a specific entry to settle (`POST /api/workspaces` with `send:true`). */
	private waiters = new Map<string, ((settled: FirstPrompt | null) => void)[]>()

	constructor(file: string, deps: DeliveryDeps) {
		this.file = file
		this.deps = deps
		this.entries = this.load()
	}

	/** Everything the phone should see, including entries that have already failed. */
	list(): FirstPrompt[] {
		return this.entries
	}

	get(workspaceId: string): FirstPrompt | null {
		return this.entries.find(e => e.workspaceId === workspaceId) ?? null
	}

	/**
	 * Park a prompt and start delivering it. The returned promise settles when the
	 * prompt lands (`null`) or is given up on (the failed entry) — awaited by API
	 * callers that asked to block, ignored by the phone.
	 */
	enqueue(workspaceId: string, text: string): Promise<FirstPrompt | null> {
		this.entries = [
			...this.entries.filter(e => e.workspaceId !== workspaceId),
			{ workspaceId, text, status: 'waiting', attempts: 0, createdAt: Date.now() }
		]
		this.save()
		const settled = new Promise<FirstPrompt | null>(resolve => {
			const list = this.waiters.get(workspaceId) ?? []
			list.push(resolve)
			this.waiters.set(workspaceId, list)
		})
		void this.pump()
		return settled
	}

	/** Drop an entry — dismissed from the phone, or superseded by a send the user made themselves. */
	forget(workspaceId: string): boolean {
		if (!this.entries.some(e => e.workspaceId === workspaceId)) return false
		this.entries = this.entries.filter(e => e.workspaceId !== workspaceId)
		this.save()
		this.settle(workspaceId, null)
		return true
	}

	/** Resume delivery of anything left over from a previous process. */
	start(): void {
		const waiting = this.entries.filter(e => e.status === 'waiting').length
		if (waiting) console.info(`[relay] resuming ${waiting} undelivered first prompt(s)`)
		void this.pump()
	}

	/**
	 * The delivery loop. One pass per second over everything still waiting; exits
	 * when nothing is (and `enqueue`/`start` re-enter it). Single-flight, so the
	 * loop can't be stacked by a burst of creations.
	 */
	private async pump(): Promise<void> {
		if (this.pumping) return
		this.pumping = true
		try {
			while (this.entries.some(e => e.status === 'waiting')) {
				for (const entry of this.entries.filter(e => e.status === 'waiting')) await this.step(entry)
				if (this.entries.some(e => e.status === 'waiting')) await sleep(POLL_MS)
			}
		} catch (err) {
			// A throw here would strand every waiting prompt with no loop to retry it.
			console.error('[relay] first-prompt delivery loop crashed:', err)
		} finally {
			this.pumping = false
		}
	}

	private async step(entry: FirstPrompt): Promise<void> {
		if (Date.now() - entry.createdAt > MAX_AGE_MS) {
			return this.fail(entry, 'the workspace never finished setting up')
		}
		const target = this.deps.inspect(entry.workspaceId)
		// No row yet is normal right after creation, and a workspace that really is
		// gone falls out through the age cap above rather than being guessed at here.
		if (!target?.ready || !target.sessionId) return
		// It already went — the user sent it from the Mac, where the deep link left it
		// pre-filled in the composer. Sending again would double it.
		if (target.alreadySent) return this.delivered(entry)

		entry.attempts += 1
		this.save()
		const result = await this.deps.send(entry.workspaceId, target.sessionId, entry.text)
		if (result.ok) return this.delivered(entry)
		const error = result.error ?? 'the send didn’t land'
		console.warn(`[relay] first prompt for ${entry.workspaceId} failed (attempt ${entry.attempts}): ${error}`)
		if (entry.attempts >= MAX_ATTEMPTS) return this.fail(entry, error)
		await sleep(RETRY_DELAY_MS)
	}

	/** Delivered: the entry's job is done, so it stops existing. */
	private delivered(entry: FirstPrompt): void {
		this.entries = this.entries.filter(e => e !== entry)
		this.save()
		this.settle(entry.workspaceId, null)
	}

	/** Given up on: kept, so the phone can show the text and the reason. */
	private fail(entry: FirstPrompt, error: string): void {
		entry.status = 'failed'
		entry.error = error
		this.save()
		this.settle(entry.workspaceId, entry)
	}

	private settle(workspaceId: string, result: FirstPrompt | null): void {
		const list = this.waiters.get(workspaceId)
		if (!list) return
		this.waiters.delete(workspaceId)
		for (const resolve of list) resolve(result)
	}

	private load(): FirstPrompt[] {
		let raw: string
		try {
			raw = fs.readFileSync(this.file, 'utf8')
		} catch {
			return [] // nothing parked yet — the common case
		}
		try {
			const parsed = JSON.parse(raw) as FirstPrompt[]
			if (!Array.isArray(parsed)) return []
			return parsed.filter(
				e =>
					typeof e?.workspaceId === 'string' &&
					typeof e.text === 'string' &&
					Date.now() - (e.createdAt ?? 0) < KEEP_FAILED_MS
			)
		} catch (err) {
			console.warn(`[relay] ignoring unreadable ${this.file}: ${err instanceof Error ? err.message : err}`)
			return []
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true })
			fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2))
		} catch (err) {
			// Delivery still works this run; only the restart guarantee is lost.
			console.warn(`[relay] could not persist pending prompts: ${err instanceof Error ? err.message : err}`)
		}
	}
}
