import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ConductorDb } from './db.ts'
import type { FirstPrompt } from './firstprompt.ts'
import { describeRepoIcon, type RepoIcon, type ResolvedIcon, resolveRepoIcon } from './icons.ts'
import type { ParkedPrompt } from './parked.ts'
import { workspaceTitle } from './shared.ts'
import { parseMessage, type TranscriptEntry, toolImageAt } from './transcript.ts'

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
	/** When the turn now in flight was dispatched — see `listSessions`. Null before Conductor's first queued turn. */
	turn_started_at: string | null
}

/** The raw provider-specific fields selected from Conductor's sessions table. */
interface SessionDbRow extends SessionRow {
	codex_thinking_level: string | null
}

/** Keep the stable wire field in sync with whichever provider owns the chat. */
function toSessionRow(row: SessionDbRow): SessionRow {
	const { codex_thinking_level, ...session } = row
	return {
		...session,
		claude_effort_level: row.agent_type === 'codex' ? codex_thinking_level : row.claude_effort_level
	}
}

/** GitHub PR state of a workspace's branch, attached best-effort by src/pr.ts. */
export type PrStatus = 'merged' | 'draft' | 'conflicts' | 'checks_failed' | 'mergeable'

/** One chat's live status, with enough context to name it in a notification (see src/notify.ts). */
export interface SessionState {
	sessionId: string
	workspaceId: string
	/** 'working' | 'idle' | 'error' — Conductor's own live agent status. */
	status: string | null
	/**
	 * When this chat's most recent *user-started* turn was dispatched (see `listSessions`).
	 * Unchanged across a turn an agent started for itself, which is how the notifier tells
	 * "your agent finished" from a loop's eleventh lap. Null on a chat dormant since before
	 * `queue_order` existed (May 2026).
	 */
	turnStartedAt: string | null
	/**
	 * The last thing a person said in this chat, heading a turn or steering one already
	 * running. `turnStartedAt` misses the second (steering carries no `queue_order`), so
	 * the notifier watches both — otherwise answering a question mid-turn would read as a
	 * lap nobody asked for and go unannounced.
	 */
	lastUserMessageAt: string | null
	/** The sidebar title of the owning workspace. */
	workspaceTitle: string
	repoName: string | null
	/** Chat tab title, when the workspace has more than one. */
	sessionTitle: string | null
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

	constructor(db: ConductorDb, workspacesRoot: string) {
		this.db = db
		this.workspacesRoot = workspacesRoot
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
			        s.status AS session_status, s.title AS session_title, s.model AS model
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
	 * The repos Conductor knows about, in its own sidebar order. `root_path` is
	 * what a `conductor://…&path=` deep link needs to pick the target repo — with
	 * no path Conductor silently falls back to the *first* repo.
	 */
	listRepos(): RepoRow[] {
		const rows = this.db.query<{
			name: string
			root_path: string | null
			default_branch: string | null
			icon: string | null
			remote_url: string | null
		}>(
			`SELECT name, root_path, default_branch, icon, remote_url
			 FROM repos
			 WHERE COALESCE(hidden, 0) = 0
			 ORDER BY (display_order IS NULL), display_order, name`
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
	 * Workspaces whose own identity matches every token — name, PR title, branch,
	 * worktree codename or repo. Archived included, same reason as `searchTargets`.
	 *
	 * This is the half of search the transcript index cannot do. A workspace named for
	 * the thing you are looking for may never have said those words in its chat, and
	 * one whose chat is empty has no chunks at all.
	 */
	findWorkspacesByName(tokens: string[], limit = 20): SearchWorkspace[] {
		if (!tokens.length) return []
		const fields = ['w.workspace_name', 'w.pr_title', 'w.branch', 'w.directory_name', 'r.name']
		// AND across tokens, OR across fields: "auk lamp" should find the lamp workspace in
		// the auk repo, where no single column holds both words.
		const where = tokens.map(() => `(${fields.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND ')
		const params = tokens.flatMap(t => fields.map(() => `%${escapeLike(t)}%`))
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
		// `turn_started_at` is when the current answer began, which is NOT
		// `last_user_message_at`: a message typed while the agent is already working is
		// *steering* — it joins the running turn rather than starting one, and the phone's
		// elapsed timer must not restart on it. Conductor separates the two itself.
		// `session_messages.queue_order` is set exactly on the messages that head a turn
		// (verified over the whole DB from May 2026, when the column appeared — older rows
		// are all NULL, so a long-dormant chat reports null here and simply shows no timer),
		// and `sent_at` is when that head was dispatched, so a prompt that sat in the queue
		// times from when it actually ran, not from when it was typed. Still-queued heads
		// have `sent_at` NULL and are skipped, which is why a queued message can't blip the
		// timer while the previous answer is still going. Served straight off
		// idx_session_messages_sent_at(session_id, sent_at) — measured free at this poll rate.
		const rows = this.db.query<SessionDbRow>(
			`SELECT s.id, s.status, s.title, s.model, s.permission_mode,
			        s.claude_effort_level, s.codex_thinking_level, s.fast_mode, s.agent_type,
			        s.context_used_percent, s.unread_count,
			        s.created_at, s.updated_at, s.last_user_message_at,
			        (SELECT MAX(m.sent_at) FROM session_messages m
			          WHERE m.session_id = s.id AND m.queue_order IS NOT NULL AND m.sent_at IS NOT NULL) AS turn_started_at
			 FROM sessions s
			 WHERE s.workspace_id = ? AND COALESCE(s.is_hidden, 0) = 0
			 ORDER BY s.created_at ASC`,
			[workspaceId]
		)
		return rows.map(toSessionRow)
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
			// only moves for a message that *heads* a turn, so steering into a running one
			// would look like a lap nobody asked for. See src/notify.ts.
			`SELECT s.id, s.status, s.title, s.workspace_id, s.last_user_message_at,
			        w.workspace_name, w.pr_title, w.branch, w.directory_name,
			        r.name AS repo_name,
			        (SELECT COUNT(*) FROM sessions t WHERE t.workspace_id = w.id AND COALESCE(t.is_hidden, 0) = 0) AS tab_count,
			        (SELECT MAX(m.sent_at) FROM session_messages m
			          WHERE m.session_id = s.id AND m.queue_order IS NOT NULL AND m.sent_at IS NOT NULL) AS turn_started_at
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

	/** Incremental transcript fetch. `afterRowid` is the cursor from a prior call. */
	getMessages(sessionId: string, afterRowid = 0): { entries: TranscriptEntry[]; cursor: number } {
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
}
