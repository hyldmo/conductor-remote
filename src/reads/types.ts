import type { FirstPrompt } from '../delivery/firstprompt.ts'
import type { ParkedPrompt } from '../delivery/parked.ts'
import type { RepoIcon } from '../files/icons.ts'
import type { DiffStats } from '../git/diff.ts'
import type { BackgroundTask } from './background-tasks.ts'

export interface WorkspaceRow {
	id: string
	directory_name: string | null
	workspace_name: string | null
	branch: string | null
	pr_title: string | null
	derived_status: string | null
	manual_status: string | null
	/** Conductor lifecycle: 'ready' (usable) or 'setting_up' (worktree/session still provisioning). */
	state: string | null
	created_at: string
	updated_at: string
	pinned_at: string | null
	active_session_id: string | null
	intended_target_branch: string | null
	repo_name: string | null
	repo_root: string | null
	repo_icon: string | null
	remote_url: string | null
	default_branch: string | null
	session_status: string | null
	session_title: string | null
	model: string | null
	/** The harness behind `model` ('claude', 'codex', 'cursor', 'acp'…), for the provider mark. */
	agent_type: string | null
}

/**
 * A chat Conductor has flagged unread, with the activity that flagged it.
 *
 * `at` is the session's own `updated_at`, which tracks its last message. The phone
 * only ever compares it against a mark taken from this same column, so SQLite's
 * `YYYY-MM-DD HH:MM:SS` (UTC, and lexically ordered) needs no parsing — don't
 * reformat it into an ISO string that no longer matches what `listSessions` serves.
 */
export interface UnreadSession {
	id: string
	at: string
}

/**
 * A workspace as a search result names it. Deliberately *not* `Workspace`: search
 * reaches archived workspaces (1,846 of the 1,886 here), which have no worktree, no
 * live session and no git to read, so resolving those would cost a `git worktree
 * list` per repo to produce nulls.
 */
export interface SearchWorkspace {
	id: string
	workspace_name: string | null
	pr_title: string | null
	branch: string | null
	directory_name: string | null
	state: string | null
	updated_at: string
	repo_name: string | null
	icon: RepoIcon | null
	/** Conductor has archived it — the phone can list it but can't open it. */
	archived: boolean
}

/** A repo Conductor can create workspaces in (see `Reads.listRepos`). */
export interface RepoRow {
	name: string
	/** Absolute checkout path — the `path=` value a create-workspace deep link needs. */
	root_path: string | null
	default_branch: string | null
	icon: RepoIcon | null
}

export interface SessionRow {
	id: string
	status: string | null
	title: string | null
	model: string | null
	/** 'plan' when the chat is in plan mode, else 'default'. */
	permission_mode: string | null
	/**
	 * Normalized current effort: none | low | medium | high | xhigh | max | ultracode.
	 * The legacy wire name stays for cached phone clients; Conductor stores Codex
	 * values in `codex_thinking_level` and Claude values in this named column.
	 */
	claude_effort_level: string | null
	/** 1 when Conductor's "Fast" toggle is on. */
	fast_mode: number | null
	/** claude | codex | cursor | acp — the agent family `model` belongs to. */
	agent_type: string | null
	/**
	 * How full this chat's context window is, 0-100 (real, null before the first turn).
	 * It belongs to the chat and to nothing larger: 14 of the 49 live workspaces here
	 * hold more than one tab, and one of them runs at 28 / 85 / 49 / 29 at the same
	 * moment. `WorkspaceRow` deliberately no longer carries it — the sidebar could only
	 * ever show the *active* tab's number, which named the workspace and meant one chat.
	 */
	context_used_percent: number | null
	unread_count: number | null
	created_at: string
	updated_at: string
	last_user_message_at: string | null
	/**
	 * The prompt-cache lifetime Claude Code actually used for this chat's latest
	 * cache write, in milliseconds. Null for agents that do not report it (and
	 * before a Claude prompt is large enough to cache).
	 */
	prompt_cache_ttl_ms: number | null
	/** When the latest user-started turn was dispatched — see `listSessions`. Null before the first dispatched prompt. */
	turn_started_at: string | null
	/**
	 * Background tasks this chat is still waiting on — the desktop's "Waiting for task"
	 * rows. `status` reads `idle` the whole time (src/reads/background-tasks.ts), so without
	 * this a chat that will resume itself in ten minutes looks exactly like one that is
	 * done.
	 */
	background_tasks: BackgroundTask[]
}

/** The raw provider-specific fields selected from Conductor's sessions table. */
export interface SessionDbRow extends Omit<SessionRow, 'background_tasks'> {
	codex_thinking_level: string | null
}

/** Closed-tab picker rows need no transcript scan or live agent process lookup. */
export type ClosedSession = Pick<SessionRow, 'id' | 'title' | 'model' | 'agent_type' | 'created_at' | 'updated_at'>

/** GitHub PR state of a workspace's branch, attached best-effort by src/git/pr.ts. */
export type PrStatus = 'merged' | 'draft' | 'conflicts' | 'checks_failed' | 'checks_pending' | 'mergeable'

/** One chat's live status, with enough context to name it in a notification (see src/notifications/notify.ts). */
export interface SessionState {
	sessionId: string
	workspaceId: string
	/** 'working' | 'idle' | 'error' — Conductor's own live agent status. */
	status: string | null
	/** Session activity, in Conductor's own sortable timestamp format. */
	updatedAt: string
	/**
	 * When this chat's most recent *user-started* turn was dispatched (see `listSessions`).
	 * Unchanged across a turn an agent started for itself, which is how the notifier tells
	 * "your agent finished" from a loop's eleventh lap. Null only when the chat has no
	 * dispatched user message that carries either a current `turn_id` or legacy `queue_order`.
	 */
	turnStartedAt: string | null
	/**
	 * The last thing a person said in this chat, heading a turn or steering one already
	 * running. `turnStartedAt` deliberately stays at that turn's first message, so the
	 * notifier watches both — otherwise answering a question mid-turn would read as a lap
	 * nobody asked for and go unannounced.
	 */
	lastUserMessageAt: string | null
	/** The sidebar title of the owning workspace. */
	workspaceTitle: string
	repoName: string | null
	/** Chat tab title, when the workspace has more than one. */
	sessionTitle: string | null
}

/**
 * Everything that existed before one UI send began. Outbox ids matter as much as
 * the transcript rowid: dispatching an older queued copy creates a new transcript
 * row, and must not be mistaken for delivery of this send.
 */
export interface DeliveryCursor {
	rowid: number
	outboxIds: ReadonlySet<string>
}

/**
 * A send is first accepted into Conductor's outbox, then promoted under the same
 * message id into a durable turn. Keeping those states tagged prevents an accepted
 * Baton from opening the next Workflow phase before it actually reaches the root.
 */
export type DeliveryReceipt =
	| { kind: 'outbox'; id: string }
	| { kind: 'message'; id: string; rowid: number; turnId: string | null }

export interface Workspace extends WorkspaceRow {
	/** Chats in this workspace Conductor flags unread — empty for most (see `unreadSessions`). */
	unread_sessions: UnreadSession[]
	/** Absolute path to the git worktree on disk, or null if it can't be resolved. */
	worktree: string | null
	baseBranch: string
	/** How to render the repo's sidebar avatar; null → letter monogram. See `describeRepoIcon`. */
	icon: RepoIcon | null
	/** PR state of `branch` (null when unknown / no PR / not GitHub); set by src/git/pr.ts. */
	pr_status?: PrStatus | null
	/** Open/closed PR number for `branch`, when one exists; set by src/git/pr.ts. */
	pr_number?: number | null
	/** PR web URL for the `#N ↗` link; set by src/git/pr.ts. */
	pr_url?: string | null
	/** Added/removed lines against `baseBranch`; filled from a short-lived git cache by src/git/change-stats.ts. */
	change_stats?: DiffStats | null
	/** A first prompt the relay hasn't delivered yet; set by src/http/routes/state.ts from src/delivery/firstprompt.ts. */
	pending_prompt?: FirstPrompt | null
	/** Prompts parked for the lock screen, each naming its chat; set by src/http/routes/state.ts from src/delivery/parked.ts. */
	parked_prompts?: ParkedPrompt[]
	/** A Conductor Run task is live in this worktree; set by src/http/routes/state.ts from src/dev-server/run-activity.ts. */
	run_active?: boolean
}
