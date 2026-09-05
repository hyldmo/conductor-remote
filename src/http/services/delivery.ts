import type http from 'node:http'

import path from 'node:path'

import { applyAgentConfig } from '../../agents/agent-config.ts'

import { stateDir } from '../../config.ts'

import { FirstPromptQueue } from '../../delivery/firstprompt.ts'
import { type ParkedAgentPatch, type ParkedPrompt, ParkedPromptQueue } from '../../delivery/parked.ts'
import { SendOnce } from '../../delivery/sendonce.ts'
import {
	discardStagedAttachment,
	materializeStagedAttachments,
	pruneStagedAttachments
} from '../../files/staged-attachments.ts'
import { chatRoute, notifyAll } from '../../notifications/notify.ts'
import { readPrefs } from '../../prefs.ts'
import type { DeliveryCursor, DeliveryReceipt, SessionRow, Workspace } from '../../reads/types.ts'
import { setAgentOptions } from '../../writes/agent-options.ts'
import { newChat } from '../../writes/chats.ts'
import { lockBlocked, retryWontHelp, screenLocked, sendNeverStarted } from '../../writes/guards.ts'
import type { ChatTab, SendResult } from '../../writes/types.ts'
import { withUiPriority } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'

export function createDeliveryServices(
	services: Pick<
		BaseServices,
		| 'reads'
		| 'sleep'
		| 'actuator'
		| 'STAGED_ATTACHMENTS_DIR'
		| 'assignWorkflowRoot'
		| 'orchestration'
		| 'stagedAttachmentIdsInObjective'
		| 'modelCache'
	>
) {
	const {
		reads,
		sleep,
		actuator,
		STAGED_ATTACHMENTS_DIR,
		assignWorkflowRoot,
		orchestration,
		stagedAttachmentIdsInObjective,
		modelCache
	} = services

	/**
	 * Has Conductor taken ownership of the prompt yet? The receipt everything below is
	 * built on. The AppleScript actuator reports `ok` on `osascript` exit 0 — which only
	 * means the script *ran*, not that Conductor accepted the keystrokes — so without
	 * this a dropped send (asleep/unfocused Mac) looks delivered. A prompt accepted into
	 * Conductor's durable outbox also counts, before it becomes a transcript row.
	 */
	function deliveredSince(sessionId: string, text: string, since: DeliveryCursor): DeliveryReceipt | null {
		return reads.deliveryReceiptSince(sessionId, text, since)
	}

	function deliveredRowSince(sessionId: string, text: string, sinceRowid: number): number | null {
		const target = text.trim()
		const { entries } = reads.getMessages(sessionId, sinceRowid)
		return entries.find(e => e.role === 'user' && e.text.trim() === target)?.rowid ?? null
	}

	/**
	 * Watch for a receipt, ending on a check rather than a sleep, and never past
	 * `budgetDeadline`. Conductor records the row or outbox item right after the send
	 * presses Enter, so a real send is confirmed in a tick and only the failure path
	 * waits the window out.
	 *
	 * The window is *also* what makes a retry safe — it is deliberately longer than the
	 * row takes to appear, because everything past it is allowed to type into the
	 * composer again — so note which end of the budget gets clipped when the two
	 * compete: a retry only happens with `MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS` left, so
	 * a confirm *followed by another attempt* always gets its full window. Only the
	 * last confirm of all can be cut short, and nothing follows it to duplicate a row.
	 */
	async function confirmDelivery(
		sessionId: string,
		text: string,
		since: DeliveryCursor,
		budgetDeadline: number,
		receiptProbe = () => deliveredSince(sessionId, text, since)
	): Promise<DeliveryReceipt | null> {
		const stopAt = Math.min(Date.now() + CONFIRM_WINDOW_MS, budgetDeadline)
		for (;;) {
			const receipt = receiptProbe()
			if (receipt) return receipt
			if (Date.now() >= stopAt) return null
			await sleep(300)
		}
	}

	/** How long we watch the transcript after a run before deciding it didn't land. */
	const CONFIRM_WINDOW_MS = 6_000

	/** Ceiling on a whole send, retries included — no phone should hold a request open longer. */
	const SEND_BUDGET_MS = 55_000

	/** Below this there isn't room for a run that could plausibly succeed, so don't start one. */
	const MIN_ATTEMPT_MS = 12_000

	/**
	 * The least a confirm is worth doing at all. Held back from every run so a send that
	 * lands can be *seen* to have landed — an unconfirmed send is indistinguishable from
	 * a lost one, which is the failure this whole path exists to avoid.
	 */
	const MIN_CONFIRM_MS = 2_000

	/** Leaves the response itself time to get home before the caller's own timer fires. */
	const RESPONSE_MARGIN_MS = 5_000

	/**
	 * Budget for a caller that didn't say how long it would wait — a PWA build from
	 * before `x-client-timeout-ms`, which aborted a send at a flat 25s. Sized so that
	 * such a phone is no worse off than it was: one run with a ceiling like the old one,
	 * and no retry (there was never room for a retry inside 25s).
	 */
	const LEGACY_SEND_BUDGET_MS = 20_000

	/**
	 * Never outlast the caller. The relay giving up *after* the phone has is the worst
	 * available outcome: the phone shows a failure while the send goes on to land, and
	 * the user can't tell that from a send that really didn't. Pairing our budget to
	 * the PWA's by hand wouldn't hold — the relay updates itself (src/host/autoupdate.ts) while
	 * the app sits in a service-worker cache — so the caller states its own deadline
	 * and we retry inside it.
	 */
	function sendBudget(req: http.IncomingMessage): number {
		const asked = Number(req.headers['x-client-timeout-ms'])
		if (!Number.isFinite(asked) || asked <= 0) return LEGACY_SEND_BUDGET_MS
		// Floor at one confirmable attempt: a caller in a hurry still gets a real try.
		return Math.max(MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS, Math.min(SEND_BUDGET_MS, asked - RESPONSE_MARGIN_MS))
	}

	/**
	 * Where a chat sits in Conductor's tab strip. Both write paths need it: the
	 * actuator selects that tab before touching anything, otherwise it acts on
	 * whichever tab happens to be active.
	 */
	function locateChat(
		ws: Workspace,
		sessionId: string
	): { tab: ChatTab | undefined; session: SessionRow | undefined } | { error: string } {
		const sessions = reads.listSessions(ws.id)
		const index = sessions.findIndex(s => s.id === sessionId)
		if (index < 0 && sessions.length > 1) return { error: 'chat is no longer one of the workspace’s tabs' }
		if (index < 0) return { tab: undefined, session: undefined }
		return {
			tab: { index: index + 1, count: sessions.length, title: sessions[index].title ?? '' },
			session: sessions[index]
		}
	}

	/**
	 * Open a chat tab in a workspace and come back with its id.
	 *
	 * ⌘T is fire-and-forget like every other keystroke here, so the id is not something
	 * the write can return — the DB is the receipt. Which row is the new one is decided by
	 * diffing the tab list against the one taken *before* the keystroke, not by taking the
	 * newest: a sibling tab or another agent may have opened one in between, and picking by
	 * `created_at` would hand back theirs.
	 */
	async function openChat(
		ws: Workspace
	): Promise<
		{ sessionId: string | null } | { error: true; result: Awaited<ReturnType<typeof newChat>>; retryable?: boolean }
	> {
		const before = new Set(reads.listSessions(ws.id).map(s => s.id))
		const result = await newChat(ws)
		if (!result.ok) return { error: true, result }
		// The new session lands in the DB a beat after Cmd+T — poll for the fresh id.
		for (let i = 0; i < 12; i++) {
			await sleep(500)
			const fresh = reads.listSessions(ws.id).filter(s => !before.has(s.id))
			if (fresh.length > 1) {
				return {
					error: true,
					retryable: false,
					result: {
						ok: false,
						strategy: actuator.name,
						error: 'more than one new chat appeared; refusing to guess which one this request opened'
					}
				}
			}
			if (fresh[0]) return { sessionId: fresh[0].id }
		}
		// The tab is almost certainly on screen; only its id is missing. Say so rather than
		// failing the call, so a caller can still tell the user where the work went.
		return { sessionId: null }
	}

	/**
	 * Deliver a prompt to one chat and confirm it landed, retrying until the caller's
	 * budget runs out. The single write path: the phone's own sends go through it, and so
	 * does the first-prompt queue, so both get the same targeting, the same read-back,
	 * the same retries and the same errors.
	 *
	 * Retrying here rather than handing the phone a Retry button is the point: the
	 * failures this path hits are overwhelmingly warm-up costs — a cold or busy Conductor
	 * makes the first AppleScript run slow enough to be killed, and the second finds an
	 * activated app and lands — which is exactly why tapping Retry always worked. Two
	 * things make doing it automatically safe rather than a way to send a prompt twice:
	 *  - **The transcript is the receipt.** Every run is followed by a full
	 *    `CONFIRM_WINDOW_MS` of watching for the matching user row, *including* runs that
	 *    reported an error, and the last of those checks is the moment before we type
	 *    again. A run that actually landed — even one killed just after pressing Enter,
	 *    or one whose row appeared after we'd stopped looking — is reported as delivered.
	 *  - **The composer is written, not appended to** (`fillComposer` sets AXValue), so a
	 *    retry replaces a half-finished attempt's text instead of doubling it.
	 *
	 * Bounded by a wall clock rather than an attempt count, because someone is holding
	 * this request open: runs are bounded by the caller's deadline, and we stop rather
	 * than start one the budget could not also confirm. The queue's own 3-sends-over-15-
	 * minutes schedule sits *outside* this and is unaffected — it retries a delivery that
	 * never got off the ground (worktree still setting up), not one Conductor fumbled.
	 */
	async function deliverPrompt(
		ws: Workspace,
		sessionId: string,
		text: string,
		budgetMs = SEND_BUDGET_MS,
		queue = false,
		cursor?: DeliveryCursor,
		receiptProbe?: () => DeliveryReceipt | null
	): Promise<SendResult & { attempts: number } & ({ ok: true; receipt: DeliveryReceipt } | { ok: false })> {
		const located = locateChat(ws, sessionId)
		if ('error' in located) return { ok: false, strategy: actuator.name, attempts: 0, error: located.error }
		// Snapshot the transcript cursor and outbox ids once: every check below asks "did
		// *this* prompt arrive since we started", so a retry can't be fooled by an older
		// identical prompt moving from the outbox into a new transcript row.
		const before = cursor ?? reads.deliveryCursor(sessionId)
		const probe = receiptProbe ?? (() => deliveredSince(sessionId, text, before))
		const label = ws.branch ?? ws.id
		const deadline = Date.now() + budgetMs
		let attempts = 0
		let last: SendResult = { ok: false, strategy: actuator.name }
		for (;;) {
			// A persisted delegation cursor can already have a receipt after a restart
			// or a late acceptance. Recover it before touching the composer again.
			const existing = probe()
			if (existing) return { ok: true, strategy: last.strategy, attempts, receipt: existing }
			attempts++
			// The run gets the deadline, not a duration: `uiTurn` may hold it behind another
			// write, and only the run knows what was left of the budget when it started. Minus
			// the confirm, so a caller on a tight budget spends it on the run rather than on
			// watching — a 25s-era phone gets one full-length attempt, not two too short to finish.
			last = await actuator.send({ workspace: ws, sessionId, tab: located.tab }, text, {
				deadline: deadline - MIN_CONFIRM_MS,
				queue
			})
			// A run that left the prompt in the composer proved it wrote no row, so the
			// window would be six seconds of watching for nothing. One check still happens:
			// an *earlier* attempt's row can be arriving, and typing again over that is the
			// duplicate this whole path exists to avoid.
			const landed = sendNeverStarted(last.error)
				? probe()
				: await confirmDelivery(sessionId, text, before, deadline, probe)
			if (landed) {
				if (attempts > 1) console.info(`[relay] send to ${label} landed on attempt ${attempts}`)
				return { ok: true, strategy: last.strategy, attempts, receipt: landed }
			}
			if (retryWontHelp(last.error)) break
			// A locked screen isn't worth the rest of the budget either — but for the
			// opposite reason: the parked-prompt queue (src/delivery/parked.ts) waits it out far
			// past any deadline a phone could hold open, so hand it over at once.
			if (lockBlocked(last.error)) break
			if (deadline - Date.now() < MIN_ATTEMPT_MS + CONFIRM_WINDOW_MS) break
			// The phone only ever sees the outcome; why a send goes missing lives on this
			// side, so leave the trail in relay.log rather than nothing at all.
			console.warn(
				`[relay] send to ${label} attempt ${attempts} didn’t land (${last.error ?? 'no user row appeared'}) — retrying`
			)
		}
		const tried = attempts > 1 ? ` (tried ${attempts}×)` : ''
		const error = last.ok
			? `Could not confirm the sent message in Conductor${tried}. Check the chat before trying again.`
			: `${last.error}${tried}`
		console.warn(`[relay] send to ${label} failed after ${attempts} attempt(s): ${error}`)
		return { ok: false, strategy: last.strategy, attempts, error }
	}

	/**
	 * Undelivered first prompts, owned by this process rather than by the phone (see
	 * src/delivery/firstprompt.ts for why). Everything Conductor-side it needs is a plain DB read.
	 */
	const firstPrompts = new FirstPromptQueue(path.join(stateDir(), 'first-prompts.json'), {
		inspect: workspaceId => {
			const ws = reads.getWorkspace(workspaceId)
			if (!ws) return null
			// 'setting_up' is the worktree (and the setup script), not the window: Conductor
			// draws the workspace and its chat the moment the row exists, so the queue tries
			// the send then and treats only a post-'ready' failure as one worth counting.
			// `getWorkspace` already limits itself to 'ready'/'setting_up', so an archived
			// workspace reads as no row at all and ages out rather than being typed into.
			const sessions = reads.listSessions(workspaceId)
			const session = sessions.find(s => s.id === ws.active_session_id) ?? sessions[0]
			return {
				phase: ws.state === 'ready' ? 'ready' : 'setting_up',
				sessionId: session?.id ?? null,
				alreadySent: !!session?.last_user_message_at,
				worktree: ws.worktree
			}
		},
		// The queue fires on its own schedule, so it must never make a human tap wait.
		send: (workspaceId, sessionId, text) =>
			withUiPriority('background', async () => {
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) return { ok: false, error: 'the workspace is gone' }
				const result = await deliverPrompt(ws, sessionId, text)
				return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
			}),
		setAgent: (workspaceId, sessionId, agent) =>
			withUiPriority('background', async () => {
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) return { ok: false, error: 'the workspace is gone' }
				const result = await applyAgentPatch(ws, sessionId, agent)
				return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
			}),
		materialize: async (_workspaceId, worktree, attachmentIds) => {
			try {
				materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, worktree, attachmentIds)
				return { ok: true }
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : 'the attached files could not be copied' }
			}
		},
		assignRole: async (workspaceId, sessionId, role, assignedAt) => {
			try {
				const ws = reads.getWorkspace(workspaceId)
				return ws ? assignWorkflowRoot(ws, sessionId, role, assignedAt) : { ok: false, error: 'the workspace is gone' }
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) }
			}
		},
		discard: attachmentIds => {
			for (const id of attachmentIds) discardStagedAttachment(STAGED_ATTACHMENTS_DIR, id)
		},
		// A locked Mac holds first prompts whole — no attempts spent, no aging — instead
		// of burning all three sends into a lock screen nobody is there to see.
		gate: async () => (await screenLocked()) !== true
	})

	/** Unreferenced pre-workspace uploads get one week for an offline device to reconnect. */
	const STAGED_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

	const STAGED_ATTACHMENT_SWEEP_MS = 6 * 60 * 60 * 1000
	let additionalStagedReferences = (): string[] => []
	function setAdditionalStagedReferences(read: () => string[]): void {
		additionalStagedReferences = read
	}

	function referencedStagedAttachments(): Set<string> {
		const referenced = new Set<string>(additionalStagedReferences())
		for (const draft of Object.values(readPrefs().drafts)) {
			if (draft.deleted) continue
			for (const attachment of draft.attachments) {
				if (attachment.stageId) referenced.add(attachment.stageId)
			}
		}
		for (const prompt of firstPrompts.list()) {
			for (const stageId of prompt.attachmentIds ?? []) referenced.add(stageId)
		}
		if (orchestration.writable) {
			for (const projection of orchestration.listWorkflowProjections()) {
				const run = orchestration.getWorkflowRun(projection.id)
				if (run?.target.kind !== 'new_workspace') continue
				for (const stageId of stagedAttachmentIdsInObjective(run.objective)) referenced.add(stageId)
			}
		}
		return referenced
	}

	function sweepStagedAttachments(): void {
		const removed = pruneStagedAttachments(
			STAGED_ATTACHMENTS_DIR,
			referencedStagedAttachments(),
			STAGED_ATTACHMENT_MAX_AGE_MS
		)
		if (removed) console.info(`[relay] removed ${removed} abandoned staged attachment(s)`)
	}

	/**
	 * Apply staged agent settings to a chat — the shared half of `POST …/agent` and
	 * of a send that carries a patch. The `fast` translation lives here because the
	 * UI button only *toggles*: the DB says whether the press is needed at all.
	 */
	async function applyAgentPatch(
		ws: Workspace,
		sessionId: string,
		patch: ParkedAgentPatch
	): Promise<{ ok: boolean; error?: string }> {
		const located = locateChat(ws, sessionId)
		if ('error' in located) return { ok: false, error: located.error }
		const target = { workspace: ws, sessionId, tab: located.tab }
		const result = await applyAgentConfig(patch, {
			read: () => {
				const session = reads.listSessions(ws.id).find(row => row.id === sessionId)
				if (!session) return undefined
				return {
					agentType: session.agent_type,
					model: session.model,
					effort: session.claude_effort_level,
					plan: session.permission_mode === 'plan',
					fast: Boolean(session.fast_mode)
				}
			},
			write: options => setAgentOptions(target, options),
			wait: () => sleep(300)
		})
		if (!result.ok) return result
		if (patch.model) {
			const session = reads.listSessions(ws.id).find(row => row.id === sessionId)
			modelCache.rememberModel(session?.agent_type, patch.model)
		}
		return { ok: true }
	}

	/**
	 * One prompt per tap, however many requests carry it (src/delivery/sendonce.ts). Keyed on the
	 * phone's own `PendingMessage.id`, which Retry reuses and a fresh send re-rolls, so a
	 * repeat someone meant still goes twice. Only an answer the phone would treat as final
	 * is remembered: a real failure has to stay retryable, or Retry does nothing for ten
	 * minutes and the prompt is lost for good rather than merely doubled.
	 */
	const sendOnce = new SendOnce<{ status: number; body: SendResult }>({
		keep: answer => answer.status === 200 || answer.status === 202
	})

	/** What the phone is told when its prompt is parked instead of failed. */
	const PARKED_ERROR = 'The Mac is locked — the relay parked the prompt and will send it when the Mac is unlocked.'

	/**
	 * Prompts that hit the lock screen, owned by this process until the Mac unlocks
	 * (see src/delivery/parked.ts for why the phone can't wait this out itself).
	 */
	const parkedPrompts = new ParkedPromptQueue(path.join(stateDir(), 'parked-prompts.json'), {
		locked: screenLocked,
		// Delivers on unlock, on its own schedule — background, like the first-prompt queue.
		deliver: entry =>
			withUiPriority('background', async () => {
				const ws = reads.getWorkspace(entry.workspaceId)
				if (!ws) return { ok: false, error: 'the workspace is gone' }
				// Settings first, prompt only if they stuck — the same order and the same
				// fail-closed rule as the phone's own send (running the prompt on the model
				// the user moved away from is the mistake this exists to prevent). A re-run
				// after a failed prompt re-applies harmlessly: every control is read before
				// it is pressed, so an already-correct value presses nothing.
				if (entry.agent) {
					const applied = await applyAgentPatch(ws, entry.sessionId, entry.agent)
					if (!applied.ok) return { ok: false, error: applied.error, blocked: lockBlocked(applied.error) }
				}
				const result = await deliverPrompt(ws, entry.sessionId, entry.text, SEND_BUDGET_MS, entry.queue)
				return { ok: result.ok, error: result.error, blocked: lockBlocked(result.error) }
			}),
		notify: (entry: ParkedPrompt, error?: string) => {
			const ws = reads.getWorkspace(entry.workspaceId)
			const title = ws?.workspace_name ?? ws?.pr_title ?? ws?.branch ?? 'Conductor'
			const preview = entry.text.length > 140 ? `${entry.text.slice(0, 140).trimEnd()}…` : entry.text
			void notifyAll({
				title,
				body: error ? `Parked prompt failed: ${error}` : `Sent after unlock: ${preview}`,
				// Per chat, so a second parked prompt replaces the first's notification.
				tag: `parked-${entry.sessionId}`,
				url: chatRoute(entry.workspaceId, entry.sessionId),
				kind: error ? 'error' : 'done',
				ts: Date.now()
			})
		}
	})
	return {
		openChat,
		applyAgentPatch,
		deliverPrompt,
		deliveredRowSince,
		SEND_BUDGET_MS,
		locateChat,
		CONFIRM_WINDOW_MS,
		firstPrompts,
		parkedPrompts,
		confirmDelivery,
		sendBudget,
		sendOnce,
		PARKED_ERROR,
		sweepStagedAttachments,
		STAGED_ATTACHMENT_SWEEP_MS,
		setAdditionalStagedReferences
	}
}
export type DeliveryServices = ReturnType<typeof createDeliveryServices>
