/**
 * The first prompt of a workspace created from the phone or by an agent, delivered
 * by the relay rather than by whoever asked for the workspace.
 *
 * Conductor's deep link creates the workspace and *pre-fills* its composer, but
 * never presses Enter — so something has to, once the chat exists. That "something"
 * used to be the PWA, which is the
 * worst possible scheduler for it: the phone sleeps, iOS suspends a backgrounded
 * PWA outright, and it may not be on the network at all. Meanwhile the relay is a
 * daemon on the same Mac as the target, already holding the DB and the actuator.
 * So the relay owns delivery and the phone only *watches* it (`/api/state`
 * carries the pending prompt, `DELETE …/prompt` dismisses one).
 *
 * **Setting up is not a reason to wait, and that is what this file got wrong.**
 * Conductor draws the new workspace, its chat tab and its composer while the
 * worktree is still building, and its own New workspace box proves the backend
 * takes a first message that early: the row lands ~100ms after the workspace and
 * sits queued until the agent starts. The relay held the prompt until `state`
 * turned `ready` instead, which on a real repo is minutes — four workspaces
 * created in one burst on 2026-08-25 were delivered at +2m23s, +3m22s, +3m33s and
 * +3m33s — so an MCP caller that created a batch got four workspaces with nothing
 * sent and read it as a broken send. So the send is tried as soon as the chat row
 * exists, and `ready` is now only the point where a failure starts to *count*: an
 * early send that doesn't land spends no attempt, because "Conductor hasn't drawn
 * the pane yet" is a wait wearing a failure's clothes. `MAX_EARLY_ATTEMPTS` bounds
 * it, since every run holds `uiTurn` for tens of seconds and the phone is behind
 * the same lock.
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
import type { ParkedAgentPatch } from './parked.ts'

export type FirstPromptStatus = 'waiting' | 'failed'

/**
 * How far Conductor has got with the workspace. Only `ready` means the worktree is
 * built; `setting_up` covers every state before it, which is still worth sending
 * into (see the header) and still not worth judging a failure by.
 */
export type WorkspacePhase = 'setting_up' | 'ready'

export interface FirstPromptTarget {
	phase: WorkspacePhase
	sessionId: string | null
	alreadySent: boolean
	/** Null until the new workspace has a safe location for its staged files. */
	worktree?: string | null
}

export interface FirstPrompt {
	workspaceId: string
	text: string
	/** Agent choices selected while the workspace was being created. */
	agent?: ParkedAgentPatch
	/** Legacy persisted model choice, migrated into `agent` when delivery resumes. */
	model?: string
	/** Files staged before this workspace had a worktree. They must land before `text` is sent. */
	attachmentIds?: string[]
	/** Role assigned to the first chat before its settings or prompt are delivered. */
	sessionRole?: string
	/** Persisted receipt so a relay restart does not rewrite the role registry unnecessarily. */
	sessionRoleAssigned?: boolean
	status: FirstPromptStatus
	/** Sends already spent on it *after* the worktree turned ready — the budget that counts. */
	attempts: number
	/** Sends tried before that, bounded separately and never fatal. */
	earlyAttempts?: number
	/**
	 * Try the send before the worktree is built, which is what makes a prompt land in
	 * seconds instead of minutes (see the header). Default on; `false` restores the
	 * old wait for a repo whose setup script the agent's first move depends on, and
	 * an entry written before this existed has no field and gets the default.
	 */
	sendImmediately?: boolean
	/** When the last send finished, so the next is spaced without sleeping the loop (see `step`). */
	lastAttemptAt?: number
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
	inspect: (workspaceId: string) => FirstPromptTarget | null
	/**
	 * Drive the actual UI send, read-back included. `blocked` = the send was shut
	 * out by something delivery can't fix and waiting can (the lock screen) — the
	 * attempt doesn't count and the queue just keeps waiting.
	 */
	send: (
		workspaceId: string,
		sessionId: string,
		text: string
	) => Promise<{ ok: boolean; error?: string; blocked?: boolean }>
	/** Apply selected agent settings before the first prompt enters the chat. */
	setAgent?: (
		workspaceId: string,
		sessionId: string,
		agent: ParkedAgentPatch
	) => Promise<{ ok: boolean; error?: string; blocked?: boolean }>
	/** Put staged phone files into their new worktree before the attachment token is sent. */
	materialize?: (
		workspaceId: string,
		worktree: string,
		attachmentIds: string[]
	) => Promise<{ ok: boolean; error?: string }>
	/** Persist workflow-root identity before the first prompt makes the chat visible as active work. */
	assignRole?: (
		workspaceId: string,
		sessionId: string,
		role: string,
		assignedAt: number
	) => Promise<{ ok: boolean; error?: string }>
	/** Remove files that belonged to a prompt the user dismissed before it was sent. */
	discard?: (attachmentIds: string[]) => void | Promise<void>
	/**
	 * Is a send even worth starting? `false` = hold everything, spend nothing —
	 * neither attempts nor the age budget. The server wires this to the lock-screen
	 * probe: a Mac locked for a weekend used to burn all three attempts in its
	 * first minute and greet the unlock with a `failed` entry.
	 */
	gate?: () => Promise<boolean>
}

/** How often the loop re-reads the DB while waiting for a worktree. */
const POLL_MS = 1000
/** Breathing room between failed sends — Conductor may be mid-launch or showing a dialog. */
const RETRY_DELAY_MS = 5000
const MAX_ATTEMPTS = 3
/**
 * Sends tried while the worktree is still building. Two, because the first one is
 * the one worth having — it goes ~2s after creation, against the minutes `ready`
 * costs — and the second only covers Conductor still drawing the new workspace. A
 * third would buy nothing: past that the composer's absence is the answer, and each
 * run costs the shared UI lock tens of seconds that a human tap then waits behind.
 */
const MAX_EARLY_ATTEMPTS = 2
/** Spacing between those two, long enough for Conductor to have finished drawing. */
const EARLY_RETRY_DELAY_MS = 20_000
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
	enqueue(
		workspaceId: string,
		text: string,
		sendImmediately = true,
		attachmentIds: string[] = [],
		agent?: ParkedAgentPatch,
		sessionRole?: string
	): Promise<FirstPrompt | null> {
		this.entries = [
			...this.entries.filter(e => e.workspaceId !== workspaceId),
			{
				workspaceId,
				text,
				...(agent && Object.keys(agent).length ? { agent } : {}),
				...(attachmentIds.length ? { attachmentIds } : {}),
				...(sessionRole ? { sessionRole } : {}),
				status: 'waiting',
				attempts: 0,
				createdAt: Date.now(),
				sendImmediately
			}
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
		const entry = this.entries.find(e => e.workspaceId === workspaceId)
		if (!entry) return false
		this.entries = this.entries.filter(e => e !== entry)
		this.save()
		this.discard(entry)
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
		// A closed gate (locked Mac) freezes the entry whole: no attempt, and no aging
		// either — the age cap judges the worktree's setup, and setup doesn't need the
		// screen, but failing a deliverable prompt because nobody was home to unlock
		// is exactly the "gave up while you were out" this queue exists to prevent.
		if (this.deps.gate && !(await this.deps.gate())) return
		const target = this.deps.inspect(entry.workspaceId)
		// No row yet is normal right after creation, and a workspace that really is gone
		// falls out here rather than being guessed at. Asked before anything below, so an
		// entry that has spent its early sends still expires instead of waiting forever.
		const sendable = target?.phase === 'ready' && !!target.sessionId
		if (!sendable && Date.now() - entry.createdAt > MAX_AGE_MS) {
			return this.fail(entry, 'the workspace never finished setting up')
		}
		if (entry.attachmentIds?.length) {
			if (!target?.worktree) return
			if (!this.deps.materialize) return this.fail(entry, 'the relay cannot place the attached files')
			const attachmentIds = entry.attachmentIds
			const materialized = await this.deps.materialize(entry.workspaceId, target.worktree, attachmentIds)
			if (!materialized.ok) return this.fail(entry, materialized.error ?? 'the attached files could not be copied')
			entry.attachmentIds = []
			this.save()
			this.discardIds(attachmentIds)
		}
		if (!target?.sessionId) return
		if (entry.sessionRole && !entry.sessionRoleAssigned) {
			if (!target.worktree) return
			if (!this.deps.assignRole) return this.fail(entry, 'the relay cannot assign the workflow root role')
			const assigned = await this.deps.assignRole(
				entry.workspaceId,
				target.sessionId,
				entry.sessionRole,
				entry.createdAt
			)
			if (!assigned.ok) return this.fail(entry, assigned.error ?? 'the workflow root role could not be saved')
			entry.sessionRoleAssigned = true
			this.save()
		}
		// It already went — the user sent it from the Mac, where the deep link left it
		// pre-filled in the composer. Sending again would double it, and changing the
		// agent now would affect a later turn instead of the first one they configured.
		if (target.alreadySent) return this.delivered(entry)

		// Before `ready`, a send is worth trying and not worth judging: Conductor may not
		// have drawn the chat pane yet, and that comes back as an ordinary failure. So an
		// early run spends its own small budget and the real one stays whole — the worst
		// this can do is what the file did before, deliver once the worktree is built.
		const early = target.phase !== 'ready'
		// The caller can opt back into the old wait — see `sendImmediately`.
		if (early && entry.sendImmediately === false) return
		// Spacing is read off the *current* phase rather than stamped in at the last
		// failure, so the long early gap stops applying the moment the worktree is ready:
		// what it was waiting out was an undrawn pane, and 'ready' is the answer to that.
		const spacing = early ? EARLY_RETRY_DELAY_MS : RETRY_DELAY_MS
		if (entry.lastAttemptAt && Date.now() - entry.lastAttemptAt < spacing) return
		if (early && (entry.earlyAttempts ?? 0) >= MAX_EARLY_ATTEMPTS) return
		if (early) entry.earlyAttempts = (entry.earlyAttempts ?? 0) + 1
		else entry.attempts += 1
		this.save()

		const agent = entry.agent ?? (entry.model ? { model: entry.model } : undefined)
		const result = agent
			? await this.setAgent(entry, target.sessionId, agent)
			: entry.text.trim()
				? await this.deps.send(entry.workspaceId, target.sessionId, entry.text)
				: { ok: true }
		if (result.ok) return this.delivered(entry)
		if (result.blocked) {
			// The gate closed between the check above and the send: hand the attempt back.
			if (early) entry.earlyAttempts = (entry.earlyAttempts ?? 1) - 1
			else entry.attempts -= 1
			this.save()
			return
		}
		const error = result.error ?? 'the send didn’t land'
		// A stamp, never a sleep: `pump` walks every waiting entry in one pass, so
		// sleeping here holds up the siblings created in the same burst — which is the
		// case this queue was reported broken on.
		entry.lastAttemptAt = Date.now()
		if (early) {
			console.info(`[relay] first prompt for ${entry.workspaceId} didn’t land during setup (${error}) — waiting`)
			return this.save()
		}
		console.warn(`[relay] first prompt for ${entry.workspaceId} failed (attempt ${entry.attempts}): ${error}`)
		if (entry.attempts >= MAX_ATTEMPTS) return this.fail(entry, error)
		this.save()
	}

	/**
	 * Keep agent choices in the same attempt as the prompt. A successful settings
	 * change is persisted before the send starts, so a retry cannot toggle controls
	 * back and forth. A workspace with no prompt settles after this step.
	 */
	private async setAgent(
		entry: FirstPrompt,
		sessionId: string,
		agent: ParkedAgentPatch
	): Promise<{ ok: boolean; error?: string; blocked?: boolean }> {
		if (!this.deps.setAgent) return { ok: false, error: 'the relay cannot configure a new workspace’s agent' }
		const result = await this.deps.setAgent(entry.workspaceId, sessionId, agent)
		if (!result.ok) return result
		entry.agent = undefined
		entry.model = undefined
		this.save()
		return entry.text.trim() ? this.deps.send(entry.workspaceId, sessionId, entry.text) : { ok: true }
	}

	/** Delivered: the entry's job is done, so it stops existing. */
	private delivered(entry: FirstPrompt): void {
		this.entries = this.entries.filter(e => e !== entry)
		this.save()
		this.discard(entry)
		this.settle(entry.workspaceId, null)
	}

	/** Given up on: kept, so the phone can show the text and the reason. */
	private fail(entry: FirstPrompt, error: string): void {
		entry.status = 'failed'
		entry.error = error
		this.save()
		this.settle(entry.workspaceId, entry)
	}

	private discard(entry: FirstPrompt): void {
		if (entry.attachmentIds?.length) this.discardIds(entry.attachmentIds)
	}

	private discardIds(attachmentIds: string[]): void {
		if (!attachmentIds.length || !this.deps.discard) return
		void Promise.resolve(this.deps.discard(attachmentIds)).catch(err => {
			console.warn(`[relay] could not discard staged attachments: ${err instanceof Error ? err.message : err}`)
		})
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
			return parsed
				.filter(
					e =>
						typeof e?.workspaceId === 'string' &&
						typeof e.text === 'string' &&
						Date.now() - (e.createdAt ?? 0) < KEEP_FAILED_MS
				)
				.map(e => ({
					...e,
					sessionRole: typeof e.sessionRole === 'string' && e.sessionRole.trim() ? e.sessionRole.trim() : undefined,
					sessionRoleAssigned: e.sessionRoleAssigned === true ? true : undefined,
					attachmentIds: Array.isArray(e.attachmentIds)
						? e.attachmentIds.filter((id): id is string => typeof id === 'string')
						: undefined
				}))
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
