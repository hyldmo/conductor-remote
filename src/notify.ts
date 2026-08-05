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
 * What counts as news is deliberately narrow — `sessions.status` is the only
 * signal Conductor records, and it holds exactly three values:
 * - `working → idle` — the turn ended. This is *the* event: it covers "done",
 *   "asked you a question" and "hit a permission prompt" alike, because all
 *   three end the turn.
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
import type { Reads } from './reads.ts'
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
	console.info(`[push] device unsubscribed — ${s.devices.length} left`)
	save()
	return true
}

function drop(endpoint: string, why: string): void {
	const s = load()
	s.devices = s.devices.filter(d => d.endpoint !== endpoint)
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

/** Fan a message out to every subscribed device. Returns how many took it. */
export async function notifyAll(message: PushMessage): Promise<number> {
	const s = load()
	if (!s.devices.length) return 0
	// Snapshot: `deliver` can prune the live array mid-flight.
	const results = await Promise.all(s.devices.slice().map(d => deliver(d, message)))
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

/** Last seen status per session. Null means "re-baseline on the next tick" (nobody was subscribed). */
let previous: Map<string, string | null> | null = null
/** Transitions seen once and awaiting a second tick's confirmation. */
const armed = new Map<string, 'done' | 'error'>()

function tick(reads: Reads): void {
	if (deviceCount() === 0) {
		// Nothing to notify. Forget the snapshot so re-enabling starts from the world as
		// it is then, rather than replaying every turn that ended while nobody listened.
		previous = null
		armed.clear()
		return
	}
	const states = reads.listSessionStates()
	const current = new Map(states.map(s => [s.sessionId, s.status ?? null]))
	if (previous === null) {
		previous = current
		return
	}
	const baseline = previous
	for (const state of states) {
		const now = state.status ?? null
		const before = baseline.get(state.sessionId)
		const pendingKind = armed.get(state.sessionId)
		if (pendingKind) {
			armed.delete(state.sessionId)
			// Confirmed only if the new status held for a second tick; a flap just drops the arm.
			if ((pendingKind === 'done' && now === 'idle') || (pendingKind === 'error' && now === 'error')) {
				void fire(reads, state.sessionId, pendingKind, state)
			}
			continue
		}
		// A session we've never seen (a new chat, or the first tick after re-baselining)
		// contributes its status to the snapshot but is never itself news.
		if (before === undefined) continue
		if (before === 'working' && now === 'idle') armed.set(state.sessionId, 'done')
		else if (before !== 'error' && now === 'error') armed.set(state.sessionId, 'error')
	}
	// A session armed on the last tick can vanish before this one (its workspace was
	// archived mid-turn). Nothing above touches it, so drop it here rather than keep
	// the key forever — and never notify about a workspace that no longer exists.
	for (const sessionId of armed.keys()) if (!current.has(sessionId)) armed.delete(sessionId)
	previous = current
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
	const sent = await notifyAll({
		title: state.repoName ? `${where} — ${state.repoName}` : where,
		body,
		// Per workspace, so a chatty agent replaces its own notification instead of stacking.
		tag: state.workspaceId,
		url: `/w/${state.workspaceId}`,
		kind,
		ts: Date.now()
	})
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
