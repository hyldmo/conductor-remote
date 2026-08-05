// Mirrors the relay's JSON responses (src/reads.ts, src/git.ts, src/writes.ts).

/**
 * How to render a repo's sidebar avatar (mirrors `RepoIcon` in src/icons.ts).
 * `emoji`/`named` render inline; `file` is fetched from `/api/repos/:name/icon`;
 * `github` loads `github.com/<owner>.png`. Null → letter monogram.
 */
export type RepoIcon =
	| { kind: 'emoji'; value: string }
	| { kind: 'named'; value: string }
	| { kind: 'file' }
	| { kind: 'github'; owner: string }

/** GitHub PR state of the branch (see src/pr.ts) — drives the workspace dot colour. */
export type PrStatus = 'merged' | 'draft' | 'conflicts' | 'mergeable'

/**
 * A chat Conductor flags unread, and the activity that flagged it (`at` is the
 * session's `updated_at`). Compare `at` only against a mark taken from the same
 * column — see lib/read.ts.
 */
export interface UnreadSession {
	id: string
	at: string
}

export interface Workspace {
	id: string
	directory_name: string | null
	workspace_name: string | null
	branch: string | null
	/** Conductor's cached PR title; present iff the workspace has a PR (in-review/done). */
	pr_title: string | null
	derived_status: string | null
	manual_status: string | null
	/** Conductor lifecycle: 'ready' (usable) or 'setting_up' (worktree/session still provisioning). */
	state: string | null
	created_at: string
	updated_at: string
	/** Chats with news Conductor hasn't seen you read — usually empty. */
	unread_sessions: UnreadSession[]
	pinned_at: string | null
	active_session_id: string | null
	intended_target_branch: string | null
	repo_name: string | null
	session_status: string | null
	session_title: string | null
	model: string | null
	context_used_percent: number | null
	/** How to render the repo's sidebar avatar; null → letter monogram. */
	icon: RepoIcon | null
	/** PR state of `branch`, or null when unknown / no PR / not a GitHub repo. */
	pr_status?: PrStatus | null
	/** PR number for `branch`, when one exists. */
	pr_number?: number | null
	/** PR web URL for the `#N ↗` link. */
	pr_url?: string | null
	/** A first prompt the relay hasn't delivered yet — rendered in this workspace's chat. */
	pending_prompt?: PendingPrompt | null
}

/**
 * The prompt a workspace was created with, still undelivered (mirrors `FirstPrompt`
 * in src/firstprompt.ts). The relay owns delivery; this is the phone's view of it.
 */
export interface PendingPrompt {
	workspaceId: string
	text: string
	/** `failed` → the relay gave up and `error` says why; the text is still recoverable. */
	status: 'waiting' | 'failed'
	attempts: number
	createdAt: number
	error?: string
}

export interface ActuatorInfo {
	name: string
	caveat: string
	precise: boolean
	available: boolean
}

export interface UpdateStatus {
	current: string
	latest: string | null
	available: boolean
	checkedAt: number | null
	mode: 'off' | 'check' | 'auto'
	lastError: string | null
}

export interface StateResponse {
	workspaces: Workspace[]
	actuator: ActuatorInfo
	/** Relay version this daemon is running. */
	version?: string
	/** Self-update state (see src/autoupdate.ts). */
	update?: UpdateStatus
}

export interface Session {
	id: string
	status: string | null
	title: string | null
	model: string | null
	/** 'plan' when the chat is in plan mode, else 'default'. */
	permission_mode: string | null
	/** low | medium | high | xhigh | max | ultracode (null for non-Claude agents). */
	claude_effort_level: string | null
	/** 1 when Conductor's "Fast" toggle is on. */
	fast_mode: number | null
	/** claude | codex | cursor | acp — the agent family `model` belongs to. */
	agent_type: string | null
	context_used_percent: number | null
	unread_count: number | null
	created_at: string
	updated_at: string
	last_user_message_at: string | null
}

/** What the phone can change about a chat's agent (mirrors `AgentOptions` in src/writes.ts). */
export interface AgentPatch {
	effort?: string
	plan?: boolean
	fast?: boolean
	model?: string
}

export interface AgentResult {
	ok: boolean
	session?: Session
	error?: string
}

export interface ModelsResult {
	ok: boolean
	models?: string[]
	error?: string
}

export interface Repo {
	name: string
	/** Absolute checkout path — what the create-workspace deep link targets. */
	root_path: string | null
	default_branch: string | null
	icon: RepoIcon | null
}

export interface ReposResponse {
	repos: Repo[]
}

export interface CreateWorkspaceResult {
	ok: boolean
	workspaceId?: string
	workspace?: Workspace
	/** Echoed back so the caller can submit it once the worktree is ready. */
	pendingPrompt?: string
	sent?: boolean
	warning?: string
	error?: string
}

export interface SessionsResponse {
	sessions: Session[]
}

export type Role = 'user' | 'assistant' | 'tool' | 'thinking' | 'system'

export interface TranscriptEntry {
	id: string
	rowid: number
	role: Role
	text: string
	tool?: string
	/** Mono secondary line for tool rows (command, path, pattern, …). */
	detail?: string
	/** True when this row is a failed tool result. */
	error?: boolean
	ts: string
	queued: boolean
}

export interface MessagesResponse {
	entries: TranscriptEntry[]
	cursor: number
}

export interface DiffFile {
	path: string
	added: number
	removed: number
}

export interface WorkspaceDiff {
	base: string
	mergeBase: string | null
	files: DiffFile[]
	patch: string
	truncated: boolean
	/** Uncommitted changes in the worktree (drives the "Commit & push" action). */
	dirty: boolean
	/** Commits on HEAD not yet on the remote-tracking branch (also drives "Commit & push"). */
	unpushed: boolean
}

export interface SendResult {
	ok: boolean
	strategy: string
	warning?: string
	error?: string
}

export interface NewChatResult {
	ok: boolean
	/** Id of the freshly-created session, if the relay detected it in time. */
	sessionId?: string | null
	error?: string
}

export type LogLevel = 'info' | 'warn' | 'error'

/** One relay log line (mirrors `LogEntry` in src/logbuf.ts). `t` is null for unstamped on-disk lines. */
export interface LogEntry {
	t: number | null
	level: LogLevel
	text: string
}

export interface LogFileInfo {
	name: string
	size: number
	modifiedAt: number | null
}

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

export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** Result of POST /api/workspaces/:id/merge — merges the branch's open PR via `gh`. */
export interface MergeResult {
	ok: boolean
	branch: string
	method?: MergeMethod
	error?: string
}
