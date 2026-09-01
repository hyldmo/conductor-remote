/**
 * Push notifications: "your agent finished" on the lock screen.
 *
 * This is a *third* shape next to the reads/writes split in CLAUDE.md, and the
 * cheapest one — it is a **read that pushes**. Nothing here touches Conductor:
 * the trigger is a poll of the same read-only SQLite the list view uses, and the
 * delivery is an HTTPS POST to Apple/Google/Mozilla's push service. No
 * Accessibility, no AppleScript, no window has to exist. A Conductor update can
 * rename every UI string and notifications keep working.
 *
 * What counts as news is deliberately narrow. `sessions.status` is the only
 * signal Conductor records. A normal turn ends in one of three states:
 * - `working → idle | needs_plan_response | needs_user_input` means the turn ended.
 *   This is *the* event: it covers "done", "asked you a question" and "plan ready"
 *   alike, because all three end the turn.
 * - `→ error` — the agent stopped badly.
 * There is no permission-request table to watch (verified against the schema), so
 * don't go looking for a finer-grained trigger; there isn't one.
 *
 * Two properties worth keeping:
 * - **Transitions are confirmed one tick before they fire.** A status that
 *   flickers (a queued prompt starting the next turn immediately) would otherwise
 *   buzz a phone for a turn that never really ended.
 * - **The first tick after a device subscribes is a baseline, not a broadcast.**
 *   Every already-idle session on the Mac is not news; without this, enabling
 *   notifications would fire one per workspace.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './config.ts'
import type { Reads, SessionState } from './reads.ts'
import type { PushSubscription, VapidKeys } from './webpush.ts'
import { generateVapidKeys, MAX_PAYLOAD_BYTES, sendPush } from './webpush.ts'

/** A subscribed phone. `endpoint` + `keys` are capability material — they never leave this process. */
interface Device {
	endpoint: string
	keys: { p256dh: string; auth: string }
	/** Whatever the browser could tell us about the device, for the "3 devices" line in the UI. */
	label: string
	createdAt: number
	lastOkAt: number | null
	lastError: string | null
	/** Consecutive delivery failures; reset on success. Loud in the UI once a device is plainly broken. */
	failures: number
}

/** The safe half of a `Device` — what `GET /api/push` may hand back over the wire. */
export interface DeviceInfo {
	/** Stable per-endpoint id (hash), so a device can be named without exposing its push URL. */
	id: string
	label: string
	createdAt: number
	lastOkAt: number | null
	lastError: string | null
	failures: number
}

interface Store {
	version: number
	vapid: VapidKeys
	devices: Device[]
}

export interface PushMessage {
	title: string
	body: string
	/** Notifications sharing a tag replace each other on the phone instead of stacking. */
	tag: string
	/** In-app route to open on tap. */
	url: string
	kind: 'done' | 'error' | 'test'
	ts: number
}

const STORE_VERSION = 1
/** Poll cadence for status transitions. Matches the phone's own list poll — a local SQLite read is cheap. */
const TICK_MS = 3000
/**
 * How long a push service should hold a notification for a phone that's offline.
 * An hour: long enough to survive a tunnel/airplane-mode blip, short enough that
 * "your agent finished" can't surface tomorrow morning as if it just happened.
 */
const TTL_SECONDS = 3600
/** Notification bodies are one glance on a lock screen; the chat has the rest. */
const BODY_CHARS = 180
/** Consecutive failures before a device is dropped. A `gone` response drops it immediately, regardless. */
const MAX_FAILURES = 20
/**
 * How long a "this device is reading that chat" stamp counts for. The stamp is refreshed
 * by the transcript poll, which runs once a second, so anything past a few seconds means
 * the phone stopped polling: the app was closed, the screen went away, iOS suspended it.
 * Ten seconds is short enough that a phone put down mid-turn gets its notification, and
 * long enough to survive a slow tunnel dropping a handful of ticks.
 */
const VIEWING_FRESH_MS = 10_000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

/** Alongside the token and the first-prompt queue — one dir holding everything this relay persists. */
function storePath(): string {
	return path.join(stateDir(), 'push.json')
}

/**
 * VAPID identifies the sender to the push service and must be a `mailto:` or
 * `https:` URL. The project's own repo says who this is without publishing an
 * address; `PUSH_SUBJECT` overrides for anyone who'd rather be contactable.
 */
function subject(): string {
	return process.env.PUSH_SUBJECT || 'https://github.com/hyldmo/conductor-remote'
}

let store: Store | null = null

function load(): Store {
	if (store) return store
	try {
		const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Store
		if (raw?.version === STORE_VERSION && raw.vapid?.publicKey && Array.isArray(raw.devices)) {
			store = raw
			return store
		}
		console.warn('[push] ignoring unreadable subscription store — starting fresh (devices must re-enable)')
	} catch {
		// no store yet, or unreadable — mint one below
	}
	// A fresh keypair invalidates every existing browser subscription, so this only
	// ever happens when there were none to invalidate (or the file was deleted).
	store = { version: STORE_VERSION, vapid: generateVapidKeys(), devices: [] }
	save()
	return store
}

function save(): void {
	if (!store) return
	const file = storePath()
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		// Write-then-rename so a crash mid-write can't leave a half-file that costs
		// every phone its subscription. 0600: this holds push capability URLs.
		const tmp = `${file}.tmp`
		fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 })
		fs.renameSync(tmp, file)
	} catch (err) {
		console.warn(`[push] could not persist subscriptions (${err instanceof Error ? err.message : err})`)
	}
}

/** Short, stable, non-reversible handle for an endpoint — safe to show and to address a device by. */
function deviceId(endpoint: string): string {
	return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}

/**
 * The chat each device last had on screen. Deliberately *not* part of `Store`: it is
 * stamped by the transcript poll once a second, so persisting it would rewrite
 * `push.json` at that rate, and a stamp is worthless the moment the relay restarts.
 */
const viewing = new Map<string, { sessionId: string; at: number }>()

/**
 * Record that a device is reading a chat right now. The phone sends this along its
 * transcript poll only while the page is visible — the same test that moves its read
 * mark — so "reading" here means on screen, not merely left open in the background.
 */
export function noteViewing(id: string, sessionId: string): void {
	const now = Date.now()
	// The id is whatever the header carried, so nothing here bounds the key space but the
	// token on the request. A device that stopped polling is already ignored; drop it too,
	// rather than keep a row per id anybody ever sent.
	if (viewing.size > 16) for (const [key, seen] of viewing) if (now - seen.at >= VIEWING_FRESH_MS) viewing.delete(key)
	viewing.set(id, { sessionId, at: now })
}

/**
 * Is this device looking at this chat? Suppression is per device on purpose: the phone
 * in a pocket still buzzes for a chat the tablet happens to be showing.
 */
export function isReading(id: string, sessionId: string, now = Date.now()): boolean {
	const seen = viewing.get(id)
	return !!seen && seen.sessionId === sessionId && now - seen.at < VIEWING_FRESH_MS
}

function info(d: Device): DeviceInfo {
	return {
		id: deviceId(d.endpoint),
		label: d.label,
		createdAt: d.createdAt,
		lastOkAt: d.lastOkAt,
		lastError: d.lastError,
		failures: d.failures
	}
}

/** Whether the notifier is allowed to run at all (`PUSH_NOTIFY=off` disables it). */
export function notificationsEnabled(): boolean {
	const raw = process.env.PUSH_NOTIFY?.trim().toLowerCase()
	return !(raw === 'off' || raw === 'false' || raw === '0')
}

/** What the phone needs to subscribe, plus who is already subscribed. */
export function pushConfig(): { enabled: boolean; publicKey: string; devices: DeviceInfo[] } {
	const s = load()
	return { enabled: notificationsEnabled(), publicKey: s.vapid.publicKey, devices: s.devices.map(info) }
}

/**
 * Register (or refresh) a device. Upserts on endpoint: the phone re-sends its
 * subscription on every app load, which is what keeps a relay that lost its store
 * — or a subscription the browser silently renewed — from going quietly dead.
 */
export function subscribeDevice(sub: PushSubscription, label: string): { id: string; devices: DeviceInfo[] } {
	const s = load()
	const existing = s.devices.find(d => d.endpoint === sub.endpoint)
	if (existing) {
		existing.keys = sub.keys
		existing.label = label || existing.label
		// A re-subscribe is the user telling us this device works; clear the failure trail.
		existing.failures = 0
		existing.lastError = null
	} else {
		s.devices.push({
			endpoint: sub.endpoint,
			keys: sub.keys,
			label: label || 'phone',
			createdAt: Date.now(),
			lastOkAt: null,
			lastError: null,
			failures: 0
		})
		console.info(`[push] device subscribed (${label || 'phone'}) — ${s.devices.length} total`)
	}
	save()
	// The id comes back so the phone can address itself (the "Send test" button) without
	// ever putting its own endpoint back on the wire.
	return { id: deviceId(sub.endpoint), devices: s.devices.map(info) }
}

export function unsubscribeDevice(endpoint: string): boolean {
	const s = load()
	const before = s.devices.length
	s.devices = s.devices.filter(d => d.endpoint !== endpoint)
	if (s.devices.length === before) return false
	viewing.delete(deviceId(endpoint))
	console.info(`[push] device unsubscribed — ${s.devices.length} left`)
	save()
	return true
}

function drop(endpoint: string, why: string): void {
	const s = load()
	s.devices = s.devices.filter(d => d.endpoint !== endpoint)
	viewing.delete(deviceId(endpoint))
	console.info(`[push] dropped a dead subscription (${why}) — ${s.devices.length} left`)
	save()
}

/** Deliver one message to one device, folding the outcome back into its health fields. */
async function deliver(device: Device, message: PushMessage): Promise<boolean> {
	const s = load()
	let payload = Buffer.from(JSON.stringify(message))
	if (payload.length > MAX_PAYLOAD_BYTES) {
		// Unreachable at the current BODY_CHARS, but an over-long title (a workspace name
		// is user text) must clip rather than turn into a failed send.
		const room = Math.max(0, message.body.length - (payload.length - MAX_PAYLOAD_BYTES) - 8)
		payload = Buffer.from(JSON.stringify({ ...message, body: clip(message.body, room) }))
	}
	const result = await sendPush(device, s.vapid, subject(), payload, TTL_SECONDS)
	if (result.ok) {
		device.lastOkAt = Date.now()
		device.lastError = null
		device.failures = 0
		save()
		return true
	}
	if (result.gone) {
		drop(device.endpoint, `push service says ${result.status}`)
		return false
	}
	device.failures++
	device.lastError = result.error ?? `HTTP ${result.status}`
	// Never log the endpoint: it's a capability URL, and the log is a wire surface (src/logbuf.ts).
	console.warn(`[push] delivery failed (${device.lastError}) — ${device.failures} in a row`)
	if (device.failures >= MAX_FAILURES) drop(device.endpoint, `${device.failures} consecutive failures`)
	else save()
	return false
}

/**
 * Fan a message out to every subscribed device. Returns how many took it.
 *
 * `unlessReading` names a chat: a device with that chat on screen is skipped, because
 * buzzing about a message already in front of someone is noise. The drop has to happen
 * here rather than in the service worker — Safari treats a push that resolves without a
 * notification as abuse and can revoke the subscription (see public/push-sw.js), so the
 * phone's only way to stay quiet is for nothing to be sent.
 */
export async function notifyAll(message: PushMessage, unlessReading?: string): Promise<number> {
	const s = load()
	if (!s.devices.length) return 0
	// Snapshot: `deliver` can prune the live array mid-flight.
	const targets = s.devices.slice().filter(d => !(unlessReading && isReading(deviceId(d.endpoint), unlessReading)))
	const held = s.devices.length - targets.length
	// "Nothing arrived" and "nothing was sent, on purpose" are the same silence on a
	// phone, and only one of them is a fault. /api/logs is where that question is asked.
	if (held) console.info(`[push] held back from ${held} device${held === 1 ? '' : 's'} reading that chat`)
	if (!targets.length) return 0
	const results = await Promise.all(targets.map(d => deliver(d, message)))
	return results.filter(Boolean).length
}

/** Send to one device — the Connect sheet's "Send test", which proves the whole path end to end. */
export async function notifyDevice(id: string, message: PushMessage): Promise<{ ok: boolean; error?: string }> {
	const s = load()
	const device = s.devices.find(d => deviceId(d.endpoint) === id)
	if (!device) return { ok: false, error: 'this device is not subscribed' }
	const ok = await deliver(device, message)
	return ok ? { ok } : { ok: false, error: device.lastError ?? 'the push service rejected it' }
}

export function deviceCount(): number {
	return load().devices.length
}

/**
 * Where a tapped notification lands. The chat id rides along because the phone
 * otherwise picks the tab itself (Conductor's active session, else the first one)
 * — and on a multi-chat workspace that is rarely the chat that just finished.
 * Kept here so the notifier and the parked-prompt queue can't drift apart.
 */
export function chatRoute(workspaceId: string, sessionId: string): string {
	return `/w/${workspaceId}?session=${encodeURIComponent(sessionId)}`
}

/** Collapse a transcript entry to one lock-screen line: no code fences, no blank runs. */
function oneLine(text: string): string {
	return clip(
		text
			.replace(/```[\s\S]*?```/g, '…')
			.replace(/\s+/g, ' ')
			.trim(),
		BODY_CHARS
	)
}

// --- the watcher ---

/**
 * Everything this chat records about a person having asked for something, as one
 * comparable string — the turn head *and* the last user message, because steering a
 * running turn moves only the second (`queue_order` is null on a steering message, see
 * reads.ts). Empty when the chat records neither, which is what `selfScheduled` reads
 * as "no evidence" rather than as "nobody asked".
 */
function askedBy(state: { turnStartedAt: string | null; lastUserMessageAt: string | null }): string {
	if (!state.turnStartedAt && !state.lastUserMessageAt) return ''
	return `${state.turnStartedAt ?? ''}|${state.lastUserMessageAt ?? ''}`
}

/** Statuses that keep a completed turn open until the person responds. */
function turnEnded(status: string | null): boolean {
	return status === 'idle' || status === 'needs_plan_response' || status === 'needs_user_input'
}

/** A chat whose transition has been confirmed and is worth a notification. */
export interface DueNotification {
	state: SessionState
	kind: 'done' | 'error'
}

/**
 * The status state machine, kept apart from the store and the network so it can be
 * driven a tick at a time by `tests/notify.test.ts`. Every rule in it is a rule
 * about *not* notifying, and each one is a nuisance or a silence that nothing in the
 * type system can catch.
 */
export class TurnWatcher {
	/** Last seen status per chat. Null means "re-baseline on the next step" (nobody was subscribed). */
	private previous: Map<string, string | null> | null = null
	/** Transitions seen once and awaiting a second step's confirmation. */
	private readonly armed = new Map<string, 'done' | 'error'>()
	/**
	 * Who-asked, as of the last turn we said "done" about, per chat — what makes a
	 * self-scheduled turn quiet.
	 *
	 * `working → idle` is still the only signal Conductor gives, and it is still the right
	 * one for a turn *someone asked for*. It is the wrong one for a turn the agent
	 * scheduled itself: a `/loop` starts a fresh turn every few minutes for as long as it
	 * runs, each one ends properly, and each one is news to nobody. Measured on this Mac —
	 * one looping chat pushed roughly every five minutes from early evening until past
	 * midnight, and again all morning, which was most of the notifications the phone got
	 * at all.
	 *
	 * The tell is in the data rather than in a guess about intent. A turn is headed by a
	 * `session_messages` row with `queue_order` set and a loop's next lap writes nothing
	 * at all, so `askedBy` below sits still while `status` cycles. The first lap after you
	 * type something notifies. Every lap the agent gave itself is quiet, until you say the
	 * next thing. An `error` is exempt — a loop that breaks is worth hearing about however
	 * it started.
	 *
	 * A chat with nothing to compare (no turn head *and* no user message — dormant since
	 * before `queue_order` landed in May 2026) notifies every time, which is the old
	 * behaviour: with no evidence either way, silence is the dangerous default.
	 */
	private readonly notifiedTurn = new Map<string, string>()

	/**
	 * Nobody is subscribed. Forget the snapshot so re-enabling starts from the world as
	 * it is then, rather than replaying every turn that ended while nobody listened.
	 */
	reset(): void {
		this.previous = null
		this.armed.clear()
		this.notifiedTurn.clear()
	}

	/** One poll of every live chat, in; the notifications it earned, out. */
	step(states: SessionState[]): DueNotification[] {
		const current = new Map(states.map(s => [s.sessionId, s.status ?? null]))
		if (this.previous === null) {
			this.previous = current
			return []
		}
		const baseline = this.previous
		const due: DueNotification[] = []
		for (const state of states) {
			const now = state.status ?? null
			const before = baseline.get(state.sessionId)
			const pendingKind = this.armed.get(state.sessionId)
			if (pendingKind) {
				this.armed.delete(state.sessionId)
				// Confirmed only if the new status held for a second step; a flap just drops the arm.
				const held = (pendingKind === 'done' && turnEnded(now)) || (pendingKind === 'error' && now === 'error')
				if (held && !(pendingKind === 'done' && this.selfScheduled(state))) {
					const asked = askedBy(state)
					if (pendingKind === 'done' && asked) this.notifiedTurn.set(state.sessionId, asked)
					due.push({ state, kind: pendingKind })
				}
				continue
			}
			// A chat we've never seen (a new one, or the first step after re-baselining)
			// contributes its status to the snapshot but is never itself news.
			if (before === undefined) continue
			if (before === 'working' && turnEnded(now)) this.armed.set(state.sessionId, 'done')
			else if (before !== 'error' && now === 'error') this.armed.set(state.sessionId, 'error')
		}
		// A chat armed on the last step can vanish before this one (its workspace was
		// archived mid-turn). Nothing above touches it, so drop it here rather than keep
		// the key forever — and never notify about a workspace that no longer exists.
		for (const sessionId of this.armed.keys()) if (!current.has(sessionId)) this.armed.delete(sessionId)
		for (const sessionId of this.notifiedTurn.keys()) if (!current.has(sessionId)) this.notifiedTurn.delete(sessionId)
		this.previous = current
		return due
	}

	/**
	 * Did this chat end a turn nobody asked for? See `notifiedTurn`.
	 *
	 * The first `working → idle` a chat shows us always notifies, whatever started it: the
	 * relay may have only just come up, or the phone only just subscribed, and staying
	 * quiet about a turn we have no history for would lose the one notification that
	 * mattered. It is the *repeat* on an unchanged turn head that is the loop.
	 */
	private selfScheduled(state: SessionState): boolean {
		const asked = askedBy(state)
		if (!asked) return false
		const last = this.notifiedTurn.get(state.sessionId)
		return last !== undefined && last === asked
	}
}

const watcher = new TurnWatcher()

function tick(reads: Reads): void {
	if (deviceCount() === 0) {
		watcher.reset()
		return
	}
	for (const due of watcher.step(reads.listSessionStates())) void fire(reads, due.state.sessionId, due.kind, due.state)
}

async function fire(
	reads: Reads,
	sessionId: string,
	kind: 'done' | 'error',
	state: { workspaceId: string; workspaceTitle: string; repoName: string | null; sessionTitle: string | null }
): Promise<void> {
	const said = reads.lastAssistantText(sessionId)
	const where = state.sessionTitle ? `${state.workspaceTitle} · ${state.sessionTitle}` : state.workspaceTitle
	const body =
		kind === 'error'
			? said
				? `Stopped with an error. ${oneLine(said)}`
				: 'The agent stopped with an error.'
			: said
				? oneLine(said)
				: 'Finished its turn.'
	const sent = await notifyAll(
		{
			title: state.repoName ? `${where} — ${state.repoName}` : where,
			body,
			// Per chat, so a chatty agent replaces its own notification instead of stacking —
			// and two chats in one workspace stay separately tappable, since each now lands
			// somewhere different.
			tag: sessionId,
			url: chatRoute(state.workspaceId, sessionId),
			kind,
			ts: Date.now()
		},
		sessionId
	)
	if (sent) console.info(`[push] ${kind} in ${where} → ${sent} device${sent === 1 ? '' : 's'}`)
}

/**
 * Start watching for turn endings. Safe to call unconditionally — with no
 * subscribed devices this is one small local query every few seconds, and
 * `PUSH_NOTIFY=off` skips it entirely.
 */
export function startNotifier(reads: Reads): void {
	if (!notificationsEnabled()) {
		console.info('[push] notifications disabled (PUSH_NOTIFY=off)')
		return
	}
	const timer = setInterval(() => {
		try {
			tick(reads)
		} catch (err) {
			// A transient DB read failure must not kill the interval.
			console.warn(`[push] watcher tick failed: ${err instanceof Error ? err.message : err}`)
		}
	}, TICK_MS)
	timer.unref()
}
