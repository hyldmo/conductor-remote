/**
 * The HTTP contract: every shape that crosses `/api`, in one place, named once.
 *
 * This file holds **no runtime code**. It re-exports the relay's own domain types
 * under the names the wire uses, and declares the response envelopes the route
 * handlers assemble. Three callers read it and none of them may disagree:
 *
 *   - `src/server.ts` builds these payloads,
 *   - `web/src/lib/types.ts` re-exports the lot for the PWA,
 *   - `src/mcp-tools.ts` annotates its relay calls with them.
 *
 * Before this, the phone kept a hand-written mirror of all of it and `mcp-tools.ts`
 * kept a third copy inline. Nothing enforced the copies — a field renamed in
 * `reads.ts` typechecked cleanly on both sides and surfaced as `undefined` on a
 * phone. So the rule is: **a shape that leaves the relay is declared here, and
 * nowhere else.**
 *
 * The web app may only `import type` from `src/` (see `scripts/check-imports.ts`).
 * `verbatimModuleSyntax` erases those imports, so nothing here reaches the bundle —
 * which is what lets a type live beside the `node:sqlite` code that produces it.
 * The one exception is `src/shared.ts`, which is stdlib-free on purpose.
 */

import type { UpdateStatus } from './autoupdate.ts'
import type { DefaultEfforts } from './conductor-settings.ts'
import type { ContextBreakdown } from './context-breakdown.ts'
import type { DevServerForward, DevServerResult, DevServerState } from './dev-server.ts'
import type { FirstPrompt } from './firstprompt.ts'
import type { LogEntry, LogFileInfo } from './logbuf.ts'
import type { CachedModelGroup } from './model-cache.ts'
import type { NoSleepState } from './nosleep.ts'
import type { DeviceInfo } from './notify.ts'
import type { ParkedAgentPatch, ParkedPrompt } from './parked.ts'
import type {
	PlanUsageBucket,
	PlanUsageProviderId,
	PlanUsageSnapshot,
	PlanUsageWindow,
	ProviderPlanUsage
} from './plan-usage.ts'
import type { DraftAttachment, Prefs, SyncedDraft } from './prefs.ts'
import type { ClosedSession, Workspace as ReadWorkspace, RepoRow, SearchWorkspace, SessionRow } from './reads.ts'
import type { DevRunConfig } from './run-configs.ts'
import type { IndexStatus, SearchResult as SearchEvidence } from './search.ts'
import type { Settings } from './settings.ts'
import type { OpenAIRealtimeVoice, VoiceLanguage } from './shared.ts'
import type { ToolUsageSnapshot } from './tool-usage.ts'
import type { TranscriptEntry } from './transcript.ts'
import type { ActuatorInfo, SendResult as ActuatorSendResult } from './writes.ts'

export type { BackgroundTask } from './background-tasks.ts'
export type { DiffFile, DiffStats, WorkspaceDiff, WorkspaceFileDiff } from './git.ts'
export type { RepoIcon } from './icons.ts'
export type { LogLevel } from './logbuf.ts'
export type { MergeMethod, MergeResult } from './merge.ts'
export type { NoSleepResult } from './nosleep.ts'
export type { PrStatus, UnreadSession } from './reads.ts'
export type { SearchRole, SearchSnippet } from './search.ts'
export type { VoiceCallTarget } from './voice/context.ts'
export type {
	ActuatorInfo,
	CachedModelGroup,
	DefaultEfforts,
	DeviceInfo as PushDevice,
	DevRunConfig,
	DevServerForward,
	DevServerResult,
	DevServerState,
	DraftAttachment,
	IndexStatus as SearchIndexStatus,
	LogEntry,
	LogFileInfo,
	NoSleepState,
	OpenAIRealtimeVoice,
	/** What the phone can change about a chat's agent. */
	ParkedAgentPatch as AgentPatch,
	PlanUsageBucket,
	PlanUsageProviderId,
	PlanUsageSnapshot,
	PlanUsageWindow,
	Prefs,
	ProviderPlanUsage,
	RepoRow as Repo,
	SearchWorkspace,
	SessionRow as Session,
	Settings as RelaySettings,
	SyncedDraft,
	TranscriptEntry,
	UpdateStatus,
	VoiceLanguage
}

// ── delegated roles ─────────────────────────────────────────────────────────────

/** Stable effort keys accepted by the relay, independent of each provider's UI labels. */
export type AgentEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'

/** One reusable cross-provider role. Plan mode is deliberately not part of this feature. */
export interface DelegatedRole {
	/** Exact label from Conductor's model picker. */
	model: string
	effort?: AgentEffort
	fast?: boolean
	/** Prepended to the attachment and delegated task. */
	preamble?: string
}

/** A role frozen at intake with the provider encoded by its exact picker label. */
export interface ResolvedDelegatedRole extends DelegatedRole {
	agentType: string
}

/** The versioned document persisted at `stateDir()/roles.json`. */
export interface RolesConfig {
	version: 1
	roles: Record<string, DelegatedRole>
}

export type DelegationReturnMode = 'queue' | 'steer'

export type DelegationStatus =
	| 'queued'
	| 'opening'
	| 'configuring'
	| 'sending'
	| 'running'
	| 'returning'
	| 'returned'
	| 'failed'

/** Codes are stable for the phone and MCP; `message` remains the useful human detail. */
export type DelegationErrorCode =
	| 'invalid_request'
	| 'role_not_found'
	| 'model_missing'
	| 'provider_unknown'
	| 'same_provider'
	| 'workspace_not_found'
	| 'session_not_found'
	| 'delegation_not_found'
	| 'worktree_unavailable'
	| 'state_invalid'
	| 'opening_failed'
	| 'configuration_failed'
	| 'send_failed'
	| 'completion_failed'
	| 'return_failed'
	| 'workflow_required'
	| 'workflow_authorization_failed'
	| 'workflow_phase_invalid'
	| 'workflow_role_frozen'
	| 'workflow_incompatible_relay'
	| 'workflow_blocked'
	| 'idempotency_conflict'
	| 'ambiguous_effect'

export interface DelegationError {
	code: DelegationErrorCode
	message: string
	/** A retry can make progress without changing the role or request. */
	retryable: boolean
}

/** Only states Conductor actually exposes are represented; questions stay in Baton content. */
export type DelegationOutcome =
	| {
			kind: 'success'
			assistantRowid: number
			text: string
	  }
	| {
			kind: 'error'
			assistantRowid?: number
			text?: string
			error: string
	  }

/** Durable identity for role chips; successful jobs may be gone while this remains. */
export interface SessionRoleAssignment {
	role: string
	delegationId?: string
	/** Durable parent for an ad hoc child, including after its successful job is removed. */
	parentSessionId?: string
	workflowId?: string
	assignedAt: number
}

/** Active/failed job shape projected into `/api/state` and list responses. */
export interface DelegationProjection {
	id: string
	/** Present for coordinator-owned jobs; absent on ad hoc JSON delegation jobs. */
	workflowId?: string
	/** Stable identity across retries of one logical Workflow job. */
	logicalKey?: string
	/** The guaranteed first explorer created with the Workflow run. */
	bootstrap?: boolean
	workspaceId: string
	parentSessionId: string
	childSessionId?: string
	role: string
	resolvedRole: ResolvedDelegatedRole
	prompt: string
	returnMode: DelegationReturnMode
	status: DelegationStatus
	attempts: number
	createdAt: number
	updatedAt: number
	outcome?: DelegationOutcome
	failure?: DelegationError
}

// ── deterministic Workflows ─────────────────────────────────────────────────────

export type WorkflowPhase =
	| 'creating_workspace'
	| 'binding_root'
	| 'pending_root'
	| 'exploring'
	| 'planning'
	| 'implementing'
	| 'reviewing'
	| 'blocked'
	| 'completed'
	| 'cancelled'

export type WorkflowRoleName = 'planning' | 'exploration' | 'implementation'
export type WorkflowChildRoleName = Exclude<WorkflowRoleName, 'planning'>

/** Frozen role data safe to expose; preambles and capability material never cross this boundary. */
export interface PublicFrozenRole {
	model: string
	agentType: string
	effort?: AgentEffort
	fast?: boolean
}

export interface WorkflowJobCounts {
	requested: number
	running: number
	returned: number
	failed: number
}

export interface WorkflowAdoptionCandidate {
	id: string
	title: string
	repo: string
	createdAt: number
}

/** Bounded public recovery evidence. Raw window/process evidence remains relay-private. */
export interface WorkflowAdoption {
	actionId: string
	kind: 'workspace' | 'session'
	candidates: WorkflowAdoptionCandidate[]
}

/** The deliberately small, secret-free Workflow projection returned by `/api/state`. */
export interface WorkflowRunWire {
	id: string
	workspaceId?: string
	rootSessionId?: string
	phase: WorkflowPhase
	objectiveExcerpt: string
	roles: Record<WorkflowRoleName, PublicFrozenRole>
	jobs: {
		exploration: WorkflowJobCounts
		implementation: WorkflowJobCounts
	}
	error?: { code: string; message: string; retryable: boolean }
	adoption?: WorkflowAdoption
	actions: {
		canRetry: boolean
		canAdopt: boolean
		canReplayAmbiguous: boolean
		canCancel: boolean
		canComplete: boolean
	}
	createdAt: number
	updatedAt: number
}

/** Newest durable run identity retained for a workspace after its active Workflow leaves the live run list. */
export type WorkflowIdentityWire = Pick<WorkflowRunWire, 'id' | 'phase' | 'roles'>

export type StartWorkflowRequest =
	| {
			clientId: string
			objective: string
			target: { kind: 'new_workspace'; repo: string; sendImmediately: boolean }
	  }
	| {
			clientId: string
			objective: string
			target: { kind: 'existing_session'; workspaceId: string; sessionId: string }
	  }

export interface StartWorkflowResponse {
	workflow: WorkflowRunWire
}

/** Strict MCP-to-relay contract. Unknown/override fields are rejected by the handler. */
export interface WorkflowDelegateRequest {
	workflow_id: string
	phase_capability: string
	session_id: string
	role: WorkflowChildRoleName
	prompt: string
}

export type WorkflowDelegateResult =
	| {
			ok: true
			workflowId: string
			delegationId: string
			role: WorkflowChildRoleName
			model: string
	  }
	| {
			ok: false
			error: DelegationError
	  }

/** Lightweight delegation from an ordinary chat; settings come from the named role. */
export interface DelegateTaskRequest {
	role: string
	prompt: string
	returnMode?: DelegationReturnMode
	throughRowid?: number
	includeThinking?: boolean
}

export type DelegateTaskResult =
	| { ok: true; delegationId: string; role: string; model: string }
	| { ok: false; error: DelegationError }

export interface WorkflowRetryRequest {
	clientId: string
}

export type WorkflowAdoptRequest = {
	clientId: string
	actionId: string
} & ({ workspaceId: string; sessionId?: never } | { workspaceId?: never; sessionId: string })

export interface WorkflowReplayRequest {
	clientId: string
	actionId: string
	confirmDuplicateRisk: true
}

export interface WorkflowCompleteRequest {
	clientId: string
}

export interface WorkflowCancelRequest {
	clientId: string
}

export interface WorkflowMutationResponse {
	workflow: WorkflowRunWire
}

/**
 * Global UI hold after a relay died past the durable may-execute boundary.
 * Process identity and raw diagnostics deliberately stay on the relay.
 */
export interface UiQuarantineWire {
	active: true
	reason: string
	createdAt: number
	actionId?: string
	effectId?: string
}

/** Explicit phone acknowledgement; `true` prevents an accidental generic POST from clearing the hold. */
export interface ConfirmUiStableRequest {
	clientId: string
	confirmStable: true
	/** Compare-and-clear fingerprint from the exact banner the person inspected. */
	createdAt: number
	actionId?: string
	effectId?: string
}

export interface ConfirmUiStableResponse {
	ok: true
}

/** The live workspace enriched by relay-owned orchestration state. */
export type Workspace = ReadWorkspace & {
	delegations?: DelegationProjection[]
	session_roles?: Record<string, SessionRoleAssignment>
	workflow?: WorkflowRunWire
	/** Sidebar identity for the newest terminal run; active controls continue to use `workflow`. */
	workflow_identity?: WorkflowIdentityWire
	/** A malformed/unsupported worktree file is preserved and reported here. */
	delegation_warning?: string
}

export interface RolesResponse extends RolesConfig {
	/** Invalid templates stay editable and visible instead of being silently replaced. */
	issues: Array<{ role: string; error: DelegationError }>
	/** The on-disk document was preserved but could not be decoded. */
	warning?: string
}

export type UpdateRolesResult =
	| { ok: true; config: RolesConfig }
	| { ok: false; error: DelegationError; issues?: Array<{ role: string; error: DelegationError }> }

export interface DelegationsResponse {
	delegations: DelegationProjection[]
}

export type DismissDelegationResult = { ok: true; delegationId: string } | { ok: false; error: DelegationError }

/**
 * A prompt the relay is holding and will deliver itself: a workspace's first prompt
 * waiting on setup (`src/firstprompt.ts`), or one parked for the lock screen
 * (`src/parked.ts`). Widened rather than a union, because the chat renders both with
 * one bubble and reads `reason` off either — the fields only a parked entry has are
 * optional here and required there.
 */
export type PendingPrompt = FirstPrompt & Partial<Omit<ParkedPrompt, keyof FirstPrompt>>

// ── envelopes ───────────────────────────────────────────────────────────────────
// The shapes that exist only as a response body. Everything above is a domain type
// the relay already had a name for.

/** GET /api/state — the sidebar, plus what the Connect sheet shows about this relay. */
export interface StateResponse {
	workspaces: Workspace[]
	/** Active/reviewing/blocked runs, including accepted runs not bound to a workspace yet. */
	workflows?: WorkflowRunWire[]
	/** Global and independent of run lifetime: a cancelled Workflow may still have left the UI ambiguous. */
	uiQuarantine?: UiQuarantineWire
	/** Scrubbed blocking reason when orchestration state cannot safely be projected or mutated. */
	workflowWarning?: string
	actuator: ActuatorInfo
	/** Relay version this daemon is running. */
	version?: string
	/** Self-update state (see src/autoupdate.ts). */
	update?: UpdateStatus
}

/** One workspace a search matched, with the chat evidence and the tab title to show. */
export interface SearchResult extends SearchEvidence<SearchWorkspace> {
	sessionTitle: string | null
}

/** GET /api/search?q=&repo=&archived=0 — name and transcript matches, merged and ranked. */
export interface SearchResponse {
	query: string
	/** Repo names the search was scoped to; empty means every repo. */
	repos: string[]
	index: IndexStatus
	results: SearchResult[]
}

/** GET /api/repos */
export interface ReposResponse {
	repos: RepoRow[]
}

/** POST /api/voice/ticket — a fresh, short-lived URI; all permanent secrets stay on the relay. */
export interface VoiceTicketResponse {
	uri: string
	expiresAt: string
}

/** POST /api/voice/calls — OpenAI's answer plus the sideband call receipt. */
export interface VoiceCallResponse {
	/** Opaque OpenAI call id used only for ready/end requests to this relay. */
	callId: string
	/** SDP answer installed as the WebRTC peer's remote description. */
	sdp: string
}

/** Locally archived voice text, independent of any Conductor workspace. */
export interface VoiceHistoryEntry {
	id: string
	role: 'user' | 'assistant' | 'tool' | 'relay'
	text: string
	at: number
	partial: boolean
	interrupted: boolean
	transcriptionFailed: boolean
}

export interface VoiceHistorySummary {
	callId: string
	startedAt: number
	updatedAt: number
	endedAt: number | null
	transport: 'webrtc' | 'sip'
	model: string
	voice: string
	language: VoiceLanguage
	status: 'active' | 'ended' | 'interrupted'
	hasGaps: boolean
	preview: string
	entryCount: number
	captureError?: string
}

export interface VoiceHistoryCall extends VoiceHistorySummary {
	entries: VoiceHistoryEntry[]
}

export interface VoiceHistoryResponse {
	calls: VoiceHistorySummary[]
	hasMore: boolean
}

export interface VoiceHistorySearchHit {
	call: VoiceHistorySummary
	itemId: string
	role: 'user' | 'assistant'
	at: number
	partial: boolean
	interrupted: boolean
	transcriptionFailed: boolean
	/** Same HIT_OPEN/HIT_CLOSE markers as chat search. */
	snippet: string
}

export interface VoiceHistorySearchResponse {
	query: string
	hits: VoiceHistorySearchHit[]
	hasMore: boolean
}

/** GET /api/files/:reference — a bounded source preview for a chat file link. */
export interface FilePreviewResponse {
	/** Absolute workspace path from the link. */
	path: string
	/** The requested line, clamped to the file's last line. */
	line: number | null
	/** The first 1-based line included in `content`. */
	lineStart: number
	/** The last 1-based line included in `content`. */
	lineEnd: number
	totalLines: number
	/** Source text for the visible excerpt. */
	content: string
	/** The excerpt omits lines before or after it. */
	truncated: boolean
}

/**
 * GET /api/workspaces/:id/files — previewable, worktree-relative source paths.
 *
 * The phone uses these for the diff window's All-files rail and turns
 * `` `tests/foo.ts` `` in a message into a source link only when this list proves it
 * exists. `truncated` says the worktree held more previewable paths than the relay
 * will ship (src/git.ts ▸ `listSourceFiles`).
 */
export interface WorkspaceFilesResponse {
	files: string[]
	truncated: boolean
}

/**
 * GET /api/workspaces/:id — one workspace by id, in any state.
 *
 * `SearchWorkspace`, not `Workspace`, and that is the whole point: this answers for the
 * archived ones too, which have no worktree, no live session and no git to read.
 */
export interface WorkspaceResponse {
	workspace: SearchWorkspace
}

/** GET /api/workspaces/:id/sessions */
export interface SessionsResponse {
	sessions: SessionRow[]
	/** Worktree-owned role identity for chips/tool output. */
	session_roles?: Record<string, SessionRoleAssignment>
}

/** GET /api/workspaces/:id/sessions/closed — fetched only while the picker is open. */
export interface ClosedSessionsResponse {
	sessions: ClosedSession[]
}

export type { ClosedSession }

/** GET /api/sessions/:id/messages?after= — `cursor` feeds the next poll. */
export interface MessagesResponse {
	/** Newly persisted transcript rows after the requested rowid cursor. */
	entries: TranscriptEntry[]
	/** Full current snapshot of Conductor's queue-mode message outbox. */
	queued?: TranscriptEntry[]
	cursor: number
}

/** GET /api/sessions/:id/context — exact total plus estimated composition and fork sizes. */
export type ContextBreakdownResponse = ContextBreakdown

/**
 * POST /api/sessions/:id/split — the source chat, written into a new destination's attachments.
 *
 * The destination is either another tab over the same files or a separate workspace
 * carrying a snapshot of the source's current files. It stops one step short of sending:
 * the prompt it composes goes through the ordinary send route for its retry, transcript
 * confirm and locked-Mac parking behavior.
 */
export interface SplitChatResult {
	ok: boolean
	/** Same-workspace tab, or a fresh worktree carrying the source's current code. */
	destination: 'chat' | 'workspace'
	/** The new chat. Present whenever the tab opened, even if nothing has been sent to it. */
	sessionId: string | null
	workspaceId: string
	/** Ready to POST to `sendPrompt`: the attachment token, then the caller's prompt. */
	text: string
	attachment: SplitAttachment
	error?: string
}

/** The transcript file `split` wrote, and what it left out of it. */
export interface SplitAttachment {
	name: string
	/** Worktree-relative — the path an agent should read, and what the token spells. */
	path: string
	bytes: number
	/** Transcript entries written. */
	kept: number
	/**
	 * Entries dropped, so a caller can report the cut instead of implying none. `thinking`
	 * and `tools` are the format's doing. `earlier`/`later` are the caller's: a
	 * `throughRowid` can leave later entries behind, while `onlyRowid` leaves both sides
	 * of its selected source message out. Both are zero when the whole chat was copied.
	 */
	elided: { thinking: number; tools: number; earlier: number; later: number }
}

/** POST /api/sessions/:id/agent — the chat is re-read from the DB before this answers. */
export interface AgentResult {
	ok: boolean
	session?: SessionRow
	error?: string
}

/** GET /api/sessions/:id/models — read live off Conductor's model menu, not a hard-coded list. */
export interface ModelsResult {
	ok: boolean
	models?: string[]
	/** The exact picker label whose star is selected. */
	defaultModel?: string
	error?: string
}

/** GET /api/models — labels previously observed in Conductor's picker, without opening its UI. */
export interface ModelCatalogResponse {
	groups: CachedModelGroup[]
	/** The newest default observed in any live picker. */
	defaultModel?: string
}

/** GET/PATCH /api/models/defaults — Conductor's provider-specific new-chat effort defaults. */
export interface ModelDefaultsResponse {
	defaultEfforts: DefaultEfforts
}

/** GET /api/usage — provider subscription windows read from local agent CLIs. */
export type PlanUsageResponse = PlanUsageSnapshot

/** GET /api/usage/tools — recent tool traffic, separate from provider plan limits. */
export type ToolUsageResponse = ToolUsageSnapshot
export type { ToolUsageRange, ToolUsageRow } from './tool-usage.ts'

/** POST /api/sessions/:id/default-model — the star is re-read before success. */
export interface DefaultModelResult {
	ok: boolean
	defaultModel?: string
	session?: SessionRow
	error?: string
}

/** POST /api/workspaces — returns as soon as the row exists; the prompt is delivered later. */
export interface CreateWorkspaceRequest extends ParkedAgentPatch {
	repo?: string
	prompt?: string
	send?: boolean
	sendImmediately?: boolean
	attachmentIds?: string[]
}

export interface CreateWorkspaceResult {
	ok: boolean
	workspaceId?: string
	workspace?: Workspace
	/** Echoed back so the caller can submit it once the worktree is ready. */
	pendingPrompt?: string
	/** The model requested for the new chat. The relay applies it before the first prompt. */
	model?: string
	sent?: boolean
	/** True when `send: true` waited for initial agent settings to finish. */
	configured?: boolean
	warning?: string
	error?: string
}

/** A file held by the relay until the new workspace has a worktree. */
export interface StagedAttachment extends Attachment {
	/** Opaque id accepted by `POST /api/workspaces` as an initial attachment. */
	stageId: string
}

/** POST /api/attachments — stage one phone file before its workspace exists. */
export interface StageAttachmentResult {
	ok: true
	attachment: StagedAttachment
}

/** POST /api/sessions/:id/prompt — the relay retries inside the request, hence `attempts`. */
export interface SendPromptRequest {
	text: string
	workspaceId?: string
	agent?: ParkedAgentPatch
	clientId?: string
	queue?: boolean
}

export interface SendResult extends ActuatorSendResult {
	/** Runs the relay needed to land the prompt (it retries a failed send itself). */
	attempts?: number
	/** The Mac is locked: the relay parked the prompt and delivers it on unlock. */
	parked?: boolean
	/** The parked entry, when `parked` — the same shape `/api/state` will carry. */
	queued?: PendingPrompt
}

/** One file written in Conductor's own attachment layout, ready to add to a prompt. */
export interface Attachment {
	/** Safe file name shown by Conductor's attachment chip. */
	name: string
	/** Worktree-relative path for the agent to read. */
	path: string
	bytes: number
	/** Conductor's `@⟦…⟧(…)` composer token. */
	token: string
}

/** POST /api/sessions/:id/attachments — a file from the phone, ready to send. */
export interface UploadAttachmentResult {
	ok: true
	attachment: Attachment
}

/** POST /api/sessions/:id/stop — Conductor's "Cancel agent" for one chat. */
export interface StopResult {
	ok: boolean
	/** The turn had already ended before the tap landed; nothing was pressed. */
	alreadyIdle?: boolean
	/** The chat as the relay re-read it once Conductor recorded the stop. */
	session?: SessionRow
	error?: string
}

/** DELETE /api/sessions/:id — Conductor's reversible "Close tab" action. */
export interface CloseChatResult {
	ok: boolean
	/** A retry named a session Conductor had already hidden. */
	alreadyClosed?: boolean
	/** The tab Conductor selected after closing, or null when none remain. */
	activeSessionId?: string | null
	/** The close was refused because this chat still has an agent running. */
	agentRunning?: boolean
	error?: string
}

/** POST /api/sessions/:id/restore — confirmed from Conductor's visible session rows. */
export interface RestoreChatResult {
	ok: boolean
	alreadyOpen?: boolean
	session?: SessionRow
	error?: string
}

/** POST /api/workspaces/:id/sessions — "New chat, same files". */
export interface NewChatResult {
	ok: boolean
	/** Id of the freshly-created session, if the relay detected it in time. */
	sessionId?: string | null
	error?: string
}

/** POST /api/workspaces/:id/continue — the same workspace and chats, now on a fresh branch. */
export interface ContinueWorkspaceResult {
	ok: boolean
	/** The branch Conductor moved away from. */
	previousBranch?: string
	/** Re-read only after Conductor recorded the new branch. */
	workspace?: Workspace
	error?: string
}

/** POST /api/workspaces/:id/status — the workspace re-read *after* Conductor recorded it. */
export interface StatusResult {
	ok: boolean
	workspace?: Workspace
	error?: string
}

/**
 * POST /api/workspaces/:id/archive — the workspace re-read once Conductor recorded it.
 *
 * `SearchWorkspace`, like the archived-chat read above and for the same reason: the
 * workspace this answers about no longer has a worktree, and its own success is what
 * took it off `/api/state`.
 */
export interface ArchiveResult {
	ok: boolean
	workspace?: SearchWorkspace
	/** It was already archived — a repeat of a request whose answer went missing, not a failure. */
	alreadyArchived?: boolean
	/** The refusal was "agents are still working here"; repeat with `stopAgents` to go ahead. */
	agentsRunning?: boolean
	error?: string
}

/** POST /api/conductor/restart */
export interface RestartConductorResult {
	ok: boolean
	/** How long the quit-and-relaunch took, once it got the UI lock. */
	ms?: number
	/**
	 * The refusal was "agents are still working" — repeat with `stopAgents` to end
	 * their turns and restart anyway. Same shape as `ArchiveResult.agentsRunning`,
	 * because it is the same question and the phone asks it the same way.
	 */
	agentsRunning?: boolean
	/** How many chats were mid-turn when it refused, so the dialog can name the cost. */
	working?: number
	error?: string
}

/** GET /api/logs */
export interface LogsResponse {
	/** 'live' = this relay process's captured console; otherwise the log file that was tailed. */
	source: string
	/** False when the relay isn't the LaunchAgent — the files then belong to a *different* process. */
	managed: boolean
	startedAt: number
	/** Relay clock, so ages render right even if the phone's clock disagrees. */
	now: number
	files: LogFileInfo[]
	entries: LogEntry[]
}

/** GET /api/push */
export interface PushConfig {
	/** False when the relay was started with `PUSH_NOTIFY=off`. */
	enabled: boolean
	/** VAPID public key to subscribe with — stable for the life of the relay's store. */
	publicKey: string
	devices: DeviceInfo[]
}

/** POST /api/push/subscribe */
export interface PushSubscribeResult {
	ok: boolean
	/** This device's id, for `POST /api/push/test`. */
	id?: string
	devices: DeviceInfo[]
}

/** POST /api/push/test */
export interface PushTestResult {
	ok: boolean
	error?: string
}

/** GET /api/settings — the preferences plus what the phone needs to edit them. */
export interface SettingsResponse {
	settings: Settings
	wifi: {
		/** Often null: macOS gates the associated SSID behind Location Services. */
		current: string | null
		known: string[]
		/** Guessed from the name only — macOS's real hotspot knowledge is private. Sorts the picker. */
		likelyHotspots: string[]
		/** macOS's Auto-join Hotspot setting: `Never` | `Ask` | `Automatic`, or null if unreadable. */
		autoJoinHotspot: string | null
	}
	nosleep: NoSleepStatus
	/** Is the lock screen up right now — `null` when the probe itself couldn't say. */
	screenLocked: boolean | null
}

/** GET/PATCH /api/prefs — the host's durable copy of local-first PWA state. */
export interface PrefsResponse {
	prefs: Prefs
}

/**
 * GET /api/nosleep — the window's state plus the ceiling a caller may ask for. It rides
 * along inside `SettingsResponse` as well, so the phone needs no second trip to draw the
 * control; both read this one declaration.
 */
export interface NoSleepStatus extends NoSleepState {
	maxSeconds: number
}
