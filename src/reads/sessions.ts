import type { ConductorDb } from '../db.ts'
import { workspaceTitle } from '../shared.ts'
import { type BackgroundTask, openBackgroundTasks, TASK_FRAME_FILTER } from './background-tasks.ts'
import type { ClosedSession, SessionDbRow, SessionRow, SessionState } from './types.ts'

/** Keep the stable wire field in sync with whichever provider owns the chat. */
function toSessionRow(row: SessionDbRow, background_tasks: BackgroundTask[]): SessionRow {
	const { codex_thinking_level, ...session } = row
	const effort = row.agent_type === 'codex' ? codex_thinking_level : row.claude_effort_level
	return {
		...session,
		// Codex calls its top level `ultra`; the relay's long-lived wire value is
		// `ultracode`, which is also Claude's stored spelling and the phone's key.
		claude_effort_level: effort === 'ultra' ? 'ultracode' : effort,
		background_tasks
	}
}

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

export class SessionReads {
	private readonly db: ConductorDb
	private readonly liveAgents: () => Map<string, number>
	constructor(db: ConductorDb, liveAgents: () => Map<string, number>) {
		this.db = db
		this.liveAgents = liveAgents
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

	listClosedSessions(workspaceId: string): ClosedSession[] {
		return this.db.query<ClosedSession>(
			`SELECT id, title, model, agent_type, created_at, updated_at
			 FROM sessions
			 WHERE workspace_id = ? AND is_hidden = 1
			 ORDER BY REPLACE(REPLACE(updated_at, 'T', ' '), 'Z', '') DESC, created_at DESC, id ASC`,
			[workspaceId]
		)
	}

	/** One delegated child, including its provider-specific open-task guard. */
	getSession(sessionId: string): SessionRow | null {
		const rows = this.db.query<SessionDbRow>(
			`SELECT s.id, s.status, s.title, s.model, s.permission_mode,
			        s.claude_effort_level, s.codex_thinking_level, s.fast_mode, s.agent_type,
			        s.context_used_percent, s.unread_count,
			        s.created_at, s.updated_at, s.last_user_message_at,
			        (SELECT MAX(m.sent_at) FROM session_messages m
			          WHERE m.session_id = s.id AND m.queue_order IS NOT NULL AND m.sent_at IS NOT NULL) AS turn_started_at
			 FROM sessions s
			 WHERE s.id = ? AND COALESCE(s.is_hidden, 0) = 0
			 LIMIT 1`,
			[sessionId]
		)
		const row = rows[0]
		if (!row) return null
		const started = this.liveAgents().get(row.id)
		return toSessionRow(row, started === undefined ? [] : this.openBackgroundTasks(row.id, started))
	}

	/**
	 * The background tasks a chat is still waiting on (src/reads/background-tasks.ts).
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
			updated_at: string
		}>(
			// These two together are the notifier's record of whether a *person* had
			// anything to do with the turn that just ended. An agent that schedules its own
			// next turn (a `/loop`) writes no message at all, so both stay put while
			// `status` cycles working → idle on every lap. Both are needed: `turn_started_at`
			// stays at the first message when a person steers the running turn, while
			// `last_user_message_at` moves. See src/notifications/notify.ts.
			`SELECT s.id, s.status, s.title, s.workspace_id, s.last_user_message_at, s.updated_at,
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
			updatedAt: r.updated_at,
			turnStartedAt: r.turn_started_at,
			lastUserMessageAt: r.last_user_message_at,
			workspaceTitle: workspaceTitle({ ...r, id: r.workspace_id }),
			repoName: r.repo_name,
			// A single-tab workspace's chat title is just the workspace again — only name it when it disambiguates.
			sessionTitle: r.tab_count > 1 ? r.title : null
		}))
	}
}
