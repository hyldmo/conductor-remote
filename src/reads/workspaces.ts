import type { ConductorDb } from '../db.ts'
import { describeRepoIcon, type ResolvedIcon, resolveRepoIcon } from '../files/icons.ts'
import type { RepoRow, SearchWorkspace, UnreadSession, Workspace, WorkspaceRow } from './types.ts'
import { resolveWorktree } from './worktrees.ts'

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

export class WorkspacesReads {
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
}
