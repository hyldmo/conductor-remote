import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { applyAgentConfig } from './agent-config.ts'
import { ATTACHMENT_DIR, attachmentName, attachmentPrompt, attachmentToken, writeAttachment } from './attachments.ts'
import { startAutoUpdate, updateStatus } from './autoupdate.ts'
import { attachChangeStats } from './change-stats.ts'
import { isDefaultEffortLevel, readDefaultEfforts, writeDefaultEfforts } from './conductor-settings.ts'
import { loadConfig, stateDir } from './config.ts'
import { ConductorDb } from './db.ts'
import {
	type DelegationActionError,
	DelegationQueue,
	DelegationStore,
	type PersistedDelegation
} from './delegations.ts'
import { DevServerController } from './dev-server.ts'
import { isAllowedPreviewPath, parseFileReference, parseImageReference } from './file-preview.ts'
import { FirstPromptQueue } from './firstprompt.ts'
import { captureForkWorkspace, materializeForkWorkspace, releaseForkWorkspace } from './fork-workspace.ts'
import { startFunnelWatchdog } from './funnel-watchdog.ts'
import { listSourceFiles, workspaceDiff, workspaceFileDiff } from './git.ts'
import {
	installLogCapture,
	isManaged,
	LOG_FILE_NAMES,
	logFiles,
	processStartedAt,
	recentLogs,
	redactSecrets,
	tailLogFile
} from './logbuf.ts'
import { type CallOptions, createTools, handleRpc, READ_TIMEOUT_MS, type RpcRequest } from './mcp-tools.ts'
import { mergePr } from './merge.ts'
import { ModelCache } from './model-cache.ts'
import {
	armNoSleep,
	disarmNoSleep,
	MAX_SECONDS as NOSLEEP_MAX_SECONDS,
	nosleepState,
	watchNoSleepExpiry
} from './nosleep.ts'
import {
	chatRoute,
	noteViewing,
	notifyAll,
	notifyDevice,
	pushConfig,
	startNotifier,
	subscribeDevice,
	unsubscribeDevice
} from './notify.ts'
import {
	type FrozenWorkflowRole,
	IdempotencyConflictError,
	ORCHESTRATION_PROTOCOL_VERSION,
	OrchestrationDb,
	type RelayIdentity,
	UiLeaseUnavailableError,
	type WorkflowRunRecord,
	WorkflowTransitionError
} from './orchestration-db.ts'
import { type ParkedAgentPatch, type ParkedPrompt, ParkedPromptQueue } from './parked.ts'
import { PlanUsageService } from './plan-usage.ts'
import { attachPrStatus } from './pr.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import {
	type DeliveryCursor,
	type DeliveryReceipt,
	Reads,
	type SearchWorkspace,
	type SessionRow,
	type Workspace
} from './reads.ts'
import {
	currentProcessStartIdentity,
	incompatibleRelayProcesses,
	listUiCapableRelayProcesses,
	processIdentityAlive
} from './relay-processes.ts'
import { decodeRoles, RoleStore, roleModelIssues } from './roles.ts'
import { isRoute, routeParam, routes } from './routes.ts'
import { attachRunActivity } from './run-activity.ts'
import { foldHits, queryTokens, SearchIndex, type SearchResult } from './search.ts'
import { SendOnce } from './sendonce.ts'
import { SessionPoller } from './session-poller.ts'
import { readSettings, writeSettings } from './settings.ts'
import {
	attachmentTokens,
	isOpenAIRealtimeVoice,
	isVoiceLanguage,
	modelLabel,
	OPENAI_REALTIME_VOICES,
	type OpenAIRealtimeVoice,
	responseErrorMessage,
	scrubWorkflowSecrets,
	timestampMs,
	VIEWING_HEADER,
	type VoiceLanguage,
	withoutClientWindowEvidence,
	withoutWindowEvidence,
	workspaceTitle
} from './shared.ts'
import {
	discardStagedAttachment,
	materializeStagedAttachments,
	pruneStagedAttachments,
	stageAttachment,
	stagedAttachments
} from './staged-attachments.ts'
import { driftWarningLines, readExposeMode, tailscaleBin } from './tailscale.ts'
import { renderTranscript, transcriptMessage, transcriptThrough } from './transcript.ts'
import { recoverExpiredUiLease } from './ui-lease-watchdog.ts'
import { VoiceBriefBoard } from './voice/brief.ts'
import { VoiceBroker } from './voice/broker.ts'
import { openAIOriginForSipHost, readVoiceConfig, voicePort } from './voice/config.ts'
import { createVoiceGateway } from './voice/gateway.ts'
import { PreviewStore } from './voice/preview.ts'
import { createVoiceServer } from './voice/server.ts'
import { mintSipTicket, missingTicketConfig } from './voice/ticket.ts'
import { createVoiceTools } from './voice/tools.ts'
import { createWebRtcCall, MAX_SDP_CHARS } from './voice/webrtc.ts'
import { autoJoinHotspotMode, currentSsid, looksLikeHotspot, preferredNetworks } from './wifi.ts'
import type {
	Attachment,
	CreateWorkspaceRequest,
	DelegateTaskResult,
	DelegationError,
	DelegationProjection,
	RolesConfig,
	SendPromptRequest,
	UiQuarantineWire,
	Workspace as WireWorkspace,
	WorkflowRunWire
} from './wire.ts'
import {
	WorkflowCoordinator,
	WorkflowCoordinatorError,
	type WorkflowDeliveryCursor,
	type WorkflowEffectCall,
	type WorkflowRootInspection
} from './workflow-coordinator.ts'
import {
	parseConfirmUiStableRequest,
	parseStartWorkflowRequest,
	parseWorkflowAdoptRequest,
	parseWorkflowCompleteRequest,
	parseWorkflowDelegateRequest,
	parseWorkflowReplayRequest,
	parseWorkflowRetryRequest,
	WorkflowRequestError,
	workflowClientIsMcp
} from './workflow-http.ts'
import { WorkflowGuardError } from './workflow-machine.ts'
import {
	archiveWorkspace,
	type ChatTab,
	closeChat,
	configureSharedUiLeaseProvider,
	continueWorkspace,
	createWorkspace,
	describeActuator,
	EFFORT_LABELS,
	listAgentModels,
	lockBlocked,
	newChat,
	pickActuator,
	restartConductorApp,
	retryWontHelp,
	type SendResult,
	screenLocked,
	sendNeverStarted,
	setAgentOptions,
	setDefaultModel,
	setRestartGuard,
	setWorkspaceStatus,
	stopTurn,
	UiBusyError,
	uiBusy,
	uiQueueDepth,
	uiTurn,
	WORKSPACE_STATUS_LABELS,
	withGatedUiCommand,
	withUiPriority
} from './writes.ts'

// Before anything that logs: from here on every console line is also kept in memory for
// `GET /api/logs`, so the phone can read why a send failed without ssh-ing into the Mac.
installLogCapture()

const cfg = loadConfig()
const db = new ConductorDb(cfg.dbPath)
const reads = new Reads(db, cfg.workspacesRoot)
const sessionPoller = new SessionPoller(() => reads.listSessionStates())
const actuator = pickActuator(cfg.writeStrategy)
const devServers = new DevServerController()
if (cfg.devWebPort !== undefined && process.env.CONDUCTOR_WORKSPACE_ID) {
	const preview = new URL(`http://localhost:${cfg.devWebPort}/`)
	preview.hash = new URLSearchParams({ token: cfg.token }).toString()
	// `yarn dev` is itself one application behind Conductor's Run button. Publish
	// the same canonical URL printed below. The private live advertisement crosses
	// into the installed relay that normally serves the phone; its forwarding code
	// still treats this exactly like any full URL and knows nothing about the token.
	devServers.advertisePreviewUrls(process.env.CONDUCTOR_WORKSPACE_ID, [{ name: 'Conductor Remote', url: preview.href }])
}
const STAGED_ATTACHMENTS_DIR = path.join(stateDir(), 'attachment-staging')

/** Attachment IDs are already encoded in the immutable objective's Conductor tokens. */
function stagedAttachmentIdsInObjective(objective: string): string[] {
	return [
		...new Set(
			attachmentTokens(objective).flatMap(token => {
				const match = /^\.context\/attachments\/([A-Za-z0-9]{6})\//.exec(token.path)
				return match ? [match[1]] : []
			})
		)
	]
}

// Picker labels cannot be reconstructed from `sessions.model`, so they belong to
// relay state alongside the prompt queues. This lets a brand-new workspace choose
// from a list before Conductor has created its first chat.
const modelCache = new ModelCache(path.join(stateDir(), 'model-cache.json'))
const planUsage = new PlanUsageService()
const roleStore = new RoleStore(path.join(stateDir(), 'roles.json'))
const orchestration = new OrchestrationDb(path.join(stateDir(), 'orchestration.db'), {
	processProbe: processIdentityAlive
})
const relayIdentity: RelayIdentity = {
	instanceId: crypto.randomUUID(),
	pid: process.pid,
	processStartedAt: currentProcessStartIdentity(),
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
}

function orchestrationUnavailableReason(): string {
	return orchestration.schemaWarning ?? `orchestration schema ${orchestration.schemaVersion} is unsupported`
}

if (orchestration.writable) {
	orchestration.registerRelayInstance({ ...relayIdentity, canDriveUi: true })
	const sharedUiLeases = orchestration.createSharedUiLeaseProvider(relayIdentity, { leaseMs: 2 * 60_000 })
	configureSharedUiLeaseProvider({
		acquire: async request => {
			try {
				return await sharedUiLeases.acquire(request)
			} catch (error) {
				if (error instanceof UiLeaseUnavailableError) throw new UiBusyError(0)
				throw error
			}
		}
	})
} else {
	console.warn(`[relay] ${orchestrationUnavailableReason()}; Workflow is disabled until this relay is upgraded`)
}

/** One store object per live worktree, so the queue never registers a path twice. */
const delegationStores = new Map<string, { worktree: string; store: DelegationStore }>()

function delegationStore(ws: Workspace): DelegationStore | null {
	if (!ws.worktree) return null
	const cached = delegationStores.get(ws.id)
	if (cached?.worktree === ws.worktree) return cached.store
	const store = new DelegationStore(ws.worktree)
	delegationStores.set(ws.id, { worktree: ws.worktree, store })
	return store
}

function liveDelegationStores(): DelegationStore[] {
	return reads.listWorkspaces().flatMap(ws => {
		const store = delegationStore(ws)
		return store ? [store] : []
	})
}

/** Preserve role identity for already-persisted pre-coordinator Workflow prompts. */
function assignWorkflowRoot(
	ws: Workspace,
	sessionId: string,
	role: string,
	assignedAt: number
): { ok: true } | { ok: false; error: string } {
	const store = delegationStore(ws)
	if (!store) return { ok: false, error: 'the workflow worktree is unavailable' }
	if (reads.sessionWorkspaceId(sessionId) !== ws.id) {
		return { ok: false, error: 'the workflow root chat is not in that workspace' }
	}
	const session = reads.getSession(sessionId)
	if (!session) return { ok: false, error: 'the workflow root chat is unavailable' }
	const assignments = store.sessionRoles()
	if (assignments.warning) return { ok: false, error: `cannot assign the workflow root: ${assignments.warning}` }
	const existing = assignments.sessions[sessionId]
	if (existing && existing.role !== role) {
		return { ok: false, error: `the new chat is already assigned to role ${existing.role}` }
	}
	if (!existing) store.assign(sessionId, { role, assignedAt })
	return { ok: true }
}

// Full-text index over the chat prose, in the relay's own sidecar DB — never in
// Conductor's (see src/search.ts). It backfills in the background and is disposable:
// deleting the file rebuilds it on the next start.
const search = new SearchIndex(cfg.dbPath, path.join(stateDir(), 'search.db'))
search.start()

/**
 * The MCP tools, bound to this relay over loopback.
 *
 * A self-request looks odd and is deliberate: the alternative is carving every route
 * handler out of the router below so the tools could call them directly, which buys
 * a sub-millisecond hop and costs the guarantee that matters — that a tool behaves
 * identically over `POST /mcp` and over `conductor-remote mcp`'s stdio. One code
 * path, one set of budgets, one place a route's semantics live.
 */
const mcpTools = createTools(async <T>(route: string, opts: CallOptions = {}): Promise<T> => {
	// 0.0.0.0 binds every interface, so loopback still reaches us; a pinned RELAY_HOST
	// is the address we actually answer on.
	const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host
	const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
	const res = await fetch(`http://${host}:${cfg.port}${route}`, {
		method: opts.method ?? 'GET',
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			authorization: `Bearer ${cfg.token}`,
			'content-type': 'application/json',
			'x-relay-client': 'mcp',
			'x-client-timeout-ms': String(timeoutMs)
		},
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
	})
	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: unknown }
	if (!res.ok) {
		const busy = res.status === 503 ? ' (Conductor’s UI is busy — retry shortly)' : ''
		throw new Error(`${responseErrorMessage(payload.error, `HTTP ${res.status}`)}${busy}`)
	}
	return payload as T
})

// The voice process surface shares this process (and therefore the one UI lock) but not
// this server's port. Only its three scoped routes are mounted through Funnel.
const voiceConfig = readVoiceConfig()
// Stable but useless outside this OpenAI abuse-control header. Hashing the relay
// bearer means neither that bearer nor a device identifier leaves the Mac.
const voiceSafetyIdentifier = crypto.createHash('sha256').update(`conductor-remote:${cfg.token}`).digest('hex')
const voiceBoards = new Map<string, VoiceBriefBoard>()
const voicePreviews = new PreviewStore(path.join(stateDir(), 'voice-previews.json'))
const voiceBroker = voiceConfig.openaiKey
	? new VoiceBroker({
			apiKey: voiceConfig.openaiKey,
			apiOrigin: openAIOriginForSipHost(voiceConfig.sipHost),
			model: voiceConfig.model,
			voice: voiceConfig.voice,
			mcpUrl: voiceConfig.publicBaseUrl ? `${voiceConfig.publicBaseUrl}/mcp` : null,
			mcpToken: voiceConfig.mcpToken,
			stateFile: path.join(stateDir(), 'voice-calls.json'),
			tools: callId => voiceToolsForCall(callId),
			onClose: callId => voiceBoards.delete(callId)
		})
	: null

function voiceBoard(callId: string): VoiceBriefBoard {
	let board = voiceBoards.get(callId)
	if (board) return board
	board = new VoiceBriefBoard({ reads, locked: async () => (await screenLocked()) === true, readPrefs, writePrefs })
	voiceBoards.set(callId, board)
	return board
}

async function dispatchVoicePreview(preview: {
	workspaceId: string
	sessionId: string
	text: string
	token: string
}): Promise<{ ok: boolean; parked?: boolean; error?: string }> {
	const host = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host
	const timeoutMs = 75_000
	const res = await fetch(`http://${host}:${cfg.port}${routes.sendPrompt.path(preview.sessionId)}`, {
		method: routes.sendPrompt.method,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			authorization: `Bearer ${cfg.token}`,
			'content-type': 'application/json',
			'x-relay-client': 'voice',
			'x-client-timeout-ms': String(timeoutMs)
		},
		body: JSON.stringify({
			workspaceId: preview.workspaceId,
			text: preview.text,
			clientId: preview.token
		})
	})
	const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; parked?: boolean; error?: string }
	return {
		ok: payload.ok === true,
		parked: payload.parked === true,
		error: payload.error ?? (!res.ok ? `HTTP ${res.status}` : undefined)
	}
}

function voiceToolsForCall(callId: string) {
	return createVoiceTools({
		callId,
		board: voiceBoard(callId),
		previews: voicePreviews,
		findSession: sessionId => reads.listSessionStates().find(state => state.sessionId === sessionId) ?? null,
		dispatch: dispatchVoicePreview,
		announce: spoken => {
			if (!voiceBroker?.inject(callId, spoken)) console.warn(`[voice] ${callId} could not receive a delivery nudge`)
		}
	})
}

const voiceGateway = createVoiceGateway({
	config: () => voiceConfig,
	broker: () => voiceBroker,
	rpc: (callId, request) => handleRpc(voiceToolsForCall(callId), request)
})
const voiceServer = createVoiceServer({
	routes: voiceGateway,
	mcpToken: () => voiceConfig.mcpToken,
	log: line => console.warn(line)
})

// A windowless Conductor that ignores reopen *and* a Dock click can only be fixed
// by restarting it — and quitting takes any agent mid-turn down with it. So the
// write path may only do that while nothing is working, which is a DB fact, not
// something AppleScript can see. Read fresh each time: a session can start between
// the phone opening the app and the send landing.
setRestartGuard(() => !reads.listWorkspaces().some(w => w.session_status === 'working'))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let uiLeaseRecoveryRunning = false

/**
 * A dead relay can leave its detached, already-authorized GUI helper behind. Keep
 * the old mutex until that exact process group is gone, allow its external event
 * to settle, then let the database CAS create the persistent safety hold.
 */
async function recoverUiLease(): Promise<void> {
	if (!orchestration.writable || uiLeaseRecoveryRunning) return
	uiLeaseRecoveryRunning = true
	try {
		const result = await recoverExpiredUiLease(orchestration, relayIdentity)
		if (result.status === 'external_process_alive') {
			console.warn(
				`[workflow] expired UI helper ${result.owner.externalProcess?.pid ?? 'unknown'} could not be proven dead; retaining its mutex`
			)
		} else if (result.status === 'owned_external_terminated') {
			console.warn(`[workflow] terminated overdue UI helper ${result.owner.externalProcess?.pid ?? 'unknown'}`)
		} else if (result.status === 'reclaimed') {
			console.warn(
				`[workflow] reclaimed expired UI action ${result.owner.actionId}${result.quarantined ? ' into persistent quarantine' : ''}`
			)
		}
	} catch (error) {
		console.error('[workflow] expired UI lease recovery failed:', error)
	} finally {
		uiLeaseRecoveryRunning = false
	}
}

/** Fail closed if another UI-capable relay cannot prove it speaks this protocol. */
async function workflowCompatibilityError(): Promise<string | null> {
	if (!orchestration.writable) {
		return `Workflow is disabled because ${orchestrationUnavailableReason()}.`
	}
	try {
		const processes = await listUiCapableRelayProcesses()
		const incompatible = incompatibleRelayProcesses(
			processes,
			orchestration.listRelayInstances(),
			ORCHESTRATION_PROTOCOL_VERSION
		)
		if (!incompatible.length) return null
		return `Workflow needs every live conductor-remote UI relay on protocol ${ORCHESTRATION_PROTOCOL_VERSION}. Stop incompatible PID${incompatible.length === 1 ? '' : 's'} ${incompatible.map(process => process.pid).join(', ')} and try again.`
	} catch (error) {
		return `Workflow could not verify the live relay processes: ${error instanceof Error ? error.message : String(error)}`
	}
}

/**
 * A deep link has no request id to correlate with the workspace row it creates. Keep
 * relay-originated creations single-flight until that row appears, or two simultaneous
 * requests can each claim the other's workspace. Manual desktop creation can still
 * happen in the gap, so callers also narrow the fresh row to the requested repo.
 */
let workspaceCreationTail = Promise.resolve()

async function createWorkspaceAndRead(
	prompt: string,
	repoPath: string | null,
	repoName?: string,
	strictUnique = false
): Promise<{ result: SendResult; created?: Workspace }> {
	const previous = workspaceCreationTail
	let release: () => void = () => {}
	workspaceCreationTail = new Promise<void>(resolve => {
		release = resolve
	})
	await previous
	try {
		const before = new Set(reads.listWorkspaces().map(w => w.id))
		const result = await createWorkspace(prompt, repoPath)
		if (!result.ok) return { result }
		// The deep link is fire-and-forget, so the new row is the only proof it worked.
		// Creating a worktree takes a beat longer than opening a chat does.
		for (let attempt = 0; attempt < 40; attempt++) {
			await sleep(500)
			const candidates = reads
				.listWorkspaces()
				.filter(workspace => !before.has(workspace.id) && (!repoName || workspace.repo_name === repoName))
			if (strictUnique && candidates.length > 1) return { result }
			if (candidates[0]) return { result, created: candidates[0] }
		}
		return { result }
	} finally {
		release()
	}
}

/**
 * Has Conductor taken ownership of the prompt yet? The receipt everything below is
 * built on. The AppleScript actuator reports `ok` on `osascript` exit 0 — which only
 * means the script *ran*, not that Conductor accepted the keystrokes — so without
 * this a dropped send (asleep/unfocused Mac) looks delivered. A prompt accepted into
 * Conductor's durable outbox also counts, before it becomes a transcript row.
 */
function deliveredSince(sessionId: string, text: string, since: DeliveryCursor): boolean {
	return reads.promptDeliveredSince(sessionId, text, since)
}

function deliveredRowSince(sessionId: string, text: string, sinceRowid: number): number | null {
	const target = text.trim()
	const { entries } = reads.getMessages(sessionId, sinceRowid)
	return entries.find(e => e.role === 'user' && e.text.trim() === target)?.rowid ?? null
}

/**
 * Watch for that row, ending on a check rather than a sleep, and never past
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
async function confirmDeliveryRow(
	sessionId: string,
	text: string,
	sinceRowid: number,
	budgetDeadline: number
): Promise<number | null> {
	const stopAt = Math.min(Date.now() + CONFIRM_WINDOW_MS, budgetDeadline)
	for (;;) {
		const rowid = deliveredRowSince(sessionId, text, sinceRowid)
		if (rowid !== null) return rowid
		if (Date.now() >= stopAt) return null
		await sleep(300)
	}
}

async function confirmDelivery(
	sessionId: string,
	text: string,
	since: DeliveryCursor,
	budgetDeadline: number
): Promise<boolean> {
	const stopAt = Math.min(Date.now() + CONFIRM_WINDOW_MS, budgetDeadline)
	for (;;) {
		if (deliveredSince(sessionId, text, since)) return true
		if (Date.now() >= stopAt) return false
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
 * the PWA's by hand wouldn't hold — the relay updates itself (autoupdate.ts) while
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
	queue = false
): Promise<SendResult & { attempts: number }> {
	const located = locateChat(ws, sessionId)
	if ('error' in located) return { ok: false, strategy: actuator.name, attempts: 0, error: located.error }
	// Snapshot the transcript cursor and outbox ids once: every check below asks "did
	// *this* prompt arrive since we started", so a retry can't be fooled by an older
	// identical prompt moving from the outbox into a new transcript row.
	const before = reads.deliveryCursor(sessionId)
	const label = ws.branch ?? ws.id
	const deadline = Date.now() + budgetMs
	let attempts = 0
	let last: SendResult = { ok: false, strategy: actuator.name }
	for (;;) {
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
			? deliveredSince(sessionId, text, before)
			: await confirmDelivery(sessionId, text, before, deadline)
		if (landed) {
			if (attempts > 1) console.info(`[relay] send to ${label} landed on attempt ${attempts}`)
			return { ok: true, strategy: last.strategy, attempts }
		}
		if (retryWontHelp(last.error)) break
		// A locked screen isn't worth the rest of the budget either — but for the
		// opposite reason: the parked-prompt queue (src/parked.ts) waits it out far
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
		? `Send didn’t land in the chat — Conductor may have been asleep or unfocused${tried}. Try again.`
		: `${last.error}${tried}`
	console.warn(`[relay] send to ${label} failed after ${attempts} attempt(s): ${error}`)
	return { ok: false, strategy: last.strategy, attempts, error }
}

/**
 * Undelivered first prompts, owned by this process rather than by the phone (see
 * firstprompt.ts for why). Everything Conductor-side it needs is a plain DB read.
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

function referencedStagedAttachments(): Set<string> {
	const referenced = new Set<string>()
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

function delegationError(code: DelegationError['code'], error: string, retryable = true): DelegationActionError {
	const clean = withoutWindowEvidence(error)
	if (clean !== error) console.warn(`[relay] ${error}`)
	return { ok: false, code, error: clean, retryable, blocked: lockBlocked(error) || uiBusy(error) }
}

function wireAttachment(written: ReturnType<typeof writeAttachment>): Attachment {
	return {
		name: written.name,
		path: written.relPath,
		bytes: written.bytes,
		token: written.token
	}
}

/** Write the frozen parent transcript cut before opening its child tab. */
function delegationHandoff(job: PersistedDelegation, ws: Workspace): Attachment {
	if (!ws.worktree) throw new Error('worktree path unresolved')
	const source = reads.getSession(job.parentSessionId)
	if (!source) throw new Error('parent chat not found in that workspace')
	const { entries } = reads.getMessages(job.parentSessionId)
	const cut = job.throughRowid === undefined ? { entries, later: 0 } : transcriptThrough(entries, job.throughRowid)
	if (!cut) throw new Error('the requested handoff message is not in the parent chat')
	const rendered = renderTranscript(cut.entries, { thinking: job.includeThinking, tools: false })
	if (!rendered.kept) throw new Error('the parent chat has nothing to hand off yet')
	const title = source.title?.trim() || 'chat'
	const header = [
		`# Transcript of ${title}`,
		'',
		[ws.repo_name, ws.branch].filter(Boolean).join(' · '),
		`Delegation ${job.id} copied this chat through ${job.throughRowid ?? 'its latest row'}.`,
		cut.later ? `${cut.later} later ${cut.later === 1 ? 'entry is' : 'entries are'} intentionally omitted.` : '',
		'',
		''
	]
		.filter((line, index) => line || index < 2 || index >= 5)
		.join('\n')
	return wireAttachment(writeAttachment(ws.worktree, `Transcript of ${title}.md`, header + rendered.text))
}

async function openDelegation(job: PersistedDelegation) {
	const ws = reads.getWorkspace(job.workspaceId)
	if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
	if (!ws.worktree) return delegationError('worktree_unavailable', 'worktree path unresolved', false)
	if ((await screenLocked()) === true) {
		return delegationError('opening_failed', 'The Mac is locked — unlock it and try again.')
	}
	let handoff: Attachment
	try {
		handoff = delegationHandoff(job, ws)
	} catch (err) {
		return delegationError('opening_failed', err instanceof Error ? err.message : String(err), false)
	}
	const opened = await withUiPriority('background', () => openChat(ws))
	if ('error' in opened) {
		return delegationError(
			'opening_failed',
			opened.result.error ?? 'Conductor did not open a child chat',
			opened.retryable !== false
		)
	}
	if (!opened.sessionId)
		return delegationError('opening_failed', 'Conductor opened a tab but did not record its chat id', false)
	return { ok: true as const, childSessionId: opened.sessionId, handoff }
}

async function configureDelegation(job: PersistedDelegation) {
	const ws = reads.getWorkspace(job.workspaceId)
	if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
	if (!job.childSessionId) return delegationError('state_invalid', 'the delegated child id is missing', false)
	const before = reads.getSession(job.childSessionId)
	if (!before) return delegationError('session_not_found', 'the delegated child chat is gone', false)
	const applied = await withUiPriority('background', () =>
		applyAgentPatch(ws, job.childSessionId as string, {
			model: job.resolvedRole.model,
			effort: job.resolvedRole.effort,
			fast: job.resolvedRole.fast
		})
	)
	if (!applied.ok) return delegationError('configuration_failed', applied.error ?? 'agent configuration did not stick')
	const after = reads.getSession(job.childSessionId)
	if (!after) return delegationError('session_not_found', 'the configured child chat disappeared', false)
	if (after.agent_type !== job.resolvedRole.agentType) {
		return delegationError(
			'configuration_failed',
			`Conductor recorded provider ${after.agent_type ?? 'unknown'}, not ${job.resolvedRole.agentType}`
		)
	}
	return { ok: true as const }
}

function delegatedPrompt(job: PersistedDelegation): string {
	const handoff = job.handoff
	if (!handoff) throw new Error('the delegated handoff is missing')
	const task = attachmentPrompt(handoff.token, job.prompt)
	return job.resolvedRole.preamble?.trim() ? `${job.resolvedRole.preamble.trim()}\n\n${task}` : task
}

async function sendDelegation(job: PersistedDelegation) {
	const ws = reads.getWorkspace(job.workspaceId)
	if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
	if (!job.childSessionId) return delegationError('state_invalid', 'the delegated child id is missing', false)
	let text: string
	try {
		text = delegatedPrompt(job)
	} catch (err) {
		return delegationError('state_invalid', err instanceof Error ? err.message : String(err), false)
	}
	const cursor = reads.getMessages(job.childSessionId).cursor
	const result = await withUiPriority('background', () => deliverPrompt(ws, job.childSessionId as string, text))
	if (!result.ok) return delegationError('send_failed', result.error ?? 'the delegated prompt did not land')
	const sentRowid = deliveredRowSince(job.childSessionId, text, cursor)
	if (sentRowid === null) return delegationError('send_failed', 'the delegated prompt has no transcript receipt')
	return { ok: true as const, sentRowid }
}

function delegationCompletion(job: PersistedDelegation) {
	if (!job.childSessionId || job.sentRowid === undefined) return null
	const child = reads.getSession(job.childSessionId)
	if (!child) {
		return {
			outcome: { kind: 'error' as const, error: 'the delegated child chat disappeared' }
		}
	}
	const assistants = reads
		.getMessages(job.childSessionId, job.sentRowid)
		.entries.filter(entry => entry.role === 'assistant' && entry.text.trim())
	const last = assistants.at(-1)
	if (child.status === 'error') {
		return {
			outcome: {
				kind: 'error' as const,
				error: 'the delegated agent stopped with an error',
				...(last ? { assistantRowid: last.rowid, text: last.text.trim() } : {})
			},
			...(last ? { completionRowid: last.rowid } : {})
		}
	}
	if (child.status !== 'idle' || child.background_tasks.length || !last) return null
	return {
		outcome: { kind: 'success' as const, assistantRowid: last.rowid, text: last.text.trim() },
		completionRowid: last.rowid
	}
}

/** Keep the structured Baton tail when present; otherwise the complete answer is the Baton. */
function batonText(text: string): string {
	const match = /^## Baton\b/im.exec(text)
	return match ? text.slice(match.index).trim() : text.trim()
}

function delegationReturnAttachment(job: PersistedDelegation, ws: Workspace): Attachment {
	if (!ws.worktree || !job.childSessionId || job.sentRowid === undefined) throw new Error('return state is incomplete')
	const rendered = renderTranscript(reads.getMessages(job.childSessionId, job.sentRowid).entries, {
		thinking: true,
		tools: false
	})
	const outcomeText = job.outcome
		? job.outcome.kind === 'success'
			? job.outcome.text
			: (job.outcome.text ?? job.outcome.error)
		: '(no transcript prose)'
	const body = [
		`# Delegated ${job.role} result`,
		'',
		`Delegation: ${job.id}`,
		`Child chat: ${job.childSessionId}`,
		'',
		rendered.text || outcomeText
	].join('\n')
	return wireAttachment(writeAttachment(ws.worktree, `Delegated ${job.role} result.md`, body))
}

function delegationReturnText(job: PersistedDelegation, attachment: Attachment): string {
	if (!job.outcome) throw new Error('the delegated outcome is missing')
	const result =
		job.outcome.kind === 'success' ? batonText(job.outcome.text) : batonText(job.outcome.text ?? job.outcome.error)
	const verb = job.outcome.kind === 'success' ? 'completed' : 'failed'
	return [`Delegated ${job.role} task ${job.id} ${verb}.`, '', result, '', attachment.token].join('\n')
}

async function returnDelegation(job: PersistedDelegation) {
	const ws = reads.getWorkspace(job.workspaceId)
	if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
	if (!reads.getSession(job.parentSessionId)) {
		return delegationError('session_not_found', 'the parent chat is gone', false)
	}
	if (job.returnCursor !== undefined) {
		if (!job.returnAttachment || !job.returnText) {
			return delegationError('state_invalid', 'the queued return receipt state is incomplete', false)
		}
		const rowid = deliveredRowSince(job.parentSessionId, job.returnText, job.returnCursor)
		return rowid === null
			? {
					ok: true as const,
					pending: true as const,
					returnCursor: job.returnCursor,
					returnAttachment: job.returnAttachment,
					returnText: job.returnText
				}
			: { ok: true as const, returnRowid: rowid }
	}

	let attachment: Attachment
	let text: string
	try {
		attachment = delegationReturnAttachment(job, ws)
		text = delegationReturnText(job, attachment)
	} catch (err) {
		return delegationError('return_failed', err instanceof Error ? err.message : String(err), false)
	}
	const cursor = reads.getMessages(job.parentSessionId).cursor
	if (job.returnMode === 'steer') {
		const result = await withUiPriority('background', () =>
			deliverPrompt(ws, job.parentSessionId, text, SEND_BUDGET_MS, false)
		)
		if (!result.ok) return delegationError('return_failed', result.error ?? 'the delegated result did not return')
		const rowid = deliveredRowSince(job.parentSessionId, text, cursor)
		return rowid === null
			? delegationError('return_failed', 'the delegated result has no transcript receipt')
			: { ok: true as const, returnRowid: rowid }
	}

	const located = locateChat(ws, job.parentSessionId)
	if ('error' in located) return delegationError('return_failed', located.error, false)
	const result = await withUiPriority('background', () =>
		actuator.send({ workspace: ws, sessionId: job.parentSessionId, tab: located.tab }, text, {
			deadline: Date.now() + SEND_BUDGET_MS,
			queue: true
		})
	)
	const immediate = deliveredRowSince(job.parentSessionId, text, cursor)
	if (immediate !== null) return { ok: true as const, returnRowid: immediate }
	if (!result.ok) {
		const late = await confirmDeliveryRow(job.parentSessionId, text, cursor, Date.now() + CONFIRM_WINDOW_MS)
		if (late !== null) return { ok: true as const, returnRowid: late }
		return delegationError('return_failed', result.error ?? 'Conductor did not accept the queued result')
	}
	return {
		ok: true as const,
		pending: true as const,
		returnCursor: cursor,
		returnAttachment: attachment,
		returnText: text
	}
}

const delegationQueue = new DelegationQueue(
	{
		open: openDelegation,
		configure: configureDelegation,
		send: sendDelegation,
		completion: delegationCompletion,
		returnResult: returnDelegation
	},
	{
		blockedError: error => error instanceof UiBusyError
	}
)

sessionPoller.subscribe(() => {
	void delegationQueue.wake()
})

function projectDelegation(job: PersistedDelegation): DelegationProjection {
	return {
		id: job.id,
		workspaceId: job.workspaceId,
		parentSessionId: job.parentSessionId,
		...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
		role: job.role,
		resolvedRole: job.resolvedRole,
		prompt: job.prompt,
		returnMode: job.returnMode,
		status: job.status,
		attempts: job.attempts,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		...(job.outcome ? { outcome: job.outcome } : {}),
		...(job.failure ? { failure: job.failure } : {})
	}
}

function attachDelegationState(workspaces: Workspace[]): void {
	for (const ws of workspaces) {
		const store = delegationStore(ws)
		if (!store) continue
		const listed = store.list()
		const jobs = listed.jobs.filter(job => job.status !== 'returned').map(projectDelegation)
		const roles = store.sessionRoles()
		if (jobs.length) Object.assign(ws, { delegations: jobs })
		if (Object.keys(roles.sessions).length) Object.assign(ws, { session_roles: roles.sessions })
		const warnings = [...listed.warnings.map(warning => `${warning.file}: ${warning.message}`)]
		if (roles.warning) warnings.push(`sessions.json: ${roles.warning}`)
		if (warnings.length) Object.assign(ws, { delegation_warning: warnings.join('; ') })
	}
}

/** Keep process identity and raw recovery evidence private; the phone only needs the hold and its cause. */
function wireUiQuarantine(): UiQuarantineWire | undefined {
	if (!orchestration.writable) return undefined
	const quarantine = orchestration.getUiQuarantine()
	if (!quarantine.active) return undefined
	const bounded = (value: string, maximum: number) =>
		withoutWindowEvidence(scrubWorkflowSecrets(value)).slice(0, maximum)
	return {
		active: true,
		reason: bounded(
			quarantine.reason ??
				'A previous automated Conductor UI action may have completed without a confirmed receipt. Inspect Conductor before continuing.',
			500
		),
		createdAt: quarantine.createdAt ?? 0,
		...(quarantine.actionId ? { actionId: bounded(quarantine.actionId, 256) } : {}),
		...(quarantine.effectId ? { effectId: bounded(quarantine.effectId, 256) } : {})
	}
}

function workflowJobStatus(state: ReturnType<typeof orchestration.listWorkflowJobs>[number]['state']) {
	if (state === 'owned') return 'opening' as const
	if (state === 'dormant') return 'queued' as const
	if (state === 'cancelled') return 'failed' as const
	return state
}

function projectWorkflowDelegation(
	workflow: WorkflowRunWire,
	job: ReturnType<typeof orchestration.listWorkflowJobs>[number]
): DelegationProjection | null {
	if (!workflow.workspaceId || job.state === 'cancelled') return null
	return {
		id: job.id,
		workflowId: workflow.id,
		logicalKey: job.logicalKey,
		bootstrap: job.logicalKey === 'explore:0',
		workspaceId: workflow.workspaceId,
		parentSessionId: workflow.rootSessionId ?? '',
		...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
		role: job.role,
		// The immutable preamble remains coordinator-private. Only the public picker
		// settings are useful for role chips and list_delegations.
		resolvedRole: {
			agentType: job.resolvedRole.agentType,
			model: job.resolvedRole.model,
			...(job.resolvedRole.effort ? { effort: job.resolvedRole.effort } : {}),
			...(job.resolvedRole.fast === undefined ? {} : { fast: job.resolvedRole.fast })
		},
		prompt: scrubWorkflowSecrets(job.prompt).slice(0, 500),
		returnMode: 'queue',
		status: workflowJobStatus(job.state),
		attempts: job.attemptCount,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		...(job.state === 'failed'
			? {
					failure: {
						code: 'workflow_blocked' as const,
						message: workflow.error?.message ?? 'Workflow job failed.',
						retryable: workflow.actions.canRetry
					}
				}
			: {})
	}
}

/** Attach only bounded, scrubbed navigation state; capabilities and internal effect evidence stay in SQLite. */
type WorkflowAttachedWorkspace = Workspace &
	Pick<WireWorkspace, 'delegations' | 'session_roles' | 'workflow' | 'workflow_identity' | 'delegation_warning'>

function attachWorkflowState(workspaces: WorkflowAttachedWorkspace[]): WorkflowRunWire[] {
	if (!orchestration.writable) return []
	const projections = orchestration.listWorkflowProjections()
	const byWorkspace = new Map(workspaces.map(workspace => [workspace.id, workspace]))
	for (const workflow of projections) {
		if (!workflow.workspaceId) continue
		const workspace = byWorkspace.get(workflow.workspaceId)
		if (!workspace) continue
		const run = orchestration.getWorkflowRun(workflow.id)
		if (!run) continue
		const jobs = orchestration
			.listWorkflowJobs(workflow.id)
			.flatMap(job => projectWorkflowDelegation(workflow, job) ?? [])
		workspace.delegations = [...(workspace.delegations ?? []), ...jobs]
		workspace.session_roles = { ...(workspace.session_roles ?? {}) }
		if (workflow.rootSessionId) {
			workspace.session_roles[workflow.rootSessionId] = {
				role: 'planning',
				workflowId: workflow.id,
				assignedAt: workflow.createdAt
			}
		}
		for (const job of orchestration.listWorkflowJobs(workflow.id)) {
			if (!job.childSessionId) continue
			workspace.session_roles[job.childSessionId] = {
				role: job.role,
				delegationId: job.id,
				workflowId: workflow.id,
				assignedAt: job.createdAt
			}
		}
		// Compatibility for cached clients that only understand one workspace-level run.
		if (!workspace.workflow || workflow.rootSessionId === workspace.active_session_id) workspace.workflow = workflow
	}
	// A terminal run leaves the active Workflow list but not the workspace's identity.
	// Attach only the newest historical projection when no live run already won above;
	// its frozen public roles let the sidebar remain truthful after role settings change.
	const historicalWorkspaceIds = [...byWorkspace.values()]
		.filter(workspace => !workspace.workflow)
		.map(workspace => workspace.id)
	for (const workflow of orchestration.listLatestWorkflowProjectionsForWorkspaces(historicalWorkspaceIds)) {
		if (!workflow.workspaceId) continue
		const workspace = byWorkspace.get(workflow.workspaceId)
		if (workspace && !workspace.workflow) {
			workspace.workflow_identity = {
				id: workflow.id,
				phase: workflow.phase,
				roles: workflow.roles
			}
		}
	}
	return projections
}

function workflowOwningSession(sessionId: string) {
	if (!orchestration.writable) return null
	for (const projection of orchestration.listWorkflowProjections()) {
		if (projection.rootSessionId === sessionId) return projection
		if (orchestration.listWorkflowJobs(projection.id).some(job => job.childSessionId === sessionId)) return projection
	}
	return null
}

function workflowFrozenError(sessionId: string): { error: { code: string; message: string; retryable: false } } | null {
	const workflow = workflowOwningSession(sessionId)
	if (!workflow) return null
	return {
		error: {
			code: 'workflow_role_frozen',
			message: `Workflow ${workflow.id} froze this chat's model, effort, and Fast setting at Start.`,
			retryable: false
		}
	}
}

function intakeError(code: DelegationError['code'], message: string, retryable = false): DelegateTaskResult {
	return { ok: false, error: { code, message, retryable } }
}

function workflowHttpError(
	error: unknown
): { status: number; error: { code: string; message: string; retryable: boolean } } | null {
	if (error instanceof WorkflowRequestError || error instanceof WorkflowGuardError) {
		return { status: error.status, error: { code: error.code, message: error.message, retryable: false } }
	}
	if (error instanceof WorkflowCoordinatorError) {
		return {
			status: error.status,
			error: { code: error.code, message: error.message, retryable: error.retryable }
		}
	}
	if (error instanceof IdempotencyConflictError) {
		return {
			status: 409,
			error: { code: 'idempotency_conflict', message: error.message, retryable: false }
		}
	}
	if (error instanceof WorkflowTransitionError) {
		return {
			status: 409,
			error: { code: 'workflow_phase_invalid', message: error.message, retryable: false }
		}
	}
	return null
}

async function workflowRequestBody(req: http.IncomingMessage): Promise<unknown> {
	try {
		return JSON.parse((await readBody(req)) || '{}') as unknown
	} catch {
		throw new WorkflowRequestError('Workflow request body must be valid JSON.')
	}
}

/**
 * One prompt per tap, however many requests carry it (src/sendonce.ts). Keyed on the
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
 * (see parked.ts for why the phone can't wait this out itself).
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

interface WorkflowWorkspaceBaseline {
	kind: 'workspace_ids'
	repo: string
	workspaceIds: string[]
}

interface WorkflowSessionBaseline {
	kind: 'session_ids'
	workspaceId: string
	sessionIds: string[]
}

function workflowDeliveryCursor(sessionId: string): WorkflowDeliveryCursor {
	const cursor = reads.deliveryCursor(sessionId)
	return { rowid: cursor.rowid, outboxIds: [...cursor.outboxIds].sort() }
}

function readsDeliveryCursor(value: unknown): DeliveryCursor | null {
	if (!value || typeof value !== 'object') return null
	const cursor = value as { rowid?: unknown; outboxIds?: unknown }
	if (!Number.isSafeInteger(cursor.rowid) || !Array.isArray(cursor.outboxIds)) return null
	if (cursor.outboxIds.some(id => typeof id !== 'string')) return null
	return { rowid: cursor.rowid as number, outboxIds: new Set(cursor.outboxIds as string[]) }
}

function workspaceBaseline(value: unknown): WorkflowWorkspaceBaseline | null {
	if (!value || typeof value !== 'object') return null
	const baseline = value as Partial<WorkflowWorkspaceBaseline>
	return baseline.kind === 'workspace_ids' &&
		typeof baseline.repo === 'string' &&
		Array.isArray(baseline.workspaceIds) &&
		baseline.workspaceIds.every(id => typeof id === 'string')
		? (baseline as WorkflowWorkspaceBaseline)
		: null
}

function sessionBaseline(value: unknown): WorkflowSessionBaseline | null {
	if (!value || typeof value !== 'object') return null
	const baseline = value as Partial<WorkflowSessionBaseline>
	return baseline.kind === 'session_ids' &&
		typeof baseline.workspaceId === 'string' &&
		Array.isArray(baseline.sessionIds) &&
		baseline.sessionIds.every(id => typeof id === 'string')
		? (baseline as WorkflowSessionBaseline)
		: null
}

function workflowRootInspection(ws: Workspace, session: SessionRow): WorkflowRootInspection {
	const cursor = workflowDeliveryCursor(session.id)
	const userRows = reads.getMessages(session.id).entries.filter(entry => entry.role === 'user')
	const firstPrompt = firstPrompts.list().some(entry => entry.workspaceId === ws.id)
	const parked = parkedPrompts.list().some(entry => entry.sessionId === session.id)
	const reasons = [
		session.status !== 'idle' ? `the chat status is ${session.status ?? 'unknown'}, not idle` : '',
		session.background_tasks.length ? 'the chat is waiting on a background task' : '',
		session.last_user_message_at ? 'the chat already has a user message timestamp' : '',
		userRows.length ? 'the chat already has a user message' : '',
		cursor.outboxIds.length ? 'the chat already has a queued prompt' : '',
		firstPrompt ? 'the workspace already has a pending first prompt' : '',
		parked ? 'the chat already has a parked prompt' : ''
	].filter(Boolean)
	return {
		workspaceId: ws.id,
		rootSessionId: session.id,
		pristine: reasons.length === 0,
		pristineEvidence: {
			status: session.status,
			backgroundTasks: session.background_tasks.length,
			lastUserMessageAt: session.last_user_message_at,
			userRows: userRows.length,
			outboxRows: cursor.outboxIds.length,
			firstPrompt,
			parked
		},
		deliveryCursor: cursor,
		...(reasons.length ? { reason: `Workflow requires a pristine root: ${reasons.join('; ')}.` } : {})
	}
}

function assertWorkflowRootStillPristine(run: WorkflowRunRecord, expectedSessionId: string): void {
	const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
	const session = reads.getSession(expectedSessionId)
	if (
		!ws ||
		!run.rootSessionId ||
		run.rootSessionId !== expectedSessionId ||
		!session ||
		reads.sessionWorkspaceId(expectedSessionId) !== ws.id
	) {
		throw new WorkflowCoordinatorError(
			'workflow_root_not_pristine',
			'The exact Workflow root binding changed before its first prompt could be dispatched.'
		)
	}
	const inspection = workflowRootInspection(ws, session)
	if (!inspection.pristine) {
		throw new WorkflowCoordinatorError(
			'workflow_root_not_pristine',
			inspection.reason ?? 'Workflow requires a pristine root chat.'
		)
	}
}

function sessionMatchesWorkflowRole(session: SessionRow, role: FrozenWorkflowRole): boolean {
	const selected = modelLabel(session.model, [role.model]).toLowerCase()
	const wanted = role.model.toLowerCase()
	return (
		session.agent_type === role.agentType &&
		(selected === wanted || selected.startsWith(wanted)) &&
		(role.effort === undefined || session.claude_effort_level === role.effort) &&
		(role.fast === undefined || Boolean(session.fast_mode) === role.fast)
	)
}

function stableWorkflowAttachment(worktree: string, jobId: string, name: string, body: string): string {
	// Conductor requires six alphanumerics. Preserve all six characters' entropy
	// instead of truncating a hex digest to only 24 bits for a long-lived stable path.
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	const digest = crypto.createHash('sha256').update(`workflow-handoff:${jobId}`).digest()
	const id = Array.from(digest.subarray(0, 6), byte => alphabet[byte % alphabet.length]).join('')
	const safeName = attachmentName(name)
	const directory = path.join(worktree, ATTACHMENT_DIR, id)
	const destination = path.join(directory, safeName)
	fs.mkdirSync(directory, { recursive: true })
	try {
		fs.writeFileSync(destination, body, { flag: 'wx' })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		if (fs.readFileSync(destination, 'utf8') !== body) {
			throw new Error(`the stable Workflow handoff path ${path.join(ATTACHMENT_DIR, id, safeName)} is occupied`)
		}
	}
	return attachmentToken(safeName, path.join(ATTACHMENT_DIR, id, safeName))
}

function workflowWorkspaceCandidate(ws: Workspace) {
	return {
		id: ws.id,
		title: workspaceTitle(ws),
		repo: ws.repo_name ?? '',
		createdAt: timestampMs(ws.created_at),
		kind: 'workspace' as const
	}
}

function workflowSessionCandidate(ws: Workspace, session: SessionRow) {
	return {
		id: session.id,
		title: session.title?.trim() || '(untitled chat)',
		repo: ws.repo_name ?? '',
		createdAt: timestampMs(session.created_at),
		kind: 'session' as const
	}
}

function workflowSessionId(effect: WorkflowEffectCall['effect']): string | null {
	if (!effect.target || typeof effect.target !== 'object') return null
	const id = (effect.target as { sessionId?: unknown }).sessionId
	return typeof id === 'string' ? id : null
}

function workflowEffectPrompt(effect: WorkflowEffectCall['effect']): string | null {
	if (!effect.inputs || typeof effect.inputs !== 'object') return null
	const prompt = (effect.inputs as { prompt?: unknown }).prompt
	return typeof prompt === 'string' ? prompt : null
}

function workflowEffectMarker(effect: WorkflowEffectCall['effect']): string | null {
	if (!effect.inputs || typeof effect.inputs !== 'object') return null
	const marker = (effect.inputs as { correlationMarker?: unknown }).correlationMarker
	return typeof marker === 'string' ? marker : null
}

function withWorkflowEffectGate<T>(call: WorkflowEffectCall, operation: () => Promise<T>): Promise<T> {
	return call.dispatch.mode === 'gated_child'
		? withGatedUiCommand(call.dispatch.gatedProcessReady, () => uiTurn(operation))
		: uiTurn(operation)
}

async function sendWorkflowPrompt(
	call: WorkflowEffectCall & { sessionId: string; text: string },
	queue: boolean
): Promise<DeliveryReceipt> {
	const ws = call.run.workspaceId ? reads.getWorkspace(call.run.workspaceId) : null
	if (!ws || reads.sessionWorkspaceId(call.sessionId) !== ws.id) {
		throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow destination chat is unavailable.', {
			status: 404
		})
	}
	const before = readsDeliveryCursor(call.effect.cursor) ?? reads.deliveryCursor(call.sessionId)
	const result = await withWorkflowEffectGate(call, async () => {
		if (actuator.name !== 'sidecar') return deliverPrompt(ws, call.sessionId, call.text, SEND_BUDGET_MS, queue)
		const located = locateChat(ws, call.sessionId)
		if ('error' in located) return { ok: false, strategy: actuator.name, attempts: 0, error: located.error }
		const sent = await actuator.send({ workspace: ws, sessionId: call.sessionId, tab: located.tab }, call.text, {
			queue
		})
		if (!sent.ok) return { ...sent, attempts: 1 }
		const landed = await confirmDelivery(call.sessionId, call.text, before, Date.now() + CONFIRM_WINDOW_MS)
		return landed
			? { ...sent, attempts: 1 }
			: {
					ok: false,
					strategy: sent.strategy,
					attempts: 1,
					error: 'Conductor did not record the sidecar Workflow prompt; automatic replay is disabled.'
				}
	})
	const receipt = reads.deliveryReceiptSince(call.sessionId, call.text, before)
	if (receipt) return receipt
	throw new WorkflowCoordinatorError(
		'workflow_effect_failed',
		result.error ?? 'Conductor did not record an accepted Workflow prompt.',
		{ retryable: !retryWontHelp(result.error) }
	)
}

const workflowCoordinator = orchestration.writable
	? new WorkflowCoordinator(orchestration, relayIdentity, {
			captureWorkspaceBaseline: async repoName => {
				const repo = reads.listRepos().find(candidate => candidate.name === repoName)
				if (!repo) {
					throw new WorkflowCoordinatorError('workflow_not_found', `Unknown repo ${repoName}.`, { status: 404 })
				}
				if (!repo.root_path) {
					throw new WorkflowCoordinatorError('invalid_request', `${repo.name} has no checkout path.`)
				}
				return {
					kind: 'workspace_ids',
					repo: repo.name,
					workspaceIds: reads
						.listWorkspaces()
						.filter(workspace => workspace.repo_name === repo.name)
						.map(workspace => workspace.id)
						.sort()
				} satisfies WorkflowWorkspaceBaseline
			},
			inspectExistingRoot: async target => {
				const ws = reads.getWorkspace(target.workspaceId)
				if (!ws || reads.sessionWorkspaceId(target.sessionId) !== ws.id) return null
				const session = reads.getSession(target.sessionId)
				return session ? workflowRootInspection(ws, session) : null
			},
			bindCreatedRoot: async ({ run, workspaceId }) => {
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) return null
				if (run.target.kind !== 'new_workspace') return null
				if (!run.target.sendImmediately && ws.state !== 'ready') return null
				const sessions = reads.listSessions(workspaceId)
				if (!sessions.length) return null
				const session = sessions.find(candidate => candidate.id === ws.active_session_id) ?? sessions[0]
				if (sessions.length !== 1) {
					const inspection = workflowRootInspection(ws, session)
					return { ...inspection, pristine: false, reason: 'The created workspace has more than one root candidate.' }
				}
				const stageIds = stagedAttachmentIdsInObjective(run.objective)
				if (stageIds.length) {
					if (!ws.worktree) return null
					try {
						materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, ws.worktree, stageIds)
					} catch (error) {
						const inspection = workflowRootInspection(ws, session)
						return {
							...inspection,
							pristine: false,
							reason: error instanceof Error ? error.message : 'The Workflow attachments could not be materialized.'
						}
					}
				}
				return workflowRootInspection(ws, session)
			},
			createWorkspace: call =>
				withWorkflowEffectGate(call, async () => {
					const { target } = call
					const repo = reads.listRepos().find(candidate => candidate.name === target.repo)
					if (!repo) {
						throw new WorkflowCoordinatorError('workflow_not_found', `Unknown repo ${target.repo}.`, { status: 404 })
					}
					if (!repo.root_path)
						throw new WorkflowCoordinatorError('invalid_request', `${repo.name} has no checkout path.`)
					const { result, created } = await createWorkspaceAndRead('', repo.root_path, repo.name, true)
					if (!result.ok) {
						throw new WorkflowCoordinatorError('workflow_effect_failed', result.error ?? 'Workspace creation failed.', {
							retryable: !retryWontHelp(result.error)
						})
					}
					if (!created) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							'Conductor accepted the workspace link but no exact workspace row appeared.',
							{ retryable: true }
						)
					}
					return { workspaceId: created.id }
				}),
			configureSession: call =>
				withWorkflowEffectGate(call, async () => {
					const { run, sessionId, role } = call
					const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
					if (!ws || reads.sessionWorkspaceId(sessionId) !== ws.id) {
						throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow chat is unavailable.', {
							status: 404
						})
					}
					const applied = await applyAgentPatch(ws, sessionId, {
						model: role.model,
						...(role.effort === undefined ? {} : { effort: role.effort }),
						...(role.fast === undefined ? {} : { fast: role.fast })
					})
					if (!applied.ok) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							applied.error ?? 'Conductor rejected the frozen role settings.'
						)
					}
					const session = reads.getSession(sessionId)
					if (!session || !sessionMatchesWorkflowRole(session, role)) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							'Conductor no longer matches every frozen role setting; no fallback was selected.'
						)
					}
					return {
						sessionId,
						agentType: session.agent_type,
						model: role.model,
						effort: session.claude_effort_level,
						fast: Boolean(session.fast_mode)
					}
				}),
			openChild: async call => {
				const { run } = call
				const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
				if (!ws)
					throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow workspace is unavailable.', {
						status: 404
					})
				// A lock probe is read-only and happens before the durable dispatch boundary.
				// Otherwise a locked Mac would quarantine an effect whose child tab was never attempted.
				if ((await screenLocked()) === true) {
					throw new WorkflowCoordinatorError(
						'workflow_effect_failed',
						'The Mac is locked — unlock it and retry Workflow.'
					)
				}
				return withWorkflowEffectGate(call, async () => {
					const opened = await openChat(ws)
					if ('error' in opened) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							opened.result.error ?? 'Conductor did not open a tracked child chat.',
							{ retryable: opened.retryable !== false }
						)
					}
					if (!opened.sessionId) {
						throw new WorkflowCoordinatorError(
							'workflow_effect_failed',
							'Conductor opened a child tab but did not record its exact session ID.'
						)
					}
					return { sessionId: opened.sessionId }
				})
			},
			captureSessionBaseline: async workspaceId => {
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) {
					throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow workspace is unavailable.', {
						status: 404
					})
				}
				return {
					kind: 'session_ids',
					workspaceId,
					sessionIds: reads
						.listSessions(workspaceId)
						.map(session => session.id)
						.sort()
				} satisfies WorkflowSessionBaseline
			},
			captureDeliveryCursor: async sessionId => workflowDeliveryCursor(sessionId),
			captureTranscriptCursor: async sessionId => ({ rowid: reads.getMessages(sessionId).cursor }),
			materializeHandoff: async ({ run, job }) => {
				const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
				if (!ws?.worktree || !run.rootSessionId) return undefined
				const cursor =
					job.transcriptCursor && typeof job.transcriptCursor === 'object'
						? (job.transcriptCursor as { rowid?: unknown }).rowid
						: undefined
				const entries = reads
					.getMessages(run.rootSessionId)
					.entries.filter(entry => typeof cursor !== 'number' || entry.rowid <= cursor)
				const rendered = renderTranscript(entries, { thinking: true, tools: false })
				if (!rendered.kept) return undefined
				const body = [
					`# Workflow handoff for ${job.logicalKey}`,
					'',
					`Workflow: ${run.id}`,
					`Workflow job: ${job.id}`,
					`Root chat: ${run.rootSessionId}`,
					'',
					rendered.text
				].join('\n')
				return stableWorkflowAttachment(ws.worktree, job.id, `Workflow ${job.role} handoff.md`, body)
			},
			sendPrompt: call => sendWorkflowPrompt(call, false),
			returnBaton: call => sendWorkflowPrompt(call, true),
			resolveDeliveryReceipt: async ({ sessionId, receipt }) => {
				const current = reads.deliveryReceiptForId(sessionId, receipt.id)
				if (current?.kind === 'message') return { status: 'delivered' as const, receipt: current }
				if (current?.kind === 'outbox') return { status: 'pending' as const }
				return { status: 'lost' as const, evidence: { receiptId: receipt.id, priorKind: receipt.kind } }
			},
			readChildOutcome: async ({ job }) => {
				if (!job.childSessionId || !job.taskReceipt || typeof job.taskReceipt !== 'object') return null
				const receipt = job.taskReceipt as Partial<DeliveryReceipt>
				if (receipt.kind !== 'message' || !Number.isSafeInteger(receipt.rowid)) return null
				const child = reads.getSession(job.childSessionId)
				if (!child) {
					return {
						kind: 'failure' as const,
						code: 'session_not_found',
						message: 'The tracked child chat disappeared.',
						retryClass: 'deterministic' as const
					}
				}
				const messages =
					typeof receipt.turnId === 'string'
						? reads.getMessagesForTurn(job.childSessionId, receipt.turnId, receipt.rowid as number)
						: reads.getMessages(job.childSessionId, receipt.rowid as number)
				const assistants = messages.entries.filter(entry => entry.role === 'assistant' && entry.text.trim())
				const last = assistants.at(-1)
				if (child.status === 'error') {
					return {
						kind: 'failure' as const,
						code: 'completion_failed',
						message: last?.text.trim() || 'The tracked child agent stopped with an error.',
						retryClass: 'deterministic' as const,
						evidence: { assistantRowid: last?.rowid }
					}
				}
				if (child.status !== 'idle' || child.background_tasks.length || !last) return null
				return {
					kind: 'success' as const,
					baton: batonText(last.text),
					evidence: { assistantRowid: last.rowid }
				}
			},
			validateBeforeDispatch: async ({ run, effect }) => {
				if (effect.kind !== 'configure_root' && effect.kind !== 'send_root') return
				const sessionId = workflowSessionId(effect)
				if (!sessionId) {
					throw new WorkflowCoordinatorError(
						'workflow_root_not_pristine',
						'The Workflow root effect lost its exact session binding before dispatch.'
					)
				}
				assertWorkflowRootStillPristine(run, sessionId)
			},
			reconcileEffect: async ({ run, effect }) => {
				const sessionId = workflowSessionId(effect)
				if (effect.receipt && sessionId && typeof effect.receipt === 'object') {
					const receipt = effect.receipt as Partial<DeliveryReceipt>
					if (typeof receipt.id === 'string') {
						const current = reads.deliveryReceiptForId(sessionId, receipt.id)
						if (current) return { status: 'committed' as const, receipt: current }
						return { status: 'ambiguous' as const, evidence: { receiptId: receipt.id, state: 'missing' } }
					}
				}
				if (effect.kind === 'configure_root' || effect.kind === 'configure_child') {
					const role =
						effect.inputs && typeof effect.inputs === 'object'
							? (effect.inputs as { role?: FrozenWorkflowRole }).role
							: undefined
					const session = sessionId ? reads.getSession(sessionId) : null
					if (effect.kind === 'configure_root') {
						const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
						if (
							!ws ||
							!session ||
							run.rootSessionId !== sessionId ||
							reads.sessionWorkspaceId(session.id) !== ws.id ||
							!workflowRootInspection(ws, session).pristine
						) {
							return { status: 'pending' as const }
						}
					}
					if (role && session && sessionMatchesWorkflowRole(session, role)) {
						return { status: 'committed' as const, receipt: { sessionId, matched: true } }
					}
				}
				if (effect.kind === 'create_workspace') {
					const baseline = workspaceBaseline(effect.baseline)
					if (!baseline) return { status: 'ambiguous' as const, evidence: { baseline: 'invalid' } }
					const prior = new Set(baseline.workspaceIds)
					const candidates = reads
						.listWorkspaces()
						.filter(workspace => workspace.repo_name === baseline.repo && !prior.has(workspace.id))
						.map(workflowWorkspaceCandidate)
					return { status: 'ambiguous' as const, candidates, evidence: { candidateCount: candidates.length } }
				}
				if (effect.kind === 'open_child') {
					const baseline = sessionBaseline(effect.baseline)
					const ws = baseline ? reads.getWorkspace(baseline.workspaceId) : null
					if (!baseline || !ws) return { status: 'ambiguous' as const, evidence: { baseline: 'invalid' } }
					const prior = new Set(baseline.sessionIds)
					const candidates = reads
						.listSessions(ws.id)
						.filter(session => !prior.has(session.id) && workflowRootInspection(ws, session).pristine)
						.map(session => workflowSessionCandidate(ws, session))
					return { status: 'ambiguous' as const, candidates, evidence: { candidateCount: candidates.length } }
				}
				const prompt = workflowEffectPrompt(effect)
				const cursor = readsDeliveryCursor(effect.cursor)
				if (sessionId && cursor) {
					const marker = workflowEffectMarker(effect)
					const receipt = marker
						? reads.deliveryReceiptContainingSince(sessionId, marker, cursor)
						: prompt
							? reads.deliveryReceiptSince(sessionId, prompt, cursor)
							: null
					if (receipt) return { status: 'committed' as const, receipt }
				}
				return { status: 'pending' as const }
			},
			validateAdoption: async ({ effect, candidate }) => {
				if (candidate.kind === 'workspace' && effect.kind === 'create_workspace') {
					const baseline = workspaceBaseline(effect.baseline)
					const ws = reads.getWorkspace(candidate.id)
					if (!baseline || !ws || baseline.workspaceIds.includes(ws.id) || ws.repo_name !== baseline.repo) return null
					return { workspaceId: ws.id }
				}
				if (candidate.kind === 'session' && effect.kind === 'open_child') {
					const baseline = sessionBaseline(effect.baseline)
					const ws = baseline ? reads.getWorkspace(baseline.workspaceId) : null
					const session = reads.getSession(candidate.id)
					if (
						!baseline ||
						!ws ||
						!session ||
						baseline.sessionIds.includes(session.id) ||
						reads.sessionWorkspaceId(session.id) !== ws.id ||
						!workflowRootInspection(ws, session).pristine
					) {
						return null
					}
					return { sessionId: session.id }
				}
				return null
			},
			assertCompatibleRelays: async () => {
				const error = await workflowCompatibilityError()
				if (error) {
					throw new WorkflowCoordinatorError('workflow_incompatible_relay', error, {
						status: 409,
						retryable: true
					})
				}
			},
			dispatchMode: effect =>
				actuator.name === 'sidecar' &&
				(effect.kind === 'send_root' ||
					effect.kind === 'send_task' ||
					effect.kind === 'return_baton' ||
					effect.kind === 'authorize_phase')
					? 'in_process'
					: 'gated_child'
		})
	: null

const WORKFLOW_RECOVERY_PHONE_ONLY = 'Workflow recovery is available only from the phone UI.'

function requirePhoneWorkflowCoordinator(req: http.IncomingMessage, forbiddenMessage: string): WorkflowCoordinator {
	if (workflowClientIsMcp(req.headers)) throw new WorkflowRequestError(forbiddenMessage, 403)
	if (!workflowCoordinator)
		throw new WorkflowCoordinatorError('workflow_incompatible_relay', 'Workflow is unavailable.')
	return workflowCoordinator
}

function wakeWorkflows(): void {
	if (!workflowCoordinator) return
	for (const workflowId of workflowCoordinator.runIdsNeedingWake()) {
		void workflowCoordinator.wake(workflowId).catch(error => {
			console.error(`[workflow ${workflowId}] wake failed:`, error)
		})
	}
}

sessionPoller.subscribe(wakeWorkflows)

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png'
}

const LOCAL_IMAGE_TYPES: Record<string, string> = {
	'.avif': 'image/avif',
	'.gif': 'image/gif',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp'
}
const LOCAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024
// `/tmp` is a symlink to `/private/tmp` on macOS. os.tmpdir() also covers tools that use the user's
// per-login temporary directory instead. Resolve both before checking a requested file's real path.
const LOCAL_IMAGE_ROOTS = [...new Set([os.tmpdir(), '/tmp'].map(root => fs.realpathSync(root)))]

function insideRoot(filePath: string, root: string): boolean {
	const rel = path.relative(root, filePath)
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

async function serveLocalImage(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	requestedPath: string
): Promise<void> {
	const target = parseImageReference(requestedPath)
	const contentType = target ? LOCAL_IMAGE_TYPES[path.extname(target).toLowerCase()] : null
	if (!target || !contentType) return json(req, res, 404, { error: 'image not found' })

	let filePath: string
	let size: number
	try {
		filePath = await fs.promises.realpath(target)
		if (!LOCAL_IMAGE_ROOTS.some(root => insideRoot(filePath, root))) {
			const [workspaceRoot, homeRoot, bundledSkillsRoot] = await Promise.all([
				fs.promises.realpath(cfg.workspacesRoot),
				fs.promises.realpath(os.homedir()),
				fs.promises.realpath(BUNDLED_SKILLS_ROOT).catch(() => null)
			])
			if (!isAllowedPreviewPath(filePath, workspaceRoot, homeRoot, readExposeMode(), bundledSkillsRoot)) {
				return json(req, res, 404, { error: 'image not found' })
			}
		}
		const info = await fs.promises.stat(filePath)
		if (!info.isFile()) return json(req, res, 404, { error: 'image not found' })
		size = info.size
	} catch {
		return json(req, res, 404, { error: 'image not found' })
	}
	if (size > LOCAL_IMAGE_MAX_BYTES) return json(req, res, 413, { error: 'image is too large' })

	res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
	fs.createReadStream(filePath)
		.once('error', () => res.destroy())
		.pipe(res)
}

/** A preview stays small enough to render smoothly in the phone's source sheet. */
const FILE_PREVIEW_MAX_BYTES = 512 * 1024
const FILE_PREVIEW_CONTEXT_LINES = 100
const FILE_PREVIEW_FIRST_LINES = 500
const BUNDLED_SKILLS_ROOT = '/Applications/Conductor.app/Contents/Resources/conductor-skill/skills'

/**
 * Serve source that an agent linked in its Markdown. The link format comes from
 * coding-agent file references, but its path still arrives from a remote client.
 * Public Funnel clients stay within Conductor workspaces. Tailnet-only relays may
 * also read supporting source files from the signed-in user's home directory.
 */
async function serveFilePreview(req: http.IncomingMessage, res: http.ServerResponse, reference: string): Promise<void> {
	const target = parseFileReference(reference)
	if (!target) return json(req, res, 404, { error: 'source file not found' })
	const refused = (filePath: string) => {
		const answer = previewRefusal(filePath)
		return json(req, res, answer.status, { error: answer.error })
	}

	let filePath: string
	let workspaceRoot: string
	let homeRoot: string
	let bundledSkillsRoot: string | null
	let size: number
	try {
		;[filePath, workspaceRoot, homeRoot, bundledSkillsRoot] = await Promise.all([
			fs.promises.realpath(target.path),
			fs.promises.realpath(cfg.workspacesRoot),
			fs.promises.realpath(os.homedir()),
			fs.promises.realpath(BUNDLED_SKILLS_ROOT).catch(() => null)
		])
		if (!isAllowedPreviewPath(filePath, workspaceRoot, homeRoot, readExposeMode(), bundledSkillsRoot)) {
			return refused(filePath)
		}
		const info = await fs.promises.stat(filePath)
		if (!info.isFile()) return json(req, res, 404, { error: 'source file not found' })
		size = info.size
	} catch {
		// A path this relay would refuse must answer the same whether or not it is there, or
		// a public client learns which home files exist by watching 404 turn into 403.
		return refused(target.path)
	}
	if (size > FILE_PREVIEW_MAX_BYTES) return json(req, res, 413, { error: 'source file is too large to preview' })

	let content: string
	try {
		const raw = await fs.promises.readFile(filePath)
		if (raw.includes(0)) return json(req, res, 415, { error: 'source file is not text' })
		content = new TextDecoder('utf-8', { fatal: true }).decode(raw)
	} catch {
		return json(req, res, 415, { error: 'source file is not text' })
	}

	const lines = content.split('\n')
	const focus = target.line === null ? null : Math.min(target.line, lines.length)
	const start = focus === null ? 0 : Math.max(0, focus - FILE_PREVIEW_CONTEXT_LINES - 1)
	const end =
		focus === null
			? Math.min(lines.length, FILE_PREVIEW_FIRST_LINES)
			: Math.min(lines.length, focus + FILE_PREVIEW_CONTEXT_LINES)
	return json(req, res, 200, {
		path: target.path,
		line: focus,
		lineStart: start + 1,
		lineEnd: end,
		totalLines: lines.length,
		content: lines.slice(start, end).join('\n'),
		truncated: start > 0 || end < lines.length
	})
}

/**
 * How to answer for a file the preview will not serve, from the path alone.
 *
 * Chat mentions made the home-directory case ordinary — agents write "plan written to
 * `~/.gstack/plan.md`" constantly — and on a public funnel every one of those is refused
 * by policy. Answering "source file not found" then sends someone hunting for a file that
 * is sitting right there, so a refusal says it is a refusal. It discloses nothing: the
 * verdict comes from the path and the funnel's posture, never from the disk, and it is
 * the answer for an out-of-bounds path whether or not that path exists.
 */
function previewRefusal(filePath: string): { status: number; error: string } {
	const mode = readExposeMode()
	if (isAllowedPreviewPath(path.resolve(filePath), cfg.workspacesRoot, os.homedir(), mode, BUNDLED_SKILLS_ROOT)) {
		return { status: 404, error: 'source file not found' }
	}
	return {
		status: 403,
		error:
			mode === 'public'
				? 'this relay is reachable from the internet, so it previews files inside Conductor workspaces only'
				: 'outside the files this relay may read'
	}
}

/** Per-file ceiling for a relay exposed through Tailscale Funnel. Large media belongs in a link. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

class PayloadTooLargeError extends Error {}

/**
 * The last thing that happens to an error before it leaves the relay: the diagnostic
 * tail `windowEvidence()` appends comes off, and the full text goes to the log instead.
 *
 * One place rather than the dozen routes that hand back a UI-write failure, for the
 * same reason `redactSecrets` sits in front of every served log line: a rule applied at
 * the boundary cannot be forgotten by the next route someone adds. What it prevents is
 * what a tap on Fork against a locked Mac used to answer with — the sentence, then
 * "[window server: 6; screen: locked] [processes: conductor=0] [menus: Apple, Conductor,
 * File, ...]", in 11px red, on a phone that can do nothing with any of it. The evidence
 * is still the fastest way to tell a wedged Conductor from a hidden window, so it lands
 * in relay.log, which `/api/logs` serves to the same phone on request.
 */
function forTheClient(body: unknown): unknown {
	const scrub = (value: unknown, key?: string): unknown => {
		if (typeof value === 'string') {
			const withoutEvidence = withoutClientWindowEvidence(value, key)
			if (withoutEvidence !== value) console.warn(`[relay] ${scrubWorkflowSecrets(value)}`)
			return scrubWorkflowSecrets(withoutEvidence)
		}
		if (Array.isArray(value)) return value.map(item => scrub(item))
		if (!value || typeof value !== 'object') return value
		return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrub(child, childKey)]))
	}
	return scrub(body)
}

/**
 * Successful GETs are conditional + compressed to keep the phone's polling cheap.
 * `no-cache` (not `no-store`) means the browser must revalidate on every tick —
 * the relay still runs the handler and auth each time, so data is never stale;
 * a matching ETag just elides the redundant body (304), and changed bodies over
 * ~1 KB go out gzipped. Errors and non-GETs stay unconditional `no-store`.
 */
function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
	const payload = Buffer.from(JSON.stringify(forTheClient(body)))
	if (status !== 200 || req.method !== 'GET') {
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
		return void res.end(payload)
	}
	// Weak: the same entity may be delivered gzipped or plain.
	const etag = `W/"${crypto.createHash('sha1').update(payload).digest('base64url')}"`
	const headers: http.OutgoingHttpHeaders = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-cache',
		etag,
		vary: 'accept-encoding'
	}
	if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end()
	if (payload.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
		headers['content-encoding'] = 'gzip'
		return void res.writeHead(200, headers).end(zlib.gzipSync(payload))
	}
	res.writeHead(200, headers).end(payload)
}

/** Constant-time string compare — the token is the sole internet-facing gate when exposed via Funnel. */
function tokenEq(candidate: string | null): boolean {
	if (candidate == null) return false
	const a = Buffer.from(candidate)
	const b = Buffer.from(cfg.token)
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function authed(req: http.IncomingMessage): boolean {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return tokenEq(auth.slice('Bearer '.length))
	const url = new URL(req.url ?? '/', 'http://x')
	return tokenEq(url.searchParams.get('token'))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const c of req) chunks.push(c as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

/** Read one uploaded file without allowing a token holder to fill the relay's memory. */
async function readAttachmentBody(req: http.IncomingMessage): Promise<Buffer> {
	const declared = Number(req.headers['content-length'])
	if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
		throw new PayloadTooLargeError(`attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
	}
	const chunks: Buffer[] = []
	let bytes = 0
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		bytes += buffer.length
		if (bytes > MAX_ATTACHMENT_BYTES) {
			req.destroy()
			throw new PayloadTooLargeError(`attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
		}
		chunks.push(buffer)
	}
	return Buffer.concat(chunks, bytes)
}

function attachmentHeaderName(req: http.IncomingMessage): string | null {
	const encoded = req.headers['x-attachment-name']
	if (typeof encoded !== 'string' || !encoded) return null
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

/** Hashed Vite assets are immutable and cache-forever; the shell/SW must never go stale. */
function cacheControl(rel: string): string {
	if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'
	return 'no-cache'
}

function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
	const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
	const filePath = path.resolve(cfg.publicDir, rel)
	// Contain to publicDir. The URL parser already collapses `..`/`%2e%2e` dot-segments, but don't lean on
	// that: reject anything that resolves outside the dir (a bare `startsWith` would also admit a sibling
	// like `dist-node/`). An empty relative (filePath === publicDir) falls through to the SPA shell below.
	const within = path.relative(cfg.publicDir, filePath)
	if (within.startsWith('..') || path.isAbsolute(within)) {
		res.writeHead(403).end()
		return
	}
	fs.readFile(filePath, (err, data) => {
		if (err) {
			// SPA fallback to shell.
			fs.readFile(path.join(cfg.publicDir, 'index.html'), (e2, shell) => {
				if (e2) return void res.writeHead(404).end('not found')
				res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
				res.end(shell)
			})
			return
		}
		const ext = path.extname(filePath)
		res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cacheControl(rel) })
		res.end(data)
	})
}

/**
 * MCP over HTTP.
 *
 * Two guards beyond the token. **Origin is rejected when present and foreign**: a real
 * MCP client sends none, and a browser cannot omit it — so this closes the DNS-rebinding
 * hole the spec warns about without needing to know our own hostname behind Tailscale's
 * TLS. And **the body is capped**, because this endpoint is reachable from the internet
 * whenever EXPOSE=public and an unbounded JSON parse is the cheapest thing to abuse.
 */
async function handleMcpHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	if (req.method === 'GET' || req.method === 'DELETE') {
		// No server-initiated messages and no session to end. 405 is the spec's own answer
		// for a server that doesn't offer the stream.
		res.writeHead(405, { allow: 'POST' }).end()
		return
	}
	if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end()

	const origin = req.headers.origin
	if (origin) return void json(req, res, 403, { error: 'cross-origin requests are not accepted here' })
	if (!authed(req)) return void json(req, res, 401, { error: 'unauthorized' })

	let body: string
	try {
		body = await readBody(req)
	} catch {
		return void json(req, res, 400, { error: 'could not read request body' })
	}
	if (body.length > 1_000_000) return void json(req, res, 413, { error: 'request too large' })

	let parsed: unknown
	try {
		parsed = JSON.parse(body || 'null')
	} catch {
		res.writeHead(400, { 'content-type': 'application/json' })
		return void res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
	}

	// Agents yield the UI lock to whoever is holding the phone, exactly as the stdio
	// transport does via its `x-relay-client` header.
	const answers = await withUiPriority('background', async () => {
		const batch = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest]
		const settled = await Promise.all(batch.map(m => handleRpc(mcpTools, m)))
		return settled.filter(m => m !== null)
	})

	// A payload of nothing but notifications takes no reply at all.
	if (!answers.length) return void res.writeHead(202).end()
	res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
	res.end(JSON.stringify(forTheClient(Array.isArray(parsed) ? answers : answers[0])))
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x')
	const { pathname } = url

	// POST /mcp — the MCP Streamable HTTP transport, for a client that can only reach a
	// URL (an agent on another machine, or a hosted one). Same tools as
	// `conductor-remote mcp`'s stdio, same token gate as /api/*, and — because this runs
	// *inside* the relay — the same UI lock, with no second process to sit outside it.
	//
	// Deliberately minimal: this server never initiates a message, so there is no SSE
	// stream to open and GET is answered 405, which the spec allows. It keeps no session
	// either, so no `Mcp-Session-Id` is issued and every request stands alone.
	if (pathname === '/mcp') return handleMcpHttp(req, res)

	if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname)

	// Everything under /api requires the shared secret.
	if (!authed(req)) return json(req, res, 401, { error: 'unauthorized' })

	// Who is asking decides who waits for Conductor's window. An agent (src/mcp.ts sets
	// this header) yields the UI lock to the person holding the phone — see writes.ts ▸
	// uiTurn. Anything unlabelled is treated as the person, because the phone is the
	// only caller that predates the header and mislabelling it would be the bad way round.
	const priority = req.headers['x-relay-client'] === 'mcp' ? 'background' : 'interactive'
	return withUiPriority(priority, async () => {
		try {
			// GET /api/state — workspace list with active-session status
			if (isRoute(routes.state, req.method, pathname)) {
				const update = updateStatus()
				const workspaces = reads.listWorkspaces()
				attachChangeStats(workspaces) // serves the cache now; refreshes stale git stats in the background
				attachPrStatus(workspaces) // colours pr_status from cache; refreshes stale entries in the background
				attachRunActivity(workspaces) // flags a live Run wrapper from a cached ps snapshot
				attachDelegationState(workspaces)
				const workflows = attachWorkflowState(workspaces)
				const uiQuarantine = wireUiQuarantine()
				// An undelivered first prompt rides along with its workspace: the phone renders it
				// in that chat rather than tracking delivery itself (see src/firstprompt.ts).
				// Prompts parked for the lock screen ride the same way, one list per workspace,
				// each entry naming its chat (src/parked.ts).
				const parked = parkedPrompts.list()
				for (const ws of workspaces) {
					ws.pending_prompt = firstPrompts.get(ws.id)
					const mine = parked.filter(p => p.workspaceId === ws.id)
					if (mine.length) ws.parked_prompts = mine
				}
				return json(req, res, 200, {
					workspaces,
					workflows,
					...(uiQuarantine ? { uiQuarantine } : {}),
					...(orchestration.writable
						? {}
						: { workflowWarning: scrubWorkflowSecrets(orchestrationUnavailableReason()).slice(0, 500) }),
					actuator: await describeActuator(actuator),
					version: update.current,
					update
				})
			}

			// GET /api/search?q= — find a workspace by its name or by what was said in its chats.
			//
			// Two sources, merged. `findWorkspacesByName` matches the workspace's own identity
			// and wins ties, because someone who types a name wants that workspace and not the
			// twelve chats that mention it. The transcript index answers the harder question —
			// "which workspace did I do this in" — and is the only one that can, since the
			// words you remember are usually the agent's, not the branch's.
			//
			// Both reach archived workspaces. That is the point: 1,846 of the 1,886 here are
			// archived, so a search limited to the live sidebar would miss almost everything.
			//
			// `repo=` (repeatable) and `archived=0` scope both halves. They are resolved to
			// chat ids and pushed *into* the FTS query rather than applied to its top 300
			// chunks, or excluded work would fill every slot (search.ts ▸ search).
			if (isRoute(routes.search, req.method, pathname)) {
				const q = url.searchParams.get('q') ?? ''
				const repos = [...new Set(url.searchParams.getAll('repo').filter(Boolean))]
				// Archived search predates the toggle and stays the default for cached PWAs and MCP.
				const includeArchived = url.searchParams.get('archived') !== '0'
				// 12, not 50: an OR query over common words ("add", "remove") has a long weak tail,
				// and past the first screenful nobody scrolls — they retype instead.
				const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 12) || 12))
				const index = search.status()
				const tokens = queryTokens(q)
				if (!tokens.length) return json(req, res, 200, { query: q, repos, results: [], index })

				const scoped = repos.length > 0 || !includeArchived
				const scope = scoped
					? { sessionIds: reads.searchSessionIds(repos.length ? repos : undefined, includeArchived) }
					: {}
				const hits = await search.search(q, scope)
				const targets = reads.searchTargets([...new Set(hits.map(h => h.sessionId))])
				const fromChats = foldHits<SearchWorkspace>(hits, sid => {
					const workspace = targets.get(sid)?.workspace ?? null
					return !includeArchived && workspace?.archived ? null : workspace
				})

				const remaining = new Map(fromChats.map(r => [r.workspace.id, r]))
				const merged: SearchResult<SearchWorkspace>[] = []
				for (const workspace of reads.findWorkspacesByName(
					tokens,
					limit,
					repos.length ? repos : undefined,
					includeArchived
				)) {
					const evidence = remaining.get(workspace.id)
					remaining.delete(workspace.id)
					// Keep the chat evidence when there is any: the snippet is what tells you this
					// is the right "fix-lamp-thing" out of three with similar names.
					merged.push(
						evidence
							? { ...evidence, byName: true }
							: { workspace, sessionId: null, hits: 0, score: 0, at: null, snippets: [], byName: true }
					)
				}
				merged.push(...remaining.values())

				return json(req, res, 200, {
					query: q,
					repos,
					index,
					results: merged.slice(0, limit).map(r => ({
						...r,
						sessionTitle: r.sessionId ? (targets.get(r.sessionId)?.sessionTitle ?? null) : null
					}))
				})
			}

			// GET /api/repos — repos a new workspace can be created in
			if (isRoute(routes.repos, req.method, pathname)) {
				return json(req, res, 200, { repos: reads.listRepos() })
			}

			// GET /api/models — prior live picker reads, without activating Conductor. A
			// new workspace has no chat yet, so this is its only safe source of choices.
			if (isRoute(routes.modelCatalog, req.method, pathname)) {
				return json(req, res, 200, { groups: modelCache.list(), defaultModel: modelCache.defaultModel() })
			}

			// GET/PATCH /api/models/defaults — the live user-wide effort defaults.
			// These are file-backed settings, not the stale rows conductor.db still carries.
			if (isRoute(routes.modelDefaults, req.method, pathname)) {
				return json(req, res, 200, { defaultEfforts: readDefaultEfforts() })
			}
			if (isRoute(routes.updateModelDefaults, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { claude?: unknown; codex?: unknown }
				const patch: Parameters<typeof writeDefaultEfforts>[0] = {}
				if (body.claude !== undefined) {
					if (!isDefaultEffortLevel(body.claude)) return json(req, res, 400, { error: 'unknown Claude effort level' })
					patch.claude = body.claude
				}
				if (body.codex !== undefined) {
					if (!isDefaultEffortLevel(body.codex)) return json(req, res, 400, { error: 'unknown Codex effort level' })
					patch.codex = body.codex
				}
				if (Object.keys(patch).length === 0) return json(req, res, 400, { error: 'nothing to change' })
				return json(req, res, 200, { defaultEfforts: writeDefaultEfforts(patch) })
			}

			// GET /api/usage — structured subscription limits from the CLIs Conductor
			// itself bundles. Both reads are prompt-free and cached; `refresh=1` is the
			// explicit user action in the sheet, never a background poll.
			if (isRoute(routes.planUsage, req.method, pathname)) {
				return json(req, res, 200, await planUsage.read(url.searchParams.get('refresh') === '1'))
			}

			if (isRoute(routes.roles, req.method, pathname)) {
				const stored = roleStore.read()
				return json(req, res, 200, {
					...stored.config,
					issues: roleModelIssues(stored.config, modelCache.list()),
					...(stored.warning ? { warning: stored.warning } : {})
				})
			}

			if (isRoute(routes.updateRoles, req.method, pathname)) {
				let config: RolesConfig
				try {
					config = decodeRoles(JSON.parse((await readBody(req)) || '{}'))
				} catch (err) {
					const error: DelegationError = {
						code: 'invalid_request',
						message: err instanceof Error ? err.message : String(err),
						retryable: false
					}
					return json(req, res, 400, { ok: false, error })
				}
				const issues = roleModelIssues(config, modelCache.list())
				if (issues.length) return json(req, res, 409, { ok: false, error: issues[0].error, issues })
				const written = roleStore.write(config)
				if (!written.ok) {
					return json(req, res, 500, {
						ok: false,
						error: { code: 'state_invalid', message: written.error, retryable: true }
					})
				}
				return json(req, res, 200, { ok: true, config: written.config })
			}

			// This is deliberately independent of a Workflow run: cancellation cannot
			// make an ambiguous shared-window effect safe. Only a phone acknowledgement
			// after inspecting Conductor clears the relay-wide hold.
			if (isRoute(routes.confirmUiStable, req.method, pathname)) {
				if (workflowClientIsMcp(req.headers)) {
					throw new WorkflowRequestError('Only the phone UI can confirm that Conductor is stable.', 403)
				}
				if (!orchestration.writable) {
					throw new WorkflowCoordinatorError(
						'workflow_incompatible_relay',
						`UI stability confirmation is disabled because ${orchestrationUnavailableReason()}.`,
						{ status: 409 }
					)
				}
				const request = parseConfirmUiStableRequest(await workflowRequestBody(req))
				const confirmed = orchestration.idempotentMutation(
					'confirm_ui_stable',
					request.clientId,
					{
						confirmStable: true,
						createdAt: request.createdAt,
						...(request.actionId ? { actionId: request.actionId } : {}),
						...(request.effectId ? { effectId: request.effectId } : {})
					},
					() => {
						const current = orchestration.getUiQuarantine()
						if (
							current.active &&
							(current.createdAt !== request.createdAt ||
								current.actionId !== request.actionId ||
								current.effectId !== request.effectId)
						) {
							throw new WorkflowCoordinatorError(
								'workflow_recovery_invalid',
								'The Conductor UI safety hold changed; inspect the current hold before confirming it.',
								{ status: 409 }
							)
						}
						orchestration.clearUiQuarantine(`phone:${request.clientId}`)
						return { ok: true as const }
					}
				)
				return json(req, res, 200, confirmed.result)
			}

			// POST /api/workflows — the only operation that authorizes a managed
			// Workflow. Acceptance is durable and intentionally precedes every UI effect.
			if (isRoute(routes.workflows, req.method, pathname)) {
				if (workflowClientIsMcp(req.headers)) {
					throw new WorkflowRequestError('MCP cannot start a Workflow; start it from the Conductor Remote UI.', 403)
				}
				if (!workflowCoordinator) {
					throw new WorkflowCoordinatorError(
						'workflow_incompatible_relay',
						`Workflow is disabled because ${orchestrationUnavailableReason()}.`,
						{ status: 409 }
					)
				}
				const request = parseStartWorkflowRequest(await workflowRequestBody(req))
				const replay = orchestration.getIdempotentMutation<{ runId: string }>('start_workflow', request.clientId, {
					objective: request.objective,
					target: request.target
				})
				if (!replay && request.target.kind === 'new_workspace') {
					const stageIds = stagedAttachmentIdsInObjective(request.objective)
					if (stageIds.length && !stagedAttachments(STAGED_ATTACHMENTS_DIR, stageIds)) {
						throw new WorkflowCoordinatorError(
							'invalid_request',
							'One or more Workflow attachments are no longer staged; add them again.',
							{ status: 409 }
						)
					}
				}
				const accepted = await workflowCoordinator.start({
					clientId: request.clientId,
					objective: request.objective,
					target: request.target,
					roles: roleStore.read(),
					modelGroups: modelCache.list()
				})
				queueMicrotask(() => {
					void workflowCoordinator.wake(accepted.workflow.id).catch(error => {
						console.error(`[workflow ${accepted.workflow.id}] initial wake failed:`, error)
					})
				})
				return json(req, res, 202, { workflow: accepted.workflow })
			}

			// POST /api/workflows/:id/delegations — the sole agent mutation. The
			// capability, exact root, frozen role, and phase barrier are checked together.
			const workflowDelegation = routeParam(routes.workflowDelegation, req.method, pathname)
			if (workflowDelegation) {
				if (!workflowCoordinator) {
					throw new WorkflowCoordinatorError('workflow_incompatible_relay', 'Workflow is unavailable.', {
						status: 409
					})
				}
				const request = parseWorkflowDelegateRequest(await workflowRequestBody(req), workflowDelegation)
				// The capability rotates after every accepted choice. Its hash therefore
				// doubles as a stable retry identity without adding a field to the exact tool schema.
				const clientId = crypto
					.createHash('sha256')
					.update(
						JSON.stringify([
							request.workflow_id,
							request.phase_capability,
							request.session_id,
							request.role,
							request.prompt
						])
					)
					.digest('hex')
				const accepted = await workflowCoordinator.delegate({
					clientId,
					workflowId: request.workflow_id,
					sessionId: request.session_id,
					phaseCapability: request.phase_capability,
					role: request.role,
					task: request.prompt,
					...(request.role === 'implementation' ? { planningInterpretation: request.prompt } : {})
				})
				queueMicrotask(() => {
					void workflowCoordinator.wake(accepted.workflow.id).catch(error => {
						console.error(`[workflow ${accepted.workflow.id}] delegated wake failed:`, error)
					})
				})
				return json(req, res, 202, {
					ok: true,
					workflowId: accepted.workflow.id,
					delegationId: accepted.job.id,
					role: accepted.job.role,
					model: accepted.job.resolvedRole.model
				} satisfies DelegateTaskResult)
			}

			const retryWorkflow = routeParam(routes.workflowRetry, req.method, pathname)
			if (retryWorkflow) {
				const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
				const request = parseWorkflowRetryRequest(await workflowRequestBody(req))
				const result = await coordinator.retry({
					clientId: request.clientId,
					workflowId: retryWorkflow
				})
				queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
				return json(req, res, 200, { workflow: result.workflow })
			}

			const adoptWorkflow = routeParam(routes.workflowAdopt, req.method, pathname)
			if (adoptWorkflow) {
				const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
				const request = parseWorkflowAdoptRequest(await workflowRequestBody(req))
				const result = await coordinator.adopt({
					clientId: request.clientId,
					workflowId: adoptWorkflow,
					actionId: request.actionId,
					candidateId: request.workspaceId ?? request.sessionId
				})
				queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
				return json(req, res, 200, { workflow: result.workflow })
			}

			const replayWorkflow = routeParam(routes.workflowReplay, req.method, pathname)
			if (replayWorkflow) {
				const coordinator = requirePhoneWorkflowCoordinator(req, WORKFLOW_RECOVERY_PHONE_ONLY)
				const request = parseWorkflowReplayRequest(await workflowRequestBody(req))
				const result = await coordinator.replay({
					clientId: request.clientId,
					workflowId: replayWorkflow,
					actionId: request.actionId,
					confirmDuplicateRisk: request.confirmDuplicateRisk
				})
				queueMicrotask(() => void coordinator.wake(result.workflow.id).catch(console.error))
				return json(req, res, 200, { workflow: result.workflow })
			}

			const completeWorkflow = routeParam(routes.workflowComplete, req.method, pathname)
			if (completeWorkflow) {
				const coordinator = requirePhoneWorkflowCoordinator(req, 'Only the phone UI can mark a Workflow complete.')
				const request = parseWorkflowCompleteRequest(await workflowRequestBody(req))
				const result = await coordinator.complete({
					clientId: request.clientId,
					workflowId: completeWorkflow
				})
				return json(req, res, 200, { workflow: result.workflow })
			}

			const cancelWorkflow = routeParam(routes.workflow, req.method, pathname)
			if (cancelWorkflow) {
				const coordinator = requirePhoneWorkflowCoordinator(req, 'Only the phone UI can cancel a Workflow.')
				const clientId = url.searchParams.get('clientId')
				if (!clientId?.trim()) throw new WorkflowRequestError('clientId is required.')
				const result = await coordinator.cancel({ clientId: clientId.trim(), workflowId: cancelWorkflow })
				return json(req, res, 200, { workflow: result.workflow })
			}

			if (isRoute(routes.delegations, req.method, pathname)) {
				const workspaceId = url.searchParams.get('workspaceId')
				const workspaces = reads.listWorkspaces().filter(ws => !workspaceId || ws.id === workspaceId)
				if (workspaceId && !workspaces.length) return json(req, res, 404, { error: 'workspace not found' })
				const legacy = workspaces.flatMap(ws => {
					const store = delegationStore(ws)
					return store
						? store
								.list()
								.jobs.filter(job => job.status !== 'returned')
								.map(projectDelegation)
						: []
				})
				const allowedWorkspaces = new Set(workspaces.map(workspace => workspace.id))
				const workflows = orchestration.writable
					? orchestration.listWorkflowProjections().flatMap(workflow => {
							if (!workflow.workspaceId || !allowedWorkspaces.has(workflow.workspaceId)) return []
							return orchestration
								.listWorkflowJobs(workflow.id)
								.filter(job => job.state !== 'returned')
								.flatMap(job => projectWorkflowDelegation(workflow, job) ?? [])
						})
					: []
				return json(req, res, 200, { delegations: [...legacy, ...workflows] })
			}

			const dismissDelegation = routeParam(routes.dismissDelegation, req.method, pathname)
			if (dismissDelegation) {
				for (const ws of reads.listWorkspaces()) {
					const store = delegationStore(ws)
					if (!store) continue
					let job: PersistedDelegation | null
					try {
						job = store.get(dismissDelegation)
					} catch (err) {
						const error: DelegationError = {
							code: 'state_invalid',
							message: `Cannot dismiss unreadable delegation: ${err instanceof Error ? err.message : err}`,
							retryable: false
						}
						return json(req, res, 409, {
							ok: false,
							error
						})
					}
					if (!job) continue
					if (job.status !== 'failed') {
						return json(req, res, 409, {
							ok: false,
							error: {
								code: 'invalid_request',
								message: 'Only a failed delegation can be dismissed.',
								retryable: false
							} satisfies DelegationError
						})
					}
					store.remove(job.id)
					return json(req, res, 200, { ok: true, delegationId: job.id })
				}
				return json(req, res, 404, {
					ok: false,
					error: {
						code: 'delegation_not_found',
						message: 'Delegation not found.',
						retryable: false
					} satisfies DelegationError
				})
			}

			// POST /api/voice/ticket — the native app presents the same relay bearer as
			// the PWA, and receives only a two-minute SIP URI. The OpenAI key, webhook
			// secret and marker key never leave this Mac.
			if (isRoute(routes.voiceTicket, req.method, pathname)) {
				const missing = missingTicketConfig(voiceConfig)
				if (missing.length || !voiceBroker) {
					return json(req, res, 503, {
						error: 'voice calls are not fully configured on this relay',
						missing
					})
				}
				return json(req, res, 200, mintSipTicket(voiceConfig))
			}

			// POST /api/voice/calls — the PWA sends its SDP offer to this authenticated
			// relay. The relay combines it with the global orchestrator session and
			// keeps OpenAI's permanent key and every function tool on the Mac.
			if (isRoute(routes.voiceCall, req.method, pathname)) {
				if (!voiceConfig.openaiKey || !voiceBroker)
					return json(req, res, 503, { error: 'voice needs an OpenAI API key on this relay' })
				const raw = await readBody(req)
				if (raw.length > MAX_SDP_CHARS * 2) return json(req, res, 413, { error: 'WebRTC offer is too large' })
				const body = JSON.parse(raw || '{}') as { sdp?: unknown; voice?: unknown; language?: unknown }
				if (typeof body.sdp !== 'string' || !body.sdp.trim())
					return json(req, res, 400, { error: 'WebRTC offer is required' })
				if (body.sdp.length > MAX_SDP_CHARS) return json(req, res, 413, { error: 'WebRTC offer is too large' })
				if (!isOpenAIRealtimeVoice(body.voice))
					return json(req, res, 400, { error: `voice must be one of ${OPENAI_REALTIME_VOICES.join(', ')}` })
				if (!isVoiceLanguage(body.language)) return json(req, res, 400, { error: 'unsupported voice language' })
				try {
					const call = await createWebRtcCall(
						voiceConfig.openaiKey,
						openAIOriginForSipHost(voiceConfig.sipHost),
						body.sdp,
						{
							model: voiceConfig.model,
							voice: body.voice as OpenAIRealtimeVoice,
							language: body.language as VoiceLanguage
						},
						voiceSafetyIdentifier
					)
					voiceBroker.registerWebRtc(call.callId)
					return json(req, res, 200, call)
				} catch (err) {
					console.warn('[voice] could not create WebRTC orchestrator call:', err)
					return json(req, res, 502, { error: err instanceof Error ? err.message : 'voice call failed' })
				}
			}

			const readyVoiceCall = routeParam(routes.voiceCallReady, req.method, pathname)
			if (readyVoiceCall) {
				if (!voiceBroker) return json(req, res, 503, { error: 'voice is not configured on this relay' })
				if (!voiceBroker.beginWebRtc(readyVoiceCall)) return json(req, res, 404, { error: 'voice call not found' })
				return json(req, res, 200, { ok: true })
			}

			const endedVoiceCall = routeParam(routes.voiceCallEnd, req.method, pathname)
			if (endedVoiceCall) {
				if (!voiceBroker) return json(req, res, 503, { error: 'voice is not configured on this relay' })
				try {
					if (!(await voiceBroker.hangupWebRtc(endedVoiceCall)))
						return json(req, res, 404, { error: 'voice call not found' })
					return json(req, res, 200, { ok: true })
				} catch (err) {
					console.warn('[voice] could not hang up WebRTC orchestrator call:', err)
					return json(req, res, 502, { error: err instanceof Error ? err.message : 'voice hangup failed' })
				}
			}

			// GET /api/settings — relay preferences plus what the phone needs to edit them:
			// the SSIDs this Mac already holds credentials for, so the picker offers a choice
			// instead of asking someone to type a network name from memory on a phone keyboard.
			// `ssid` is best-effort and often null (macOS gates it behind Location Services).
			if (isRoute(routes.settings, req.method, pathname)) {
				// Five subprocesses, all concurrent: this is the one route that shells out more
				// than once, and serialising them would put the phone's polls behind the sum.
				const [known, current, autoJoinHotspot, nosleep, locked] = await Promise.all([
					preferredNetworks(),
					currentSsid(),
					// macOS's own Auto-join Hotspot setting. On "Never" the Mac won't reach for
					// your phone unprompted, which no amount of relay code can substitute for.
					autoJoinHotspotMode(),
					nosleepState(),
					// Read here rather than polled: this sheet is where someone goes when the Mac
					// stopped answering, and a keep-awake window that says "automatic screen lock
					// is off" beside a Mac that is locked right now reads as the relay lying. The
					// assertion blocks the *idle* lock; it cannot lift one already up, and a lid
					// close or a manual lock puts one up whatever it holds.
					screenLocked()
				])
				return json(req, res, 200, {
					settings: readSettings(),
					wifi: {
						current,
						known,
						// A guess from the name, never a fact — see wifi.ts. It only sorts the picker.
						likelyHotspots: known.filter(looksLikeHotspot),
						autoJoinHotspot
					},
					nosleep: { ...nosleep, maxSeconds: NOSLEEP_MAX_SECONDS },
					screenLocked: locked
				})
			}

			// PATCH /api/settings { fallbackSsids?, autoRejoin? } — merge and persist.
			if (isRoute(routes.updateSettings, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { fallbackSsids?: unknown; autoRejoin?: unknown }
				const patch: Parameters<typeof writeSettings>[0] = {}
				if (Array.isArray(body.fallbackSsids)) patch.fallbackSsids = body.fallbackSsids as string[]
				if (typeof body.autoRejoin === 'boolean') patch.autoRejoin = body.autoRejoin
				if (Object.keys(patch).length === 0) return json(req, res, 400, { error: 'nothing to change' })
				return json(req, res, 200, { settings: writeSettings(patch) })
			}

			// PWA state remains local-first; this host copy survives origin changes and
			// reconciles phones. PATCH accepts a full client snapshot and merges per key.
			if (isRoute(routes.prefs, req.method, pathname)) {
				return json(req, res, 200, { prefs: readPrefs() })
			}
			if (isRoute(routes.updatePrefs, req.method, pathname)) {
				const raw = JSON.parse((await readBody(req)) || '{}') as unknown
				if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
					return json(req, res, 400, { error: 'preferences must be an object' })
				}
				const body = raw as Record<string, unknown>
				if (!Object.hasOwn(body, 'readMarks') && !Object.hasOwn(body, 'drafts')) {
					return json(req, res, 400, { error: 'nothing to sync' })
				}
				return json(req, res, 200, { prefs: writePrefs(body) })
			}

			// GET /api/nosleep — is the Mac being held awake, and can this relay do it at all
			if (isRoute(routes.nosleep, req.method, pathname)) {
				return json(req, res, 200, { ...(await nosleepState()), maxSeconds: NOSLEEP_MAX_SECONDS })
			}

			// POST /api/nosleep { seconds } — hold this Mac awake, lid closed, for a bounded window.
			// Only works once `conductor-remote nosleep setup` has installed the scoped sudoers
			// rule; without it there is no way for a TTY-less daemon to reach root, and the
			// response says so rather than failing vaguely.
			if (isRoute(routes.armNoSleep, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { seconds?: number }
				const seconds = Number(body.seconds)
				// Whole seconds, not just "> 0": the helper reads 0 as "until killed", and 0.4
				// truncates to 0 — an unbounded window from a request that looked bounded.
				if (!Number.isInteger(seconds) || seconds < 1)
					return json(req, res, 400, { error: 'need a whole number of seconds >= 1' })
				const result = await armNoSleep(seconds, cfg.preventScreenLock)
				return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
			}

			// DELETE /api/nosleep — let it sleep again now, rather than at the window's end
			if (isRoute(routes.disarmNoSleep, req.method, pathname)) {
				const result = await disarmNoSleep()
				return json(req, res, result.ok ? 200 : result.state.available ? 502 : 409, result)
			}

			// POST /api/conductor/restart { stopAgents? } — quit Conductor and start it again.
			//
			// The lever exists in the actuator already, but only as activateConductor's last
			// resort, which fires exclusively for a *windowless* Conductor. This is for the
			// other shape: window up, prompts landing as rows, and no agent output behind any
			// of it (measured 2026-09-02 — 2h35m of user rows after the last agent frame).
			// The running agents are counted from the DB before the UI is touched and refused
			// unless the caller meant it, the same way archiving is: quitting ends every turn
			// in flight. The lock screen is the actuator's own gate, since only it can ask.
			if (isRoute(routes.restartConductor, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { stopAgents?: boolean }
				const working = reads.listSessionStates().filter(state => state.status === 'working').length
				if (working > 0 && body.stopAgents !== true) {
					return json(req, res, 409, {
						ok: false,
						agentsRunning: true,
						working,
						error: `${working} chat${working === 1 ? ' is' : 's are'} mid-turn. Restarting Conductor ends ${working === 1 ? 'it' : 'them'}.`
					})
				}
				const startedAt = Date.now()
				const result = await restartConductorApp()
				const ms = Date.now() - startedAt
				if (!result.ok) {
					console.warn(`[restart] Conductor restart failed after ${(ms / 1000).toFixed(1)}s: ${result.error}`)
					return json(req, res, 502, { ok: false, ms, error: result.error })
				}
				console.log(`[restart] quit Conductor and relaunched it in ${(ms / 1000).toFixed(1)}s`)
				return json(req, res, 200, { ok: true, ms })
			}

			// GET /api/logs?file=&limit= — the relay's own log, so a phone can diagnose a failed send
			// without reaching the Mac. Default is this process's captured console (ordered, timestamped);
			// `file` tails the daemon's stdout/stderr on disk, which is the only place the *previous*
			// process's crash survives. Everything is redacted: the startup banner prints the token.
			if (isRoute(routes.logs, req.method, pathname)) {
				const file = url.searchParams.get('file')
				if (file && !(LOG_FILE_NAMES as readonly string[]).includes(file)) {
					return json(req, res, 404, { error: `unknown log file ${file}`, files: LOG_FILE_NAMES })
				}
				const asked = Number(url.searchParams.get('limit') ?? 300)
				const limit = Number.isFinite(asked) ? Math.min(2000, Math.max(1, Math.trunc(asked))) : 300
				let entries: ReturnType<typeof recentLogs>
				try {
					entries = file ? tailLogFile(file, limit) : recentLogs(limit)
				} catch (err) {
					// The file only exists once the LaunchAgent has run; say so instead of a bare 500.
					return json(req, res, 404, { error: `can’t read ${file}: ${err instanceof Error ? err.message : err}` })
				}
				return json(req, res, 200, {
					source: file ?? 'live',
					// False → the files below are some *other* (daemon) process's output, not this relay's.
					managed: isManaged(),
					startedAt: processStartedAt(),
					now: Date.now(),
					files: logFiles(),
					entries: entries.map(e => ({ ...e, text: redactSecrets(e.text, cfg.token) }))
				})
			}

			// GET /api/push — the VAPID public key the phone subscribes with, plus who's already subscribed
			if (isRoute(routes.push, req.method, pathname)) {
				return json(req, res, 200, pushConfig())
			}

			// POST /api/push/subscribe { subscription, label? } — register (or refresh) this device.
			// Idempotent by endpoint: the app re-sends on every load, which is what heals a relay that
			// lost its store, or a subscription the browser silently renewed.
			if (isRoute(routes.pushSubscribe, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as {
					subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
					label?: string
				}
				const sub = body.subscription
				if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) {
					return json(req, res, 400, { error: 'need a subscription with endpoint and keys' })
				}
				// An endpoint is a URL we will POST to — never accept a non-HTTPS one.
				if (!/^https:\/\//i.test(sub.endpoint)) return json(req, res, 400, { error: 'endpoint must be https' })
				const registered = subscribeDevice(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
					(body.label ?? '').slice(0, 64)
				)
				return json(req, res, 200, { ok: true, ...registered })
			}

			// POST /api/push/unsubscribe { endpoint } — the phone turned notifications off
			if (isRoute(routes.pushUnsubscribe, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { endpoint?: string }
				if (!body.endpoint) return json(req, res, 400, { error: 'need the endpoint' })
				return json(req, res, 200, { ok: unsubscribeDevice(body.endpoint), devices: pushConfig().devices })
			}

			// POST /api/push/test { id } — push to one device, so "is this actually wired up?" has an answer
			if (isRoute(routes.pushTest, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as { id?: string }
				if (!body.id) return json(req, res, 400, { error: 'need the device id' })
				const result = await notifyDevice(body.id, {
					title: 'Conductor Remote',
					body: 'Notifications are working. You’ll get one when an agent finishes.',
					tag: 'test',
					url: '/',
					kind: 'test',
					ts: Date.now()
				})
				return json(req, res, result.ok ? 200 : 502, result)
			}

			// POST /api/attachments — hold one phone file until its new workspace has a worktree.
			if (isRoute(routes.stageAttachment, req.method, pathname)) {
				const name = attachmentHeaderName(req)
				if (!name) return json(req, res, 400, { error: 'missing attachment name' })
				const bytes = await readAttachmentBody(req)
				if (!bytes.length) return json(req, res, 400, { error: 'empty attachment' })
				const attachment = stageAttachment(STAGED_ATTACHMENTS_DIR, name, bytes)
				return json(req, res, 201, { ok: true, attachment })
			}

			// DELETE /api/attachments/:id — an upload cancelled before it became a synced draft attachment.
			const stagedAttachment = routeParam(routes.discardStagedAttachment, req.method, pathname)
			if (stagedAttachment)
				return json(req, res, discardStagedAttachment(STAGED_ATTACHMENTS_DIR, stagedAttachment) ? 200 : 404, {
					ok: true
				})

			// POST /api/workspaces { repo, prompt, model?/effort?/plan?/fast?, send? }
			// — create a workspace via Conductor's deep link, then configure its first chat.
			if (isRoute(routes.createWorkspace, req.method, pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}') as CreateWorkspaceRequest
				const attachmentIds = body.attachmentIds ?? []
				if ('workflow' in body) return json(req, res, 400, { error: 'Workflow starts through POST /api/workflows.' })
				if (body.model !== undefined && typeof body.model !== 'string')
					return json(req, res, 400, { error: 'model must be a picker label' })
				if (body.effort !== undefined && typeof body.effort !== 'string')
					return json(req, res, 400, { error: 'effort must be a string' })
				const effort = body.effort?.trim() || undefined
				if (effort && !EFFORT_LABELS[effort])
					return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
				if (body.plan !== undefined && typeof body.plan !== 'boolean')
					return json(req, res, 400, { error: 'plan must be a boolean' })
				if (body.fast !== undefined && typeof body.fast !== 'boolean')
					return json(req, res, 400, { error: 'fast must be a boolean' })
				const requestedAgent: ParkedAgentPatch = {
					model: body.model?.trim() || undefined,
					effort,
					plan: body.plan,
					fast: body.fast
				}
				if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string'))
					return json(req, res, 400, { error: 'attachment ids must be a list of strings' })
				const attachments = stagedAttachments(STAGED_ATTACHMENTS_DIR, attachmentIds)
				if (!attachments) return json(req, res, 409, { error: 'an attached file is no longer available; add it again' })
				// The prompt is optional — a bare `path=` opens an empty workspace, like
				// Conductor's own New workspace — but *something* has to say where it goes.
				const objective = [...attachments.map(attachment => attachment.token), (body.prompt ?? '').trim()]
					.filter(Boolean)
					.join('\n')
				if (!objective && !body.repo) return json(req, res, 400, { error: 'need a repo or a prompt' })
				const prompt = objective
				const agent = requestedAgent
				const configureAgent = Object.values(agent).some(value => value !== undefined)
				// Resolve the repo to a real path: an unmatched `path` would silently land
				// the workspace in whichever repo Conductor happens to list first.
				const repo = body.repo ? reads.listRepos().find(r => r.name === body.repo) : undefined
				if (body.repo && !repo) return json(req, res, 404, { error: `unknown repo ${body.repo}` })
				if (repo && !repo.root_path) return json(req, res, 409, { error: `${repo.name} has no checkout path` })
				const { result, created } = await createWorkspaceAndRead(prompt, repo?.root_path ?? null, repo?.name)
				if (!result.ok) return json(req, res, 502, result)
				if (!created) {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error: 'Conductor didn’t create a workspace — check it’s running and not showing a dialog.'
					})
				}
				// Return as soon as the row exists (~2s) — waiting for delivery would block the
				// request through Conductor's whole setup, measured at 30s+ on a real repo and
				// past any budget a phone should hold a request open for. The queue delivers on
				// its own schedule and the phone watches it in /api/state; `send:true` opts API
				// callers into waiting.
				// Whatever happens, the prompt is already pre-filled in Conductor's composer.
				const settled =
					prompt || configureAgent
						? firstPrompts.enqueue(
								created.id,
								prompt,
								body.sendImmediately !== false,
								attachmentIds,
								configureAgent ? agent : undefined
							)
						: null
				const failed = settled && body.send === true ? await settled : null
				settled?.catch(() => undefined) // fire-and-forget: it reports failure, it never rejects
				return json(req, res, 200, {
					ok: true,
					workspaceId: created.id,
					workspace: reads.getWorkspace(created.id) ?? created,
					pendingPrompt: prompt || undefined,
					model: agent.model,
					sent: body.send === true && !!prompt && !failed,
					configured: body.send === true && configureAgent && !failed,
					warning:
						failed?.error &&
						`Workspace created; the initial ${configureAgent ? 'agent settings and prompt' : 'prompt'} didn’t finish (${failed.error}).`
				})
			}

			// GET /api/repos/:name/icon — the repo's resolved sidebar icon (see src/icons.ts)
			const repo = routeParam(routes.repoIcon, req.method, pathname)
			if (repo) {
				const icon = reads.resolveRepoIcon(repo)
				if (!icon) return json(req, res, 404, { error: 'no icon' })
				return void fs.readFile(icon.path, (err, data) => {
					if (err) return void json(req, res, 404, { error: 'no icon' })
					// Cache briefly on the phone; the resolver itself refreshes within ~30s of an icon change.
					res.writeHead(200, { 'content-type': icon.contentType, 'cache-control': 'public, max-age=300' })
					res.end(data)
				})
			}

			// GET /api/local-images/:path — local images linked from agent Markdown. The browser fetches this
			// with its Authorization header and turns the reply into an object URL (Markdown.tsx), so the secret
			// stays out of the image URL. `serveLocalImage` limits reads to temp files and permitted workspace paths.
			const localImage = routeParam(routes.localImage, req.method, pathname)
			if (localImage) return serveLocalImage(req, res, localImage)

			// GET /api/tool-images/:reference — a screenshot or other image a tool returned. Held
			// back from the transcript itself (~100 kB of base64 each) and fetched only for a step
			// the reader opened, with the phone's auth header, like every other image route here.
			const toolImageRef = routeParam(routes.toolImage, req.method, pathname)
			if (toolImageRef) {
				const image = reads.toolImage(toolImageRef)
				if (!image) return json(req, res, 404, { error: 'image not found' })
				const bytes = Buffer.from(image.data, 'base64')
				// Immutable: a transcript row is written once, so the reference names one picture
				// forever and re-opening the step costs nothing.
				res.writeHead(200, {
					'content-type': image.mediaType,
					'content-length': String(bytes.length),
					'cache-control': 'private, max-age=86400, immutable'
				})
				return void res.end(bytes)
			}

			// GET /api/files/:reference — source linked from an agent reply. The Markdown component
			// intercepts the browser navigation and fetches this endpoint with its auth header.
			const fileReference = routeParam(routes.filePreview, req.method, pathname)
			if (fileReference) return serveFilePreview(req, res, fileReference)

			// GET /api/workspaces/:id — one workspace by id, archived included. `/api/state` lists
			// only the live ones, so this is what lets the phone open a chat search found in work
			// that has been put away: the worktree is gone, the transcript is not.
			const workspaceById = routeParam(routes.workspace, req.method, pathname)
			if (workspaceById) {
				const found = reads.getAnyWorkspace(workspaceById)
				if (!found) return json(req, res, 404, { error: 'workspace not found' })
				return json(req, res, 200, { workspace: found })
			}

			// GET /api/workspaces/:id/sessions
			const listSessionsIn = routeParam(routes.sessions, req.method, pathname)
			if (listSessionsIn) {
				const ws = reads.getWorkspace(listSessionsIn)
				const store = ws ? delegationStore(ws) : null
				const roles = store?.sessionRoles()
				const enriched = ws as WorkflowAttachedWorkspace | null
				if (enriched) attachWorkflowState([enriched])
				const sessionRoles = { ...(roles?.sessions ?? {}), ...(enriched?.session_roles ?? {}) }
				return json(req, res, 200, {
					sessions: reads.listSessions(listSessionsIn),
					...(Object.keys(sessionRoles).length ? { session_roles: sessionRoles } : {})
				})
			}

			// POST /api/workspaces/:id/sessions — open a new chat (Cmd+T) in the workspace
			const newChatIn = routeParam(routes.newChat, req.method, pathname)
			if (newChatIn) {
				const workspaceId = newChatIn
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				const opened = await openChat(ws)
				if ('error' in opened) return json(req, res, 502, opened.result)
				return json(req, res, 200, { ok: true, sessionId: opened.sessionId })
			}

			// GET /api/workspaces/:id/diff
			const diffOf = routeParam(routes.diff, req.method, pathname)
			if (diffOf) {
				const ws = reads.getWorkspace(diffOf)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
				const diff = await workspaceDiff(ws.worktree, ws.baseBranch)
				return json(req, res, 200, diff)
			}

			// GET /api/workspaces/:id/diff/file?path=… — the complete patch for the file
			// currently on screen. The aggregate endpoint stays bounded for phone-sized
			// responses, while a late file no longer disappears behind that bound.
			const fileDiffOf = routeParam(routes.fileDiff, req.method, pathname)
			if (fileDiffOf) {
				const ws = reads.getWorkspace(fileDiffOf)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
				const file = url.searchParams.get('path')
				if (!file) return json(req, res, 400, { error: 'file path is required' })
				const diff = await workspaceFileDiff(ws.worktree, ws.baseBranch, file)
				if (!diff) return json(req, res, 404, { error: 'changed file not found' })
				return json(req, res, 200, diff)
			}

			// GET /api/workspaces/:id/files — previewable worktree files for the diff window's
			// All-files rail and for linking `tests/foo.ts` in a message only when it really exists.
			// A workspace with no worktree has no list for either caller.
			const filesOf = routeParam(routes.workspaceFiles, req.method, pathname)
			if (filesOf) {
				const ws = reads.getWorkspace(filesOf)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				if (!ws.worktree) return json(req, res, 200, { files: [], truncated: false })
				return json(req, res, 200, await listSourceFiles(ws.worktree))
			}

			// POST /api/workspaces/:id/merge — merge the workspace's open PR (mirrors Conductor's merge button)
			const mergeOf = routeParam(routes.merge, req.method, pathname)
			if (mergeOf) {
				const ws = reads.getWorkspace(mergeOf)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				const result = await mergePr(ws)
				return json(req, res, result.ok ? 200 : 409, result)
			}

			// POST /api/workspaces/:id/continue { sessionId? } — press the Continue action
			// Conductor draws for a merged PR. The native handler checks out a fresh branch,
			// updates its own workspace record and stages Branch continued.md in the selected
			// chat. Only it can do all three consistently; this relay keeps its DB read-only.
			const continueOf = routeParam(routes.continueWorkspace, req.method, pathname)
			if (continueOf) {
				const workspaceId = continueOf
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) {
					const known = reads.getAnyWorkspace(workspaceId)
					if (known?.archived) {
						return json(req, res, 409, { ok: false, error: 'Archived workspaces cannot be continued.' })
					}
					return json(req, res, 404, { error: 'workspace not found' })
				}
				const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string }
				const requestedSession = body.sessionId || ws.active_session_id
				let tab: ChatTab | undefined
				if (requestedSession) {
					const located = locateChat(ws, requestedSession)
					if ('error' in located) return json(req, res, 409, { ok: false, error: located.error })
					if (body.sessionId && !located.session) {
						return json(req, res, 409, { ok: false, error: 'chat is no longer one of the workspace’s tabs' })
					}
					tab = located.tab
				}
				const previousBranch = ws.branch
				if (!previousBranch) return json(req, res, 409, { ok: false, error: 'workspace has no branch to continue' })
				const result = await continueWorkspace({ workspace: ws, sessionId: requestedSession, tab })
				if (!result.ok) return json(req, res, 502, result)

				// AXPress only proves the button accepted a click. Conductor then fetches the
				// target and changes the worktree asynchronously, so the branch column is the
				// receipt. A generous wait covers the fetch without ever writing that column.
				let continued = reads.getWorkspace(workspaceId)
				for (let i = 0; i < 60 && (!continued?.branch || continued.branch === previousBranch); i++) {
					await sleep(500)
					continued = reads.getWorkspace(workspaceId)
				}
				if (!continued?.branch || continued.branch === previousBranch) {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error: 'Conductor did not record a new branch within 30 seconds. Check it on your Mac before retrying.'
					})
				}
				return json(req, res, 200, { ok: true, previousBranch, workspace: continued })
			}

			// POST /api/workspaces/:id/status { status } — move it between the sidebar's status groups.
			// Conductor derives that status from a PR it sometimes never links (a PR merged inside its
			// poll window is invisible to it afterwards), which strands finished work in "In progress"
			// with no way to correct it from a phone. This is that way.
			const statusOf = routeParam(routes.workspaceStatus, req.method, pathname)
			if (statusOf) {
				const workspaceId = statusOf
				const body = JSON.parse((await readBody(req)) || '{}') as { status?: string }
				const status = body.status ?? ''
				if (!WORKSPACE_STATUS_LABELS[status]) {
					const allowed = Object.keys(WORKSPACE_STATUS_LABELS).join(', ')
					return json(req, res, 400, { error: `status must be one of ${allowed}` })
				}
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				const result = await setWorkspaceStatus(ws, status)
				if (!result.ok) return json(req, res, 502, result)
				// The menu press lands in the DB a beat later. Confirm rather than assume —
				// and if Conductor wrote something else, say what, instead of "didn't work".
				let observed = ws.manual_status ?? ''
				for (let i = 0; i < 10 && observed !== status; i++) {
					await new Promise(r => setTimeout(r, 300))
					observed = reads.getWorkspace(workspaceId)?.manual_status ?? ''
				}
				if (observed !== status) {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error: observed
							? `Conductor recorded the status as “${observed}”, not “${status}”.`
							: 'Conductor didn’t record the change — it may have been asleep. Try again.'
					})
				}
				return json(req, res, 200, { ok: true, workspace: reads.getWorkspace(workspaceId) })
			}

			// POST /api/workspaces/:id/archive { stopAgents? } — put the workspace away, the way
			// Conductor's own ⌘⇧A does. The one write here that destroys something: the worktree
			// goes, and any agent still working goes with it. So the running agents are counted
			// from the DB *before* the UI is touched and refused unless the caller has said it
			// meant that — the phone's own dialog then says so in the same words Conductor's does.
			const archiveOf = routeParam(routes.archiveWorkspace, req.method, pathname)
			if (archiveOf) {
				const workspaceId = archiveOf
				const body = JSON.parse((await readBody(req)) || '{}') as { stopAgents?: boolean }
				const ws = reads.getWorkspace(workspaceId)
				if (!ws) {
					// Already archived is the answer the caller asked for, not a 404. A phone whose
					// answer went missing retries, and `getWorkspace` only sees the live sidebar.
					const known = reads.getAnyWorkspace(workspaceId)
					if (known?.archived) return json(req, res, 200, { ok: true, alreadyArchived: true, workspace: known })
					return json(req, res, 404, { error: 'workspace not found' })
				}
				const working = reads.listSessions(ws.id).filter(s => s.status === 'working').length
				if (working > 0 && body.stopAgents !== true) {
					return json(req, res, 409, {
						ok: false,
						agentsRunning: true,
						error: `${working} agent${working === 1 ? ' is' : 's are'} still working here. Archiving stops them.`
					})
				}
				const result = await archiveWorkspace(ws, body.stopAgents === true)
				if (!result.ok) return json(req, res, 502, result)
				// `state` becoming 'archived' is the receipt, like the status change above: the
				// keystroke is fire-and-forget and Conductor writes the row a beat later.
				let archived = reads.getAnyWorkspace(workspaceId)
				for (let i = 0; i < 20 && !archived?.archived; i++) {
					await sleep(300)
					archived = reads.getAnyWorkspace(workspaceId)
				}
				if (!archived?.archived) {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error:
							'Conductor took the archive but the workspace is still in the sidebar. Try again, or archive it on your Mac.'
					})
				}
				return json(req, res, 200, { ok: true, strategy: result.strategy, workspace: archived })
			}

			// Conductor's Run configs plus tailnet-only HTTPS forwards for the active
			// one's ports. Reads never touch Conductor's UI; start/stop use the same
			// Accessibility lock and target assertion as every other UI write.
			const devServerOf = routeParam(routes.devServer, req.method, pathname)
			if (devServerOf) {
				const ws = reads.getWorkspace(devServerOf)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				return json(req, res, 200, await devServers.state(ws))
			}

			const startDevServerIn = routeParam(routes.startDevServer, req.method, pathname)
			if (startDevServerIn) {
				const ws = reads.getWorkspace(startDevServerIn)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				const body = JSON.parse((await readBody(req)) || '{}') as { runConfigId?: unknown }
				if (body.runConfigId !== undefined && (typeof body.runConfigId !== 'string' || !body.runConfigId.trim())) {
					return json(req, res, 400, { error: 'runConfigId must be a non-empty string' })
				}
				const result = await devServers.start(ws, body.runConfigId as string | undefined)
				return json(req, res, result.ok ? 200 : result.available ? 502 : 409, result)
			}

			const stopDevServerIn = routeParam(routes.stopDevServer, req.method, pathname)
			if (stopDevServerIn) {
				const ws = reads.getWorkspace(stopDevServerIn)
				if (!ws) return json(req, res, 404, { error: 'workspace not found' })
				const result = await devServers.stop(ws)
				return json(req, res, result.ok ? 200 : 502, result)
			}

			// GET /api/sessions/:id/messages?after=<rowid>
			const messagesOf = routeParam(routes.messages, req.method, pathname)
			if (messagesOf) {
				// The phone's 1s transcript poll doubles as its "I am reading this chat" heartbeat,
				// which is what keeps a turn ending on screen from also buzzing the lock screen
				// (src/notify.ts). Only this route is a claim: it is the one read that runs for the
				// chat on screen and for no other.
				const device = req.headers[VIEWING_HEADER]
				if (typeof device === 'string' && device) noteViewing(device, messagesOf)
				const after = Number(url.searchParams.get('after') ?? 0)
				return json(req, res, 200, reads.getMessages(messagesOf, Number.isFinite(after) ? after : 0))
			}

			// GET /api/sessions/:id/context — expensive enough to stay off the session poll.
			const contextOf = routeParam(routes.context, req.method, pathname)
			if (contextOf) {
				const breakdown = reads.getContextBreakdown(contextOf)
				if (!breakdown) return json(req, res, 404, { error: 'chat not found' })
				return json(req, res, 200, breakdown)
			}

			// GET /api/sessions/:id/models?workspaceId= — labels from Conductor's live picker
			const modelsOf = routeParam(routes.models, req.method, pathname)
			if (modelsOf) {
				const sessionId = modelsOf
				const frozen = workflowFrozenError(sessionId)
				if (frozen) return json(req, res, 409, frozen)
				const ws = reads.getWorkspace(url.searchParams.get('workspaceId') ?? '')
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				const located = locateChat(ws, sessionId)
				if ('error' in located) return json(req, res, 409, { error: located.error })
				const result = await listAgentModels({ workspace: ws, sessionId, tab: located.tab })
				if (result.ok && result.models)
					modelCache.remember(located.session?.agent_type, result.models, result.defaultModel)
				return json(req, res, result.ok ? 200 : 502, result)
			}

			// POST /api/sessions/:id/default-model { model, workspaceId? }
			// The picker star is a combined "set default and select" action, so this
			// changes both the user-wide default and this chat's model exactly as the
			// desktop control does.
			const defaultModelOf = routeParam(routes.defaultModel, req.method, pathname)
			if (defaultModelOf) {
				const sessionId = defaultModelOf
				const frozen = workflowFrozenError(sessionId)
				if (frozen) return json(req, res, 409, frozen)
				const body = JSON.parse((await readBody(req)) || '{}') as { model?: unknown; workspaceId?: unknown }
				if (typeof body.model !== 'string' || !body.model.trim()) {
					return json(req, res, 400, { error: 'model must be a picker label' })
				}
				const ws =
					typeof body.workspaceId === 'string'
						? reads.getWorkspace(body.workspaceId)
						: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				const located = locateChat(ws, sessionId)
				if ('error' in located) return json(req, res, 409, { error: located.error })
				const result = await setDefaultModel({ workspace: ws, sessionId, tab: located.tab }, body.model.trim())
				if (!result.ok || !result.model) {
					return json(req, res, 502, { ok: false, error: result.error ?? 'the default model did not change' })
				}
				const session = reads.listSessions(ws.id).find(row => row.id === sessionId)
				modelCache.rememberModel(session?.agent_type, result.model)
				modelCache.rememberDefault(result.model)
				return json(req, res, 200, { ok: true, defaultModel: result.model, session })
			}

			// POST /api/sessions/:id/agent  { effort?, plan?, fast?, model? }
			// Drives the composer's own model/effort/plan/fast controls for one chat.
			const agentOf = routeParam(routes.agent, req.method, pathname)
			if (agentOf) {
				const sessionId = agentOf
				const body = JSON.parse((await readBody(req)) || '{}') as {
					effort?: string
					plan?: boolean
					fast?: boolean
					model?: string
					workspaceId?: string
				}
				if (body.effort && !EFFORT_LABELS[body.effort]) {
					return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
				}
				const frozen = workflowFrozenError(sessionId)
				if (frozen && (body.model !== undefined || body.effort !== undefined || body.fast !== undefined)) {
					return json(req, res, 409, frozen)
				}
				const ws = body.workspaceId
					? reads.getWorkspace(body.workspaceId)
					: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				const applied = await applyAgentPatch(ws, sessionId, body)
				if (!applied.ok) return json(req, res, 502, { ok: false, strategy: actuator.name, error: applied.error })
				return json(req, res, 200, { ok: true, session: reads.listSessions(ws.id).find(s => s.id === sessionId) })
			}

			// POST /api/sessions/:id/stop — the desktop app's stop button, for one chat.
			const stopOf = routeParam(routes.stop, req.method, pathname)
			if (stopOf) {
				const sessionId = stopOf
				const body = JSON.parse((await readBody(req)) || '{}') as { workspaceId?: string }
				const ws = body.workspaceId
					? reads.getWorkspace(body.workspaceId)
					: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				const located = locateChat(ws, sessionId)
				if ('error' in located) return json(req, res, 409, { error: located.error })
				// Nothing running is a success, not an error: the phone shows Stop the moment it
				// sends (the optimistic hint) and a turn that ends on its own a beat before the tap
				// is the common case, not a mistake worth a red banner. It also keeps the one
				// keystroke this route presses off an idle chat entirely — Conductor's own
				// composer has no stop button to mis-tap there either.
				const before = reads.listSessions(ws.id).find(s => s.id === sessionId)
				if (before?.status !== 'working') {
					return json(req, res, 200, { ok: true, alreadyIdle: true, session: before })
				}
				const result = await stopTurn({ workspace: ws, sessionId, tab: located.tab })
				if (!result.ok) return json(req, res, 502, result)
				// The DB is the receipt, exactly as it is for agent settings: the keystroke is
				// fire-and-forget, so what counts is `status` leaving `working`. Conductor writes
				// that a beat after it tears the turn down.
				let observed = before.status
				for (let i = 0; i < 20 && observed === 'working'; i++) {
					await sleep(300)
					observed = reads.listSessions(ws.id).find(s => s.id === sessionId)?.status ?? observed
				}
				if (observed === 'working') {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error: 'Conductor took the stop but the agent is still working. Try again, or stop it on your Mac.'
					})
				}
				return json(req, res, 200, {
					ok: true,
					strategy: result.strategy,
					session: reads.listSessions(ws.id).find(s => s.id === sessionId)
				})
			}

			// DELETE /api/sessions/:id { workspaceId?, closeRunning? } — Conductor's
			// reversible Close tab action (Command-W). A running chat gets the same
			// explicit "Close anyway" gate as the desktop app.
			const closeChatId = routeParam(routes.closeChat, req.method, pathname)
			if (closeChatId) {
				const sessionId = closeChatId
				const body = JSON.parse((await readBody(req)) || '{}') as {
					workspaceId?: string
					closeRunning?: boolean
				}
				const ownerId = reads.sessionWorkspaceId(sessionId)
				if (!ownerId) return json(req, res, 404, { error: 'chat not found' })
				if (body.workspaceId && body.workspaceId !== ownerId) {
					return json(req, res, 409, { error: 'chat is not in that workspace' })
				}
				const ws = reads.getWorkspace(ownerId)
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })

				const before = reads.listSessions(ws.id)
				const session = before.find(s => s.id === sessionId)
				const visibleActiveSession = (): string | null => {
					const visible = reads.listSessions(ws.id)
					const activeId = reads.getWorkspace(ws.id)?.active_session_id
					return visible.some(s => s.id === activeId) ? (activeId ?? null) : (visible[0]?.id ?? null)
				}
				// Closing is a soft delete. A repeat whose first response was lost is already
				// in the requested state, so it is success rather than a stale-link error.
				if (!session) {
					return json(req, res, 200, {
						ok: true,
						alreadyClosed: true,
						activeSessionId: visibleActiveSession()
					})
				}
				if ((session.status === 'working' || session.background_tasks.length > 0) && body.closeRunning !== true) {
					return json(req, res, 409, {
						ok: false,
						agentRunning: true,
						error: 'The agent is still working in this chat. Confirm closing it anyway.'
					})
				}
				const located = locateChat(ws, sessionId)
				if ('error' in located) return json(req, res, 409, { error: located.error })
				const result = await closeChat({ workspace: ws, sessionId, tab: located.tab }, body.closeRunning === true)
				if (!result.ok) {
					// A turn can start after the status read above. The script dismisses
					// Conductor's surprise dialog instead of accepting it, and this sends the
					// caller back through the same explicit confirmation path.
					if (body.closeRunning !== true && result.error?.includes('needs confirmation')) {
						return json(req, res, 409, {
							ok: false,
							agentRunning: true,
							error: 'The agent is still working in this chat. Confirm closing it anyway.'
						})
					}
					return json(req, res, 502, result)
				}

				// Command-W is fire-and-forget. The durable receipt is the same flag all tab
				// reads filter on: this id disappearing from listSessions means Conductor set
				// sessions.is_hidden, not merely that a keystroke happened.
				let visible = true
				for (let i = 0; i < 20 && visible; i++) {
					await sleep(300)
					visible = reads.listSessions(ws.id).some(s => s.id === sessionId)
				}
				if (visible) {
					return json(req, res, 502, {
						ok: false,
						strategy: result.strategy,
						error: 'Conductor took the close but the chat tab is still open. Try again, or close it on your Mac.'
					})
				}
				return json(req, res, 200, {
					ok: true,
					strategy: result.strategy,
					activeSessionId: visibleActiveSession()
				})
			}

			// POST /api/sessions/:id/attachments?workspaceId= — raw bytes from the phone.
			// Conductor derives an attachment from this on-disk layout plus the composer
			// token, so its own database stays read-only from this relay's point of view.
			const uploadTo = routeParam(routes.uploadAttachment, req.method, pathname)
			if (uploadTo) {
				const sessionId = uploadTo
				const ownerId = reads.sessionWorkspaceId(sessionId)
				const workspaceId = url.searchParams.get('workspaceId') ?? ownerId
				const ws = workspaceId ? reads.getWorkspace(workspaceId) : null
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				if (!ownerId || ownerId !== ws.id) return json(req, res, 409, { error: 'chat is not in that workspace' })
				if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
				const name = attachmentHeaderName(req)
				if (!name) return json(req, res, 400, { error: 'missing attachment name' })
				const bytes = await readAttachmentBody(req)
				if (!bytes.length) return json(req, res, 400, { error: 'empty attachment' })
				const attachment = writeAttachment(ws.worktree, name, bytes)
				return json(req, res, 200, {
					ok: true,
					attachment: {
						name: attachment.name,
						path: attachment.relPath,
						bytes: attachment.bytes,
						token: attachment.token
					}
				})
			}

			const delegateFrom = routeParam(routes.delegateTask, req.method, pathname)
			if (delegateFrom) {
				return json(
					req,
					res,
					409,
					intakeError('workflow_required', 'delegate_task is available only inside a UI-authorized Workflow.')
				)
			}

			// POST /api/sessions/:id/prompt { text, agent? } — ordinary staged settings
			// are applied before the prompt so the two cannot come apart.
			const promptTo = routeParam(routes.sendPrompt, req.method, pathname)
			if (promptTo) {
				const sessionId = promptTo
				const body = JSON.parse((await readBody(req)) || '{}') as Partial<SendPromptRequest>
				if ('workflow' in body) {
					return json(req, res, 400, { error: 'Workflow starts through POST /api/workflows.' })
				}
				if (body.text !== undefined && typeof body.text !== 'string') {
					return json(req, res, 400, { error: 'prompt must be a string' })
				}
				const rawText = (body.text ?? '').trim()
				if (!rawText) return json(req, res, 400, { error: 'empty prompt' })
				if (body.agent !== undefined && (!body.agent || typeof body.agent !== 'object' || Array.isArray(body.agent))) {
					return json(req, res, 400, { error: 'agent must be a settings object' })
				}
				const requestedAgent = body.agent && Object.keys(body.agent).length ? body.agent : undefined
				const frozen = workflowFrozenError(sessionId)
				if (
					frozen &&
					requestedAgent &&
					(requestedAgent.model !== undefined ||
						requestedAgent.effort !== undefined ||
						requestedAgent.fast !== undefined)
				) {
					return json(req, res, 409, frozen)
				}
				const ws = body.workspaceId
					? reads.getWorkspace(body.workspaceId)
					: (reads.listWorkspaces().find(w => w.active_session_id === sessionId) ?? null)
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				// One deadline for the whole request: settings eat into the send's budget
				// rather than extending it past what the phone said it would wait.
				const deadline = Date.now() + sendBudget(req)
				const queue = body.queue === true
				if (requestedAgent?.effort && !EFFORT_LABELS[requestedAgent.effort]) {
					return json(req, res, 400, { error: `effort must be one of ${Object.keys(EFFORT_LABELS).join(', ')}` })
				}
				// One prompt per intent (src/sendonce.ts). Everything that can *say something
				// to Conductor* sits inside, so an answer the phone never heard is replayed
				// rather than re-performed — including the parked branches, since parking the
				// same intent twice queues the same prompt twice for the unlock.
				if (body.clientId && sendOnce.recall(body.clientId)) {
					console.info(
						`[relay] send to ${ws.branch ?? ws.id} already delivered for this tap — answering, not resending`
					)
				}
				const answer = await sendOnce.run(body.clientId, async () => {
					const text = rawText
					const agent = requestedAgent
					// A failed first-prompt entry offers the same Retry button as an ordinary
					// prompt. If staging had been the failure, put its files in place before
					// that retry reaches the attachment tokens.
					const first = firstPrompts.get(ws.id)
					if (first?.attachmentIds?.length && first.text === text) {
						if (!ws.worktree)
							return {
								status: 409,
								body: { ok: false, strategy: actuator.name, error: 'worktree path unresolved' }
							}
						try {
							materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, ws.worktree, first.attachmentIds)
						} catch (err) {
							return {
								status: 409,
								body: {
									ok: false,
									strategy: actuator.name,
									error: err instanceof Error ? err.message : 'the attached files could not be copied'
								}
							}
						}
					}
					if (agent) {
						const applied = await applyAgentPatch(ws, sessionId, agent)
						if (!applied.ok) {
							if (lockBlocked(applied.error)) {
								const queued = parkedPrompts.park(ws.id, sessionId, text, agent, queue)
								return {
									status: 202,
									body: { ok: false, parked: true, queued, strategy: actuator.name, error: PARKED_ERROR }
								}
							}
							return { status: 502, body: { ok: false, strategy: actuator.name, error: applied.error } }
						}
					}
					// Retries live inside deliverPrompt, confirmed against the transcript each time,
					// and inside the deadline this phone told us it would wait.
					const result = await deliverPrompt(ws, sessionId, text, deadline - Date.now(), queue)
					if (result.ok) {
						// Whatever a queue was still holding has now been said by hand — the first
						// prompt (including a failed entry retried from the chat), and any parked
						// copy of this exact text, which delivering again would double.
						firstPrompts.forget(ws.id)
						parkedPrompts.forgetDelivered(sessionId, text)
						return { status: 200, body: result }
					}
					if (lockBlocked(result.error)) {
						// Settings (if any) already stuck, so the entry parks without them.
						const queued = parkedPrompts.park(ws.id, sessionId, text, undefined, queue)
						return {
							status: 202,
							body: { ok: false, parked: true, queued, strategy: result.strategy, error: PARKED_ERROR }
						}
					}
					return { status: 502, body: result }
				})
				return json(req, res, answer.status, answer.body)
			}

			// POST /api/sessions/:id/split
			//      { prompt?, includeThinking?, includeTools?, throughRowid?, onlyRowid?, destination? }
			//
			// Conductor's own tab fork resumes the agent's real session. This copies the
			// conversation instead, as a Conductor attachment, which is the cut that survives
			// being read by a *different* agent: prose and reasoning, no tool churn. Its
			// destination can be another tab over the same files, or a new workspace whose
			// Git layers are restored from the source's current worktree snapshot.
			// Two reasons it exists at all. A tangent asked inside a running chat leaves three
			// conversations interleaved in one tab, which reads badly for everyone afterwards;
			// and Conductor's fork lives on a hover menu over one message, which an agent
			// cannot reach and which the relay would have to find by walking a transcript that
			// gets more expensive the longer the chat is.
			//
			// It stops before sending. The composed prompt goes out through the ordinary send
			// route so it inherits the retry loop, the transcript confirm and the parked queue.
			// For a tab, that also keeps ⌘T plus a send from becoming two UI turns inside one
			// request (28s + 55s against the MCP client's 75s); for a workspace it leaves the
			// staged handoff as the same editable draft the phone already presents for a tab.
			const splitFrom = routeParam(routes.splitChat, req.method, pathname)
			if (splitFrom) {
				const sessionId = splitFrom
				const body = JSON.parse((await readBody(req)) || '{}') as {
					prompt?: string
					workspaceId?: string
					includeThinking?: boolean
					includeTools?: boolean
					throughRowid?: number
					onlyRowid?: number
					destination?: 'chat' | 'workspace'
				}
				// `active_session_id` is how every other route resolves this, and it would only
				// ever find the tab on screen. Splitting a chat you are not looking at is the
				// normal case here, so the session's own column decides.
				const workspaceId = body.workspaceId ?? reads.sessionWorkspaceId(sessionId)
				const ws = workspaceId ? reads.getWorkspace(workspaceId) : null
				if (!ws) return json(req, res, 404, { error: 'workspace for session not found' })
				if (!ws.worktree) return json(req, res, 409, { error: 'worktree path unresolved' })
				const source = reads.listSessions(ws.id).find(s => s.id === sessionId)
				if (!source) return json(req, res, 404, { error: 'chat not found in that workspace' })
				const destination = body.destination ?? 'chat'
				if (destination !== 'chat' && destination !== 'workspace') {
					return json(req, res, 400, { error: 'destination must be chat or workspace' })
				}

				const format = { thinking: body.includeThinking !== false, tools: body.includeTools === true }
				const { entries } = reads.getMessages(sessionId)
				const through = body.throughRowid
				const only = body.onlyRowid
				if (through !== undefined && (!Number.isSafeInteger(through) || through < 1)) {
					return json(req, res, 400, { error: 'throughRowid must be a positive integer' })
				}
				if (only !== undefined && (!Number.isSafeInteger(only) || only < 1)) {
					return json(req, res, 400, { error: 'onlyRowid must be a positive integer' })
				}
				if (through !== undefined && only !== undefined) {
					return json(req, res, 400, { error: 'throughRowid and onlyRowid cannot be combined' })
				}
				const cut =
					only !== undefined
						? transcriptMessage(entries, only)
						: through === undefined
							? { entries, earlier: 0, later: 0 }
							: transcriptThrough(entries, through)
				if (!cut) return json(req, res, 409, { error: 'that message is not in this chat' })
				const rendered = renderTranscript(cut.entries, format)
				const elided = { ...rendered.elided, earlier: 'earlier' in cut ? cut.earlier : 0, later: cut.later }
				if (!rendered.kept) return json(req, res, 409, { error: 'that chat has nothing to copy yet' })

				// Conductor's own name for a copied transcript, so the chip reads the same as one
				// saved by hand. The header states the cut, because a transcript that silently
				// drops half a chat is worse than one that admits to it.
				const title = source.title?.trim() || 'chat'
				const carried = [`thinking ${format.thinking ? 'included' : 'omitted'}`]
				carried.push(`tool calls ${format.tools ? 'included' : 'omitted'}`)
				const stops =
					only !== undefined
						? ['The copy contains only the selected source message; all earlier and later messages are omitted.']
						: cut.later
							? [
									`The copy stops partway through: ${cut.later} later ${cut.later === 1 ? 'entry is' : 'entries are'} not in it.`
								]
							: []
				const header = [
					`# Transcript of ${title}`,
					'',
					`${[ws.repo_name, ws.branch].filter(Boolean).join(' · ')}`,
					`Copied from the Conductor chat \`${sessionId}\` by conductor-remote. ${carried.join(', ')}.`,
					...stops,
					'',
					''
				].join('\n')
				const transcript = header + rendered.text

				if (destination === 'workspace') {
					if (!(ws.repo_name && ws.repo_root)) {
						return json(req, res, 409, { error: 'the source workspace has no repository checkout to fork' })
					}

					let snapshot: Awaited<ReturnType<typeof captureForkWorkspace>>
					try {
						snapshot = await captureForkWorkspace(ws.worktree)
					} catch (err) {
						const reason = err instanceof Error ? err.message : 'Git could not capture the worktree'
						return json(req, res, 502, { error: `Could not snapshot the source workspace: ${reason}` })
					}

					let staged: ReturnType<typeof stageAttachment> | undefined
					let materialized = false
					let created: Workspace | undefined
					try {
						staged = stageAttachment(STAGED_ATTACHMENTS_DIR, `Transcript of ${title}.md`, Buffer.from(transcript))
						const creation = await createWorkspaceAndRead('', ws.repo_root, ws.repo_name)
						if (!creation.result.ok) return json(req, res, 502, creation.result)
						created = creation.created
						if (!created) {
							return json(req, res, 502, {
								error: 'Conductor didn’t create the fork workspace — check it’s running and not showing a dialog.'
							})
						}

						// The DB row can precede `.git` by a tick. Install the snapshot at the
						// first verified worktree path, before Conductor starts the new agent.
						let target = reads.getWorkspace(created.id) ?? created
						for (let attempt = 0; attempt < 20 && !target.worktree; attempt++) {
							await sleep(250)
							target = reads.getWorkspace(created.id) ?? target
						}
						if (!target.worktree) throw new Error('the new workspace worktree path never became available')
						await materializeForkWorkspace(snapshot, target.worktree)
						materializeStagedAttachments(STAGED_ATTACHMENTS_DIR, target.worktree, [staged.stageId])
						materialized = true
						discardStagedAttachment(STAGED_ATTACHMENTS_DIR, staged.stageId)

						let destinationSession = reads.listSessions(created.id)[0]
						for (let attempt = 0; attempt < 12 && !destinationSession; attempt++) {
							await sleep(250)
							destinationSession = reads.listSessions(created.id)[0]
						}
						return json(req, res, 200, {
							ok: true,
							destination,
							sessionId: destinationSession?.id ?? null,
							workspaceId: created.id,
							text: attachmentPrompt(staged.token, body.prompt),
							attachment: {
								name: staged.name,
								path: staged.path,
								bytes: staged.bytes,
								kept: rendered.kept,
								elided
							}
						})
					} catch (err) {
						const reason = err instanceof Error ? err.message : 'the current files could not be copied'
						return json(req, res, 502, {
							error: created
								? `Workspace ${created.id} was created, but its code fork failed: ${reason}`
								: `Could not create the code fork: ${reason}`
						})
					} finally {
						if (staged && !materialized) discardStagedAttachment(STAGED_ATTACHMENTS_DIR, staged.stageId)
						await releaseForkWorkspace(snapshot).catch(err => {
							console.warn(
								`[relay] could not release fork snapshot ${snapshot.ref}: ${err instanceof Error ? err.message : err}`
							)
						})
					}
				}

				const attachment = writeAttachment(ws.worktree, `Transcript of ${title}.md`, transcript)

				const opened = await openChat(ws)
				if ('error' in opened) {
					return json(req, res, 502, {
						...opened.result,
						destination,
						attachment: { ...attachment, ...rendered, elided }
					})
				}
				// The token is what Conductor turns into the attachment chip and supplies to the
				// receiving agent. Do not repeat `attachment.relPath` in prose: that renders a
				// second link to the same transcript in the new chat.
				const text = attachmentPrompt(attachment.token, body.prompt)
				return json(req, res, 200, {
					ok: true,
					destination,
					sessionId: opened.sessionId,
					workspaceId: ws.id,
					text,
					attachment: {
						name: attachment.name,
						path: attachment.relPath,
						bytes: attachment.bytes,
						kept: rendered.kept,
						elided
					}
				})
			}

			// DELETE /api/workspaces/:id/prompt — dismiss an undelivered first prompt
			const forgetFirst = routeParam(routes.dismissFirstPrompt, req.method, pathname)
			if (forgetFirst) {
				const workspaceId = forgetFirst
				if (!firstPrompts.forget(workspaceId)) return json(req, res, 404, { error: 'no pending prompt' })
				return json(req, res, 200, { ok: true })
			}

			// DELETE /api/sessions/:id/prompt — dismiss whatever is parked for this chat
			const forgetParked = routeParam(routes.dismissParkedPrompt, req.method, pathname)
			if (forgetParked) {
				const sessionId = forgetParked
				if (!parkedPrompts.forgetSession(sessionId)) return json(req, res, 404, { error: 'no parked prompt' })
				return json(req, res, 200, { ok: true })
			}

			return json(req, res, 404, { error: 'no route', pathname })
		} catch (err) {
			if (err instanceof PayloadTooLargeError) return json(req, res, 413, { error: err.message })
			const workflowError = workflowHttpError(err)
			if (workflowError) {
				console.warn(
					`[workflow] ${req.method} ${pathname}: ${workflowError.error.code}: ${workflowError.error.message}`
				)
				return json(req, res, workflowError.status, { ok: false, error: workflowError.error })
			}
			// A refused UI turn is not a server fault and a retry is the right move, so it gets
			// 503 + Retry-After rather than a 500 that reads as "the relay is broken".
			if (err instanceof UiBusyError) {
				res.setHeader('retry-after', '15')
				return json(req, res, 503, { error: err.message, busy: true, queue: uiQueueDepth() })
			}
			// Log the detail locally; don't reflect internals (paths, stack strings) back over the wire.
			console.error(`[relay] ${req.method} ${pathname} failed:`, err)
			return json(req, res, 500, { error: 'internal error' })
		}
	})
})

server.listen(cfg.port, cfg.host, () => {
	voiceServer.listen(voicePort(), '127.0.0.1', () => {
		console.info(`  voice:      127.0.0.1:${voicePort()}${voiceBroker ? '' : ' (waiting for OpenAI config)'}`)
		void voiceBroker?.restore()
	})
	if (orchestration.writable) {
		setInterval(() => orchestration.heartbeatRelayInstance(relayIdentity), 2_000).unref()
		setInterval(() => void recoverUiLease(), 2_000).unref()
		setInterval(wakeWorkflows, 2_000).unref()
		setInterval(
			() => orchestration.compactTerminalRuns({ olderThan: Date.now() - 30 * 24 * 60 * 60_000 }),
			24 * 60 * 60_000
		).unref()
		queueMicrotask(() => void recoverUiLease().finally(wakeWorkflows))
	}
	// Under `yarn dev` the app comes from Vite and only /api comes from here, so the URL worth
	// printing is Vite's — carrying the token, which Vite itself has no way to print.
	const dev = cfg.devWebPort !== undefined
	console.info(
		[
			'conductor-remote relay up',
			`  db:         ${cfg.dbPath}`,
			`  worktrees:  ${cfg.workspacesRoot}`,
			`  actuator:   ${actuator.name}`,
			`  bound:      ${cfg.host}:${cfg.port}${dev ? '  (/api only — Vite serves the app)' : ''}`,
			'',
			dev
				? `  Local:  http://localhost:${cfg.devWebPort}/#token=${cfg.token}`
				: `  Local:  http://${cfg.host}:${cfg.port}/#token=${cfg.token}`,
			dev
				? "  Phone:  same URL with this Mac's tailnet IP in place of localhost (Vite prints it as `Network:`)"
				: '  Phone:  fronted by `tailscale funnel`/`serve` — run `yarn service status` for the HTTPS URL'
		].join('\n')
	)
	// Loud, actionable warning in relay.log if the node's MagicDNS name drifted from the saved phone URL's host
	// (a renamed node silently bricks the installed PWA). No-ops until a drift-aware deploy recorded a baseline.
	const tsBin = tailscaleBin()
	if (tsBin) {
		const drift = driftWarningLines(tsBin)
		if (drift.length) console.info(`\n${drift.join('\n')}`)
	}
	// Pick up any first prompt the previous process was still holding — an auto-update
	// restart lands mid-setup often enough that this is the normal path, not a rare one.
	firstPrompts.start()
	// New Workspace uploads are host-side so another device can restore their pills.
	// Sweep only week-old directories absent from both a draft and the delivery queue.
	sweepStagedAttachments()
	setInterval(sweepStagedAttachments, STAGED_ATTACHMENT_SWEEP_MS).unref()
	// Same for prompts parked behind the lock screen — a lock outlives relay restarts.
	parkedPrompts.start()
	// Active/failed delegation state lives in each live worktree. Register every
	// store on startup; the queue resumes side-effect stages at least once.
	delegationQueue.resume(liveDelegationStores())
	// A launchd/self-update restart kills the loopback bridge but not Tailscale's
	// persisted Serve mapping. Rebuild bridges for dev servers that are still up,
	// and remove this relay's stale mappings for ones that are not.
	void devServers.restore()
	// Keep the managed global daemon current — no-ops for dev checkouts / unmanaged runs (see autoupdate.ts).
	startAutoUpdate()
	// Keep the phone's public URL reachable — re-registers Funnel when its ingress goes stale after a
	// network change. No-ops unless managed + public (Funnel) posture (see funnel-watchdog.ts).
	startFunnelWatchdog()
	// One base DB read fans out to notification and orchestration listeners. Push can
	// be disabled or have zero devices without stopping the clock delegated jobs need.
	startNotifier(reads, sessionPoller)
	sessionPoller.start()
	// Watch armed keep-awake windows for their recorded expiry: the helper's restore only
	// re-allows sleep, so a lid still shut at expiry needs the relay's `pmset sleepnow`
	// (see nosleep.ts). Also picks a window back up after the relay's own restarts.
	watchNoSleepExpiry()
})
