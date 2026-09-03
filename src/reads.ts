import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { agentProcessStarts, type BackgroundTask, openBackgroundTasks, TASK_FRAME_FILTER } from './background-tasks.ts'
import type { ConductorDb } from './db.ts'
import type { FirstPrompt } from './firstprompt.ts'
import { describeRepoIcon, type RepoIcon, type ResolvedIcon, resolveRepoIcon } from './icons.ts'
import type { ParkedPrompt } from './parked.ts'
import { workspaceTitle } from './shared.ts'
import {
	type OutboxMessageRow,
	parseMessage,
	parseOutboxMessage,
	type TranscriptEntry,
	toolImageAt
} from './transcript.ts'

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
	 * Normalized current effort: low | medium | high | xhigh | max | ultracode.
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
	 * rows. `status` reads `idle` the whole time (src/background-tasks.ts), so without
	 * this a chat that will resume itself in ten minutes looks exactly like one that is
	 * done.
	 */
	background_tasks: BackgroundTask[]
}

/** The raw provider-specific fields selected from Conductor's sessions table. */
interface SessionDbRow extends Omit<SessionRow, 'background_tasks'> {
	codex_thinking_level: string | null
}

/** Keep the stable wire field in sync with whichever provider owns the chat. */
function toSessionRow(row: SessionDbRow, background_tasks: BackgroundTask[]): SessionRow {
	const { codex_thinking_level, ...session } = row
	return {
		...session,
		claude_effort_level: row.agent_type === 'codex' ? codex_thinking_level : row.claude_effort_level,
		background_tasks
	}
}

/** GitHub PR state of a workspace's branch, attached best-effort by src/pr.ts. */
export type PrStatus = 'merged' | 'draft' | 'conflicts' | 'checks_failed' | 'checks_pending' | 'mergeable'

/** One chat's live status, with enough context to name it in a notification (see src/notify.ts). */
export interface SessionState {
	sessionId: string
	workspaceId: string
	/** 'working' | 'idle' | 'error' — Conductor's own live agent status. */
	status: string | null
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

export interface Workspace extends WorkspaceRow {
	/** Chats in this workspace Conductor flags unread — empty for most (see `unreadSessions`). */
	unread_sessions: UnreadSession[]
	/** Absolute path to the git worktree on disk, or null if it can't be resolved. */
	worktree: string | null
	baseBranch: string
	/** How to render the repo's sidebar avatar; null → letter monogram. See `describeRepoIcon`. */
	icon: RepoIcon | null
	/** PR state of `branch` (null when unknown / no PR / not GitHub); set by src/pr.ts. */
	pr_status?: PrStatus | null
	/** Open/closed PR number for `branch`, when one exists; set by src/pr.ts. */
	pr_number?: number | null
	/** PR web URL for the `#N ↗` link; set by src/pr.ts. */
	pr_url?: string | null
	/** A first prompt the relay hasn't delivered yet; set by src/server.ts from src/firstprompt.ts. */
	pending_prompt?: FirstPrompt | null
	/** Prompts parked for the lock screen, each naming its chat; set by src/server.ts from src/parked.ts. */
	parked_prompts?: ParkedPrompt[]
}

const worktreeCache = new Map<string, string | null>()

/**
 * The dispatch time of the latest turn a person started.
 *
 * Current Conductor writes the same `turn_id` on a turn's first prompt and every
 * steering message added while it runs, but stopped populating `queue_order` on
 * 2026-08-31. Start with the latest user row that was actually dispatched (so a prompt
 * queued behind the current answer cannot take over), then take the first dispatch in
 * that turn (so steering cannot restart the clock). A self-scheduled `/loop` lap writes
 * no user row, leaving this value unchanged for the notification deduper.
 *
 * The second arm preserves workspaces written by older Conductor builds, where
 * `queue_order` identified turn heads and `turn_id` may be absent.
 * `MIN(CASE …)` is deliberate: a plain `MIN(sent_at)` makes SQLite favour the
 * sent-time index and walk every older turn, while the expression lets the existing
 * `(session_id, role, turn_id, …)` index jump straight to this turn's few user rows.
 */
const TURN_STARTED_AT_SQL = `COALESCE(
	(SELECT MIN(CASE WHEN head.sent_at IS NOT NULL THEN head.sent_at END)
	   FROM session_messages head
	  WHERE head.session_id = s.id
	    AND head.role = 'user'
	    AND head.turn_id = (
	      SELECT latest.turn_id
	        FROM session_messages latest
	       WHERE latest.session_id = s.id
	         AND latest.role = 'user'
	         AND latest.turn_id IS NOT NULL
	         AND latest.sent_at IS NOT NULL
	       ORDER BY latest.sent_at DESC, latest.rowid DESC
	       LIMIT 1
	    )),
	(SELECT MAX(legacy.sent_at)
	   FROM session_messages legacy
	  WHERE legacy.session_id = s.id
	    AND legacy.queue_order IS NOT NULL
	    AND legacy.sent_at IS NOT NULL)
)`

/**
 * Neutralize LIKE's own wildcards in a user's search word. `queryTokens` already
 * strips everything but letters, digits and `_` — and `_` is LIKE's single-character
 * wildcard, so "add_set" would quietly also match "addaset" without this.
 */
function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, m => `\\${m}`)
}

/** Shared row → `SearchWorkspace` shape for the two search reads below. */
function toSearchWorkspace(r: {
	id: string
	workspace_name: string | null
	pr_title: string | null
	branch: string | null
	directory_name: string | null
	state: string | null
	updated_at: string
	repo_name: string | null
	repo_icon: string | null
	repo_root: string | null
	remote_url: string | null
}): SearchWorkspace {
	return {
		id: r.id,
		workspace_name: r.workspace_name,
		pr_title: r.pr_title,
		branch: r.branch,
		directory_name: r.directory_name,
		state: r.state,
		updated_at: r.updated_at,
		repo_name: r.repo_name,
		icon: describeRepoIcon({ icon: r.repo_icon, repoRoot: r.repo_root, remoteUrl: r.remote_url }),
		archived: r.state === 'archived'
	}
}

/**
 * Resolve a workspace's worktree path. Conductor lays worktrees out as
 * `<workspacesRoot>/<repoName>/<directoryName>`, but we verify against
 * `git worktree list` (matched by branch) so a layout change can't silently
 * point us at the wrong tree.
 */
function resolveWorktree(
	workspacesRoot: string,
	repoName: string | null,
	directoryName: string | null,
	branch: string | null,
	repoRoot: string | null
): string | null {
	if (repoName && directoryName) {
		const guess = path.join(workspacesRoot, repoName, directoryName)
		if (fs.existsSync(path.join(guess, '.git'))) return guess
	}
	if (!(repoRoot && branch)) return null
	const cacheKey = repoRoot
	let listing = worktreeCache.get(cacheKey)
	if (listing === undefined) {
		try {
			listing = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
				encoding: 'utf8',
				timeout: 5000
			})
		} catch {
			listing = null
		}
		worktreeCache.set(cacheKey, listing)
	}
	if (!listing) return null
	// Porcelain: blocks of "worktree <path>" / "branch refs/heads/<name>"
	const blocks = listing.split('\n\n')
	for (const block of blocks) {
		if (block.includes(`refs/heads/${branch}`)) {
			const m = block.match(/^worktree (.+)$/m)
			if (m) return m[1]
		}
	}
	return null
}

export class Reads {
	private readonly db: ConductorDb
	private readonly workspacesRoot: string
	/** Chats with a live agent process, and its start — the gate on `background_tasks`. */
	private readonly liveAgents: () => Map<string, number>
	private messageOutboxAvailable: boolean | null = null
	private messageOutboxCheckedAt = 0

	constructor(db: ConductorDb, workspacesRoot: string, liveAgents: () => Map<string, number> = agentProcessStarts) {
		this.db = db
		this.workspacesRoot = workspacesRoot
		this.liveAgents = liveAgents
	}

	/**
	 * Unread chats, grouped by workspace. `workspaces.unread` is a **dead column** —
	 * Conductor still declares it (and its migration still says "when 1, the workspace
	 * should be marked visually as unread") but writes 0 on every row: 0 of 1691 are
	 * non-zero on this Mac, which is why the sidebar's bold/badge never once fired.
	 * The live flag is per session, and it *is* a flag — `unread_count` is only ever
	 * 0 or 1 — so what's worth counting is how many chats have news, not the column.
	 */
	private unreadSessions(): Map<string, UnreadSession[]> {
		const rows = this.db.query<{ workspace_id: string | null; id: string; updated_at: string }>(
			`SELECT workspace_id, id, updated_at
			 FROM sessions
			 WHERE COALESCE(unread_count, 0) > 0 AND COALESCE(is_hidden, 0) = 0`
		)
		const byWorkspace = new Map<string, UnreadSession[]>()
		for (const r of rows) {
			if (!r.workspace_id) continue
			const list = byWorkspace.get(r.workspace_id)
			if (list) list.push({ id: r.id, at: r.updated_at })
			else byWorkspace.set(r.workspace_id, [{ id: r.id, at: r.updated_at }])
		}
		return byWorkspace
	}

	listWorkspaces(): Workspace[] {
		const rows = this.db.query<WorkspaceRow>(
			`SELECT w.id, w.directory_name, w.workspace_name, w.branch, w.pr_title, w.derived_status, w.manual_status,
			        w.state, w.created_at, w.updated_at, w.pinned_at, w.active_session_id, w.intended_target_branch,
			        r.name AS repo_name, r.root_path AS repo_root, r.icon AS repo_icon,
			        r.remote_url AS remote_url, r.default_branch AS default_branch,
			        s.status AS session_status, s.title AS session_title, s.model AS model,
			        s.agent_type AS agent_type
			 FROM workspaces w
			 LEFT JOIN repos r ON r.id = w.repository_id
			 LEFT JOIN sessions s ON s.id = w.active_session_id
			 WHERE w.state IN ('ready', 'setting_up')
			 ORDER BY (w.pinned_at IS NULL), w.updated_at DESC`
		)
		const unread = this.unreadSessions()
		return rows.map(r => ({
			...r,
			unread_sessions: unread.get(r.id) ?? [],
			worktree: resolveWorktree(this.workspacesRoot, r.repo_name, r.directory_name, r.branch, r.repo_root),
			baseBranch: r.intended_target_branch || r.default_branch || 'main',
			icon: describeRepoIcon({ icon: r.repo_icon, repoRoot: r.repo_root, remoteUrl: r.remote_url })
		}))
	}

	getWorkspace(id: string): Workspace | null {
		return this.listWorkspaces().find(w => w.id === id) ?? null
	}

	/**
	 * The repos Conductor knows about, most recently used first. `root_path` is
	 * what a `conductor://…&path=` deep link needs to pick the target repo — with
	 * no path Conductor silently falls back to the *first* repo.
	 *
	 * "Used" is the newest workspace in the repo, never `repos.updated_at`: that
	 * column moves when the repo's *settings* change, so the repo worked in every
	 * day here reads as last touched six weeks ago. Repos with no workspace at all
	 * keep Conductor's own sidebar order, behind every repo that has one.
	 *
	 * The `replace()`s are load-bearing: `created_at` is always `YYYY-MM-DD HH:MM:SS`
	 * while `updated_at` is written both that way (306 rows) and as ISO with a `Z`
	 * (1,819), and 'T' sorts after ' ', so an untouched string compare can rank an
	 * earlier ISO row above a later plain one on the same day.
	 */
	listRepos(): RepoRow[] {
		const rows = this.db.query<{
			name: string
			root_path: string | null
			default_branch: string | null
			icon: string | null
			remote_url: string | null
		}>(
			`SELECT r.name, r.root_path, r.default_branch, r.icon, r.remote_url
			 FROM repos r
			 LEFT JOIN workspaces w ON w.repository_id = r.id
			 WHERE COALESCE(r.hidden, 0) = 0
			 GROUP BY r.id
			 ORDER BY (MAX(MAX(REPLACE(REPLACE(w.updated_at, 'T', ' '), 'Z', ''), w.created_at)) IS NULL),
			          MAX(MAX(REPLACE(REPLACE(w.updated_at, 'T', ' '), 'Z', ''), w.created_at)) DESC,
			          (r.display_order IS NULL), r.display_order, r.name`
		)
		return rows.map(r => ({
			name: r.name,
			root_path: r.root_path,
			default_branch: r.default_branch,
			icon: describeRepoIcon({ icon: r.icon, repoRoot: r.root_path, remoteUrl: r.remote_url })
		}))
	}

	/**
	 * Map chat ids to the workspace that owns them, archived included.
	 *
	 * `listWorkspaces` filters to `state IN ('ready','setting_up')`, which is right for
	 * the sidebar and wrong for search: the whole point of searching the transcript is
	 * to reach work you finished and put away. One query for the whole hit set, because
	 * a search fans out over up to 300 chunks and a per-chat lookup would be 300 of them.
	 */
	searchTargets(sessionIds: string[]): Map<string, { sessionTitle: string | null; workspace: SearchWorkspace }> {
		const out = new Map<string, { sessionTitle: string | null; workspace: SearchWorkspace }>()
		if (!sessionIds.length) return out
		const holes = sessionIds.map(() => '?').join(',')
		const rows = this.db.query<{
			session_id: string
			session_title: string | null
			id: string
			workspace_name: string | null
			pr_title: string | null
			branch: string | null
			directory_name: string | null
			state: string | null
			updated_at: string
			repo_name: string | null
			repo_icon: string | null
			repo_root: string | null
			remote_url: string | null
		}>(
			`SELECT s.id AS session_id, s.title AS session_title,
			        w.id, w.workspace_name, w.pr_title, w.branch, w.directory_name, w.state, w.updated_at,
			        r.name AS repo_name, r.icon AS repo_icon, r.root_path AS repo_root, r.remote_url AS remote_url
			 FROM sessions s
			 JOIN workspaces w ON w.id = s.workspace_id
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE s.id IN (${holes})`,
			sessionIds
		)
		for (const r of rows) out.set(r.session_id, { sessionTitle: r.session_title, workspace: toSearchWorkspace(r) })
		return out
	}

	/**
	 * Every chat in the requested search scope. The index only carries chat ids, so
	 * repo and archive filters have to be resolved here before ranking. Names, not repo
	 * ids, because names are what the phone's picker and `list_repos` hold.
	 */
	searchSessionIds(repos: string[] | undefined, includeArchived: boolean): string[] {
		if (repos && !repos.length) return []
		const scope = [
			...(repos ? [`r.name IN (${repos.map(() => '?').join(',')})`] : []),
			...(!includeArchived ? ["w.state IS NOT 'archived'"] : [])
		]
		return this.db
			.query<{ id: string }>(
				`SELECT s.id FROM sessions s
				 JOIN workspaces w ON w.id = s.workspace_id
				 LEFT JOIN repos r ON r.id = w.repository_id
				${scope.length ? ` WHERE ${scope.join(' AND ')}` : ''}`,
				repos ?? []
			)
			.map(r => r.id)
	}

	/**
	 * Workspaces whose own identity matches every token — name, PR title, branch,
	 * worktree codename or repo. Archived are included by default, for the same reason
	 * as `searchTargets`; `includeArchived` lets the phone narrow the search to current
	 * work. `repos` narrows to those repos by name; an empty list matches nothing.
	 *
	 * This is the half of search the transcript index cannot do. A workspace named for
	 * the thing you are looking for may never have said those words in its chat, and
	 * one whose chat is empty has no chunks at all.
	 */
	findWorkspacesByName(tokens: string[], limit = 20, repos?: string[], includeArchived = true): SearchWorkspace[] {
		if (!tokens.length) return []
		if (repos && !repos.length) return []
		const fields = ['w.workspace_name', 'w.pr_title', 'w.branch', 'w.directory_name', 'r.name']
		// AND across tokens, OR across fields: "auk lamp" should find the lamp workspace in
		// the auk repo, where no single column holds both words.
		const byToken = tokens.map(() => `(${fields.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
		const scope = [
			...(repos ? [`r.name IN (${repos.map(() => '?').join(',')})`] : []),
			...(!includeArchived ? ["w.state IS NOT 'archived'"] : [])
		]
		const where = [...byToken, ...scope].join(' AND ')
		const params = [...tokens.flatMap(t => fields.map(() => `%${escapeLike(t)}%`)), ...(repos ?? [])]
		const rows = this.db.query<{
			id: string
			workspace_name: string | null
			pr_title: string | null
			branch: string | null
			directory_name: string | null
			state: string | null
			updated_at: string
			repo_name: string | null
			repo_icon: string | null
			repo_root: string | null
			remote_url: string | null
		}>(
			`SELECT w.id, w.workspace_name, w.pr_title, w.branch, w.directory_name, w.state, w.updated_at,
			        r.name AS repo_name, r.icon AS repo_icon, r.root_path AS repo_root, r.remote_url AS remote_url
			 FROM workspaces w
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE ${where}
			 ORDER BY (w.state = 'archived'), w.updated_at DESC
			 LIMIT ?`,
			[...params, limit]
		)
		return rows.map(toSearchWorkspace)
	}

	/**
	 * One workspace by id, whatever state it is in — the read behind opening an archived
	 * chat (`GET /api/workspaces/:id`).
	 *
	 * `getWorkspace` above is the *live* one: it resolves a worktree and a base branch,
	 * and returns null for the 1,846 archived workspaces here, which is right for every
	 * write (there is nothing to focus and nothing to diff) and wrong for reading. The
	 * transcript survives archiving — Conductor deletes the worktree, not the chat — so
	 * this returns the same `SearchWorkspace` a search result carries, with no worktree
	 * and no git, and `listSessions`/`getMessages` do the rest by id.
	 */
	getAnyWorkspace(id: string): SearchWorkspace | null {
		const rows = this.db.query<{
			id: string
			workspace_name: string | null
			pr_title: string | null
			branch: string | null
			directory_name: string | null
			state: string | null
			updated_at: string
			repo_name: string | null
			repo_icon: string | null
			repo_root: string | null
			remote_url: string | null
		}>(
			`SELECT w.id, w.workspace_name, w.pr_title, w.branch, w.directory_name, w.state, w.updated_at,
			        r.name AS repo_name, r.icon AS repo_icon, r.root_path AS repo_root, r.remote_url AS remote_url
			 FROM workspaces w
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE w.id = ?
			 LIMIT 1`,
			[id]
		)
		return rows[0] ? toSearchWorkspace(rows[0]) : null
	}

	/** Resolve a repo's icon by its name (the sidebar avatar) — null if the repo or icon is unknown. */
	resolveRepoIcon(repoName: string): ResolvedIcon | null {
		const rows = this.db.query<{ root_path: string | null }>('SELECT root_path FROM repos WHERE name = ? LIMIT 1', [
			repoName
		])
		const root = rows[0]?.root_path
		return root ? resolveRepoIcon(root) : null
	}

	listSessions(workspaceId: string): SessionRow[] {
		// created_at ASC keeps tab order stable (matches the desktop app) instead of jumping on activity.
		//
		// `turn_started_at` is when the latest user-started turn began, which is NOT
		// `last_user_message_at`: a message typed while the agent is already working is
		// *steering* — it joins the running turn rather than starting one, and the phone's
		// elapsed timer must not restart on it. TURN_STARTED_AT_SQL groups those messages
		// by Conductor's `turn_id`, while retaining `queue_order` for older database rows.
		// `sent_at` is the dispatch time, so queued messages are excluded until they run.
		const rows = this.db.query<SessionDbRow>(
			`SELECT s.id, s.status, s.title, s.model, s.permission_mode,
			        s.claude_effort_level, s.codex_thinking_level, s.fast_mode, s.agent_type,
			        s.context_used_percent, s.unread_count,
			        s.created_at, s.updated_at, s.last_user_message_at,
			        (SELECT CASE
			                  -- Mixed-TTL writes exist, so the shorter conversation tail wins.
			                  WHEN m.content GLOB '*"ephemeral_5m_input_tokens":[1-9]*' THEN 300000
			                  WHEN m.content GLOB '*"ephemeral_1h_input_tokens":[1-9]*' THEN 3600000
			                END
			           FROM session_messages m
			          WHERE m.session_id = s.id
			            AND s.agent_type IN ('claude', 'anthropic')
			            AND (m.content GLOB '*"ephemeral_5m_input_tokens":[1-9]*'
			                 OR m.content GLOB '*"ephemeral_1h_input_tokens":[1-9]*')
			          ORDER BY m.rowid DESC LIMIT 1) AS prompt_cache_ttl_ms,
			        ${TURN_STARTED_AT_SQL} AS turn_started_at
			 FROM sessions s
			 WHERE s.workspace_id = ? AND COALESCE(s.is_hidden, 0) = 0
			 ORDER BY s.created_at ASC`,
			[workspaceId]
		)
		const live = this.liveAgents()
		return rows.map(row => {
			const started = live.get(row.id)
			return toSessionRow(row, started === undefined ? [] : this.openBackgroundTasks(row.id, started))
		})
	}

	/**
	 * The background tasks a chat is still waiting on (src/background-tasks.ts).
	 *
	 * Only asked for a chat with a live agent process, which bounds the cost twice over:
	 * a handful of chats at a time, and a prefix scan measured at 4–8ms on the largest
	 * chats here (1,000–1,700 rows, 30–58 MB) — under the 2s sessions poll it rides on.
	 */
	private openBackgroundTasks(sessionId: string, processStartedAt: number): BackgroundTask[] {
		const rows = this.db.query<{ created_at: string; content: string }>(
			`SELECT created_at, content FROM session_messages
			 WHERE session_id = ? AND ${TASK_FRAME_FILTER}
			 ORDER BY rowid ASC`,
			[sessionId]
		)
		return openBackgroundTasks(rows, processStartedAt)
	}

	/**
	 * Every live chat's status, across all workspaces — what the notifier watches for
	 * transitions. Unlike `listWorkspaces` this is not limited to the *active* session:
	 * a background tab finishing its turn is exactly the thing you want told about.
	 * `setting_up` workspaces are excluded; their chat isn't the user's turn yet.
	 */
	listSessionStates(): SessionState[] {
		const rows = this.db.query<{
			id: string
			status: string | null
			title: string | null
			workspace_id: string
			workspace_name: string | null
			pr_title: string | null
			branch: string | null
			directory_name: string | null
			repo_name: string | null
			tab_count: number
			turn_started_at: string | null
			last_user_message_at: string | null
		}>(
			// These two together are the notifier's record of whether a *person* had
			// anything to do with the turn that just ended. An agent that schedules its own
			// next turn (a `/loop`) writes no message at all, so both stay put while
			// `status` cycles working → idle on every lap. Both are needed: `turn_started_at`
			// stays at the first message when a person steers the running turn, while
			// `last_user_message_at` moves. See src/notify.ts.
			`SELECT s.id, s.status, s.title, s.workspace_id, s.last_user_message_at,
			        w.workspace_name, w.pr_title, w.branch, w.directory_name,
			        r.name AS repo_name,
			        (SELECT COUNT(*) FROM sessions t WHERE t.workspace_id = w.id AND COALESCE(t.is_hidden, 0) = 0) AS tab_count,
			        ${TURN_STARTED_AT_SQL} AS turn_started_at
			 FROM sessions s
			 JOIN workspaces w ON w.id = s.workspace_id
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE w.state = 'ready' AND COALESCE(s.is_hidden, 0) = 0`
		)
		return rows.map(r => ({
			sessionId: r.id,
			workspaceId: r.workspace_id,
			status: r.status,
			turnStartedAt: r.turn_started_at,
			lastUserMessageAt: r.last_user_message_at,
			workspaceTitle: workspaceTitle({ ...r, id: r.workspace_id }),
			repoName: r.repo_name,
			// A single-tab workspace's chat title is just the workspace again — only name it when it disambiguates.
			sessionTitle: r.tab_count > 1 ? r.title : null
		}))
	}

	/**
	 * The last thing the agent actually said in a chat — the body of a "finished"
	 * notification. Reads the tail rather than the whole transcript, and runs the
	 * same parser the phone renders with, so what lands on the lock screen is the
	 * text that will be at the bottom of the chat when it's opened.
	 */
	lastAssistantText(sessionId: string): string | null {
		const rows = this.db.query<{
			rowid: number
			id: string
			role: string | null
			content: string | null
			full_message: string | null
			created_at: string
			sent_at: string | null
			queue_order: number | null
		}>(
			`SELECT rowid, id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE session_id = ?
			 ORDER BY rowid DESC
			 LIMIT 20`,
			[sessionId]
		)
		// Rows come back newest-first; the last assistant text is the first one found.
		for (const row of rows) {
			const entries = parseMessage(row, null)
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].role === 'assistant' && entries[i].text.trim()) return entries[i].text.trim()
			}
		}
		return null
	}

	/**
	 * One image a tool returned, by the reference its transcript entry carries.
	 *
	 * The bytes sit in `session_messages.content` as base64, so this is the same read-only
	 * handle as everything else — nothing is written and nothing is cached to disk. The
	 * reference names a row and the image's position in it, and `toolImageAt` does the
	 * walk, because the numbering has to be the one `parseMessage` used.
	 */
	toolImage(reference: string): { mediaType: string; data: string } | null {
		const dot = reference.lastIndexOf('.')
		const rowid = Number(reference.slice(0, dot))
		const index = Number(reference.slice(dot + 1))
		if (dot < 0 || !Number.isInteger(rowid) || !Number.isInteger(index) || index < 0) return null
		const rows = this.db.query<{ content: string | null }>(
			'SELECT content FROM session_messages WHERE rowid = ? LIMIT 1',
			[rowid]
		)
		const content = rows[0]?.content
		return content ? toolImageAt(content, index) : null
	}

	/**
	 * Which workspace a chat belongs to.
	 *
	 * Every other route resolves this by matching `active_session_id`, which only ever
	 * finds the tab that is currently on screen. That is fine for a phone, where the
	 * chat you are looking at is the chat you are sending to. It is wrong for anything
	 * addressing a chat by id — a background tab has a workspace too, and `sessions`
	 * has carried `workspace_id` all along.
	 */
	sessionWorkspaceId(sessionId: string): string | null {
		const rows = this.db.query<{ workspace_id: string | null }>(
			`SELECT workspace_id FROM sessions WHERE id = ? LIMIT 1`,
			[sessionId]
		)
		return rows[0]?.workspace_id ?? null
	}

	/** Session → worktree path, cached: it's stable for a session's lifetime and polled every tick. */
	private readonly worktreeBySession = new Map<string, string | null>()

	private sessionWorktree(sessionId: string): string | null {
		const cached = this.worktreeBySession.get(sessionId)
		if (cached !== undefined) return cached
		const rows = this.db.query<{
			directory_name: string | null
			branch: string | null
			repo_name: string | null
			repo_root: string | null
		}>(
			`SELECT w.directory_name, w.branch, r.name AS repo_name, r.root_path AS repo_root
			 FROM sessions s
			 JOIN workspaces w ON w.id = s.workspace_id
			 LEFT JOIN repos r ON r.id = w.repository_id
			 WHERE s.id = ? LIMIT 1`,
			[sessionId]
		)
		const r = rows[0]
		const worktree = r
			? resolveWorktree(this.workspacesRoot, r.repo_name, r.directory_name, r.branch, r.repo_root)
			: null
		this.worktreeBySession.set(sessionId, worktree)
		return worktree
	}

	/**
	 * The outbox arrived in Conductor migration 123. Keep older desktop builds usable,
	 * and re-probe occasionally so a running relay notices an in-place app migration.
	 */
	private hasMessageOutbox(): boolean {
		if (this.messageOutboxAvailable === true) return true
		const now = Date.now()
		if (this.messageOutboxAvailable === false && now - this.messageOutboxCheckedAt < 60_000) return false
		const rows = this.db.query<{ present: number }>(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'session_messages_outbox' LIMIT 1"
		)
		this.messageOutboxAvailable = rows.length > 0
		this.messageOutboxCheckedAt = now
		return this.messageOutboxAvailable
	}

	/** Current outbox contents. `queueOnly` is the snapshot the transcript renders. */
	private outboxMessages(sessionId: string, queueOnly: boolean): TranscriptEntry[] {
		if (!this.hasMessageOutbox()) return []
		try {
			const rows = this.db.query<OutboxMessageRow>(
				`SELECT message_id, delivery_payload, created_at
				 FROM session_messages_outbox
				 WHERE session_id = ?${queueOnly ? " AND mode = 'queue'" : ''}
				 ORDER BY COALESCE(queue_order, 2147483647), created_at ASC`,
				[sessionId]
			)
			return rows.flatMap(row => {
				const entry = parseOutboxMessage(row)
				return entry ? [entry] : []
			})
		} catch (error) {
			// A Conductor rollback can swap the DB beneath the relay. Treat only the
			// missing-table case as an older schema; every other read failure stays loud.
			if (error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message)) {
				this.messageOutboxAvailable = false
				this.messageOutboxCheckedAt = Date.now()
				return []
			}
			throw error
		}
	}

	/** Snapshot the durable transcript cursor and pending message ids in one SQLite read. */
	deliveryCursor(sessionId: string): DeliveryCursor {
		if (!this.hasMessageOutbox()) {
			const row = this.db.query<{ rowid: number }>(
				'SELECT COALESCE(MAX(rowid), 0) AS rowid FROM session_messages WHERE session_id = ?',
				[sessionId]
			)[0]
			return { rowid: row?.rowid ?? 0, outboxIds: new Set() }
		}

		try {
			const rows = this.db.query<{ rowid: number; message_id: string | null }>(
				`WITH transcript_cursor AS (
				   SELECT COALESCE(MAX(rowid), 0) AS rowid
				   FROM session_messages
				   WHERE session_id = ?
				 )
				 SELECT transcript_cursor.rowid, NULL AS message_id
				 FROM transcript_cursor
				 UNION ALL
				 SELECT transcript_cursor.rowid, outbox.message_id
				 FROM transcript_cursor
				 JOIN session_messages_outbox outbox ON outbox.session_id = ?`,
				[sessionId, sessionId]
			)
			return {
				rowid: rows[0]?.rowid ?? 0,
				outboxIds: new Set(rows.flatMap(row => (row.message_id ? [row.message_id] : [])))
			}
		} catch (error) {
			if (!(error instanceof Error && /no such table:\s*session_messages_outbox/i.test(error.message))) throw error
			this.messageOutboxAvailable = false
			this.messageOutboxCheckedAt = Date.now()
			return this.deliveryCursor(sessionId)
		}
	}

	/** Has this send created either a durable user row or a newly-owned outbox item? */
	promptDeliveredSince(sessionId: string, text: string, before: DeliveryCursor): boolean {
		const target = text.trim()
		const durable = this.durableMessages(sessionId, before.rowid).entries
		const pending = this.outboxMessages(sessionId, false)
		return [...durable, ...pending].some(
			entry => entry.role === 'user' && entry.text.trim() === target && !before.outboxIds.has(entry.id)
		)
	}

	/** Incremental durable transcript fetch, without the independently replaced outbox snapshot. */
	private durableMessages(sessionId: string, afterRowid: number): { entries: TranscriptEntry[]; cursor: number } {
		const rows = this.db.query<{
			rowid: number
			id: string
			role: string | null
			content: string | null
			full_message: string | null
			created_at: string
			sent_at: string | null
			queue_order: number | null
		}>(
			`SELECT rowid, id, role, content, full_message, created_at, sent_at, queue_order
			 FROM session_messages
			 WHERE session_id = ? AND rowid > ?
			 ORDER BY rowid ASC`,
			[sessionId, afterRowid]
		)
		const worktree = this.sessionWorktree(sessionId)
		const entries: TranscriptEntry[] = []
		let cursor = afterRowid
		for (const row of rows) {
			cursor = row.rowid
			entries.push(...parseMessage(row, worktree))
		}
		return { entries, cursor }
	}

	/** Incremental transcript rows plus the full current queue snapshot. */
	getMessages(
		sessionId: string,
		afterRowid = 0
	): { entries: TranscriptEntry[]; queued: TranscriptEntry[]; cursor: number } {
		return { ...this.durableMessages(sessionId, afterRowid), queued: this.outboxMessages(sessionId, true) }
	}
}
