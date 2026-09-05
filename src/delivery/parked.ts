/**
 * Prompts parked because the Mac's screen is locked, delivered by the relay the
 * moment it unlocks.
 *
 * The lock screen hides the whole session's UI from Accessibility, so while it is
 * up no AppleScript write can land — and the phone's own retry budget (~a minute)
 * is the wrong tool for a wait that routinely lasts hours. So a send that hits
 * the lock hands its prompt to this queue and returns at once: the phone shows it
 * as a queued bubble in the chat (`workspace.parked_prompts` on `/api/state`),
 * the relay polls the lock and delivers when it lifts, and a push notification
 * says whether it landed. Same ownership story as `src/delivery/firstprompt.ts`: the relay is
 * the only deliverer, the phone only watches and can dismiss.
 *
 * The same three properties hold it up:
 *
 * - **One owner.** The phone never re-sends a parked prompt on its own; a manual
 *   send of the same text clears the entry server-side (`forgetDelivered`), so
 *   the two paths can't double it.
 * - **It survives a restart.** `autoupdate` exits to reload new code mid-wait as
 *   a matter of course; the JSON file brings the queue back with the process.
 * - **It gives up in public.** Time spent locked is free — a weekend away is not
 *   a failure — but once the Mac is unlocked, `MAX_ATTEMPTS` real delivery
 *   failures flip the entry to `failed` *and it stays*, text and reason visible
 *   on the phone, one Retry from going again.
 */
import fs from 'node:fs'
import path from 'node:path'

export type ParkedStatus = 'waiting' | 'failed'

/** Staged agent settings riding with the prompt (mirrors the phone's `AgentPatch`). */
export interface ParkedAgentPatch {
	/** Draft preference; consumed by Auto intake, never passed to a UI write. */
	auto?: boolean
	effort?: string
	plan?: boolean
	fast?: boolean
	model?: string
}

export interface ParkedPrompt {
	autoModel?: true
	workspaceId: string
	sessionId: string
	text: string
	/** Applied before the prompt on delivery, exactly as the phone would have. */
	agent?: ParkedAgentPatch
	/** Queue behind the current turn when the Mac unlocks. */
	queue?: boolean
	status: ParkedStatus
	/** Real delivery failures with the Mac unlocked — lock re-checks don't count. */
	attempts: number
	createdAt: number
	/** What the entry is waiting for, in the words the chat shows under the bubble. */
	reason: string
	/** Why it was given up on — shown beside the undelivered text. */
	error?: string
}

/** What the queue needs from the outside world; injected so this module stays testable and Mac-free. */
export interface ParkedDeps {
	/** The lock probe. `null` = unknown — attempt anyway and let the send itself answer. */
	locked: () => Promise<boolean | null>
	/**
	 * Drive the real delivery (agent settings first when the entry carries them,
	 * then the prompt). `blocked` = the lock got in the way again — wait, don't count.
	 */
	deliver: (entry: ParkedPrompt) => Promise<{ ok: boolean; error?: string; blocked?: boolean }>
	/** Tell the phone how it ended — a push, since the whole point is nobody is watching. */
	notify: (entry: ParkedPrompt, error?: string) => void
}

/** Lock-probe cadence while anything waits. One tiny osascript per tick, nothing UI. */
const POLL_MS = 5000
/** Breathing room between failed unlocked sends — Conductor is often still redrawing right after login. */
const RETRY_DELAY_MS = 5000
const MAX_ATTEMPTS = 3
/** Failed entries the user never dismissed are still dropped eventually. */
const KEEP_FAILED_MS = 7 * 24 * 60 * 60 * 1000

export const PARKED_REASON = 'Sends when the Mac is unlocked'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class ParkedPromptQueue {
	// Explicit field assignment, not parameter properties: the dev run type-*strips*
	// rather than transforms, and parameter properties need a transform (see CLAUDE.md).
	private readonly file: string
	private readonly deps: ParkedDeps
	private entries: ParkedPrompt[]
	private pumping = false

	constructor(file: string, deps: ParkedDeps) {
		this.file = file
		this.deps = deps
		this.entries = this.load()
	}

	/** Everything the phone should see, including entries that have already failed. */
	list(): ParkedPrompt[] {
		return this.entries
	}

	/**
	 * Park a prompt (idempotent per chat + text, so a retap while locked revives
	 * the entry instead of doubling it) and start watching for the unlock.
	 */
	park(workspaceId: string, sessionId: string, text: string, agent?: ParkedAgentPatch, queue = false): ParkedPrompt {
		const existing = this.entries.find(e => e.sessionId === sessionId && e.text.trim() === text.trim())
		if (existing) {
			// A re-park is the user asking again: back to waiting with a clean slate.
			existing.status = 'waiting'
			existing.attempts = 0
			existing.error = undefined
			existing.agent = agent ?? existing.agent
			existing.queue = queue
			this.save()
			void this.pump()
			return existing
		}
		const entry: ParkedPrompt = {
			workspaceId,
			sessionId,
			text,
			agent,
			queue,
			status: 'waiting',
			attempts: 0,
			createdAt: Date.now(),
			reason: PARKED_REASON
		}
		this.entries = [...this.entries, entry]
		this.save()
		void this.pump()
		return entry
	}

	/** Drop everything parked for a chat — the phone's Dismiss. */
	forgetSession(sessionId: string): boolean {
		if (!this.entries.some(e => e.sessionId === sessionId)) return false
		this.entries = this.entries.filter(e => e.sessionId !== sessionId)
		this.save()
		return true
	}

	/**
	 * A send of this exact text just landed by another path (the phone retried it
	 * by hand once the Mac was unlocked) — delivering it again would double it.
	 */
	forgetDelivered(sessionId: string, text: string): void {
		const before = this.entries.length
		this.entries = this.entries.filter(e => !(e.sessionId === sessionId && e.text.trim() === text.trim()))
		if (this.entries.length !== before) this.save()
	}

	/** Resume watching anything left over from a previous process. */
	start(): void {
		const waiting = this.entries.filter(e => e.status === 'waiting').length
		if (waiting) console.info(`[relay] resuming ${waiting} prompt(s) parked for the lock screen`)
		void this.pump()
	}

	/**
	 * The watch loop. While anything waits: probe the lock; locked → sleep and
	 * probe again (locked time costs nothing); unlocked or unknown → deliver in
	 * FIFO order, so two prompts parked into one chat arrive as sent. Single-flight,
	 * so a burst of parks can't stack loops.
	 */
	private async pump(): Promise<void> {
		if (this.pumping) return
		this.pumping = true
		try {
			while (this.entries.some(e => e.status === 'waiting')) {
				if ((await this.deps.locked()) === true) {
					await sleep(POLL_MS)
					continue
				}
				for (const entry of this.entries.filter(e => e.status === 'waiting')) await this.step(entry)
				if (this.entries.some(e => e.status === 'waiting')) await sleep(POLL_MS)
			}
		} catch (err) {
			// A throw here would strand every parked prompt with no loop to retry it.
			console.error('[relay] parked-prompt delivery loop crashed:', err)
		} finally {
			this.pumping = false
		}
	}

	private async step(entry: ParkedPrompt): Promise<void> {
		const result = await this.deps.deliver(entry)
		if (result.ok) return this.delivered(entry)
		// The lock got there first (re-locked between the probe and the send, or the
		// probe couldn't answer): that is the gate closing, not a delivery failure.
		if (result.blocked) return
		entry.attempts += 1
		this.save()
		const error = result.error ?? 'the send didn’t land'
		console.warn(`[relay] parked prompt for ${entry.sessionId} failed (attempt ${entry.attempts}): ${error}`)
		if (entry.attempts >= MAX_ATTEMPTS) return this.fail(entry, error)
		await sleep(RETRY_DELAY_MS)
	}

	/** Delivered: the entry's job is done, so it stops existing — the push is the receipt. */
	private delivered(entry: ParkedPrompt): void {
		this.entries = this.entries.filter(e => e !== entry)
		this.save()
		this.deps.notify(entry)
	}

	/** Given up on: kept, so the phone can show the text and the reason. */
	private fail(entry: ParkedPrompt, error: string): void {
		entry.status = 'failed'
		entry.error = error
		this.save()
		this.deps.notify(entry, error)
	}

	private load(): ParkedPrompt[] {
		let raw: string
		try {
			raw = fs.readFileSync(this.file, 'utf8')
		} catch {
			return [] // nothing parked — the common case
		}
		try {
			const parsed = JSON.parse(raw) as ParkedPrompt[]
			if (!Array.isArray(parsed)) return []
			return parsed.filter(
				e =>
					typeof e?.workspaceId === 'string' &&
					typeof e.sessionId === 'string' &&
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
			console.warn(`[relay] could not persist parked prompts: ${err instanceof Error ? err.message : err}`)
		}
	}
}
