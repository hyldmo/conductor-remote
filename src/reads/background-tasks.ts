/**
 * The desktop's "Waiting for task" row, re-derived from the SDK stream.
 *
 * A `Bash` call with `run_in_background` (or a background Agent) is a *task*: the SDK
 * writes `system/task_started {task_id, tool_use_id, description, task_type}`, the tool
 * result says "Command running in background", the turn ends, and `sessions.status`
 * goes `idle`. Minutes or hours later the command finishes, the SDK writes
 * `system/task_notification {task_id, status}` and resumes the agent with a fresh
 * `init`. So a chat waiting on a task reads as a finished turn everywhere `status` is
 * read — the phone drew nothing, and the notifier said "done" at the wait.
 *
 * The open set is what this file computes: started, not yet notified. What makes it
 * truthful rather than a list that grows forever is the **process gate**. Conductor
 * runs one `claude --resume=<session>` child per active chat, and a task belongs to
 * that process: when it goes, the notification never comes. Measured over 4,930 tasks
 * on this Mac, 25 were never closed and every one of them sits before a process
 * restart (a later prompt spawned a new child, or Conductor itself relaunched). An
 * abort does *not* end one — 6 tasks completed straight through an "aborted by user" —
 * so the notification and the process's death are the only two things that close a
 * wait, and nothing else here is allowed to.
 *
 * The process list is read from `ps` **args only**. The session id sits in the child's
 * own arguments, so the environment — which carries Conductor's tokens — is never
 * requested, never held and never logged (the dev-server snapshot has the opposite
 * problem and the same rule).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { timestampMs } from '../shared.ts'

const exec = promisify(execFile)

/** One background task a chat is still waiting on. */
export interface BackgroundTask {
	taskId: string
	/** The `tool_use` that started it — the Bash or Agent row the phone already shows. */
	toolUseId: string | null
	/** The call's own description, which is what the desktop prints beside "Waiting for task". */
	description: string
	/** `local_bash` for a background command, `local_agent` for a background subagent. */
	taskType: string
	/** When the task started, ISO — the elapsed timer's origin. */
	since: string
}

/** The two columns `openBackgroundTasks` reads off a `session_messages` row. */
export interface TaskFrameRow {
	created_at: string
	content: string
}

interface TaskFrame {
	type?: unknown
	subtype?: unknown
	task_id?: unknown
	tool_use_id?: unknown
	description?: unknown
	task_type?: unknown
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Fold a chat's task frames into the tasks still open, in the order they started.
 *
 * `processStartedAt` is when the chat's agent process came up (epoch ms). A task
 * started before it belonged to a process that is gone, and its notification will
 * never be written — so it is dropped here rather than shown until the heat death of
 * the relay. Pass 0 to trust every frame (a caller that has no process to check).
 */
export function openBackgroundTasks(rows: readonly TaskFrameRow[], processStartedAt: number): BackgroundTask[] {
	const open = new Map<string, BackgroundTask>()
	for (const row of rows) {
		let frame: TaskFrame
		try {
			frame = JSON.parse(row.content)
		} catch {
			continue
		}
		if (frame.type !== 'system') continue
		const taskId = str(frame.task_id)
		if (!taskId) continue
		if (frame.subtype === 'task_notification') {
			open.delete(taskId)
		} else if (frame.subtype === 'task_started') {
			if (timestampMs(row.created_at) < processStartedAt) continue
			const taskType = str(frame.task_type) ?? 'task'
			open.set(taskId, {
				taskId,
				toolUseId: str(frame.tool_use_id) ?? null,
				description: str(frame.description) ?? taskType,
				taskType,
				since: row.created_at
			})
		}
	}
	return [...open.values()]
}

/** The SQL prefix filter that selects exactly the frames `openBackgroundTasks` reads. */
export const TASK_FRAME_FILTER = `(content LIKE '{"type":"system","subtype":"task_started"%'
   OR content LIKE '{"type":"system","subtype":"task_notification"%')`

/**
 * Which chats have a live agent process, and since when — from one
 * `ps -axo pid=,lstart=,args=` listing.
 *
 * Conductor's child is `…/claude --output-format stream-json … --resume=<session id>`,
 * and the id in that argument is `sessions.id` (a Conductor chat *is* a Claude Code
 * session). A brand-new chat may be started with `--session-id` instead, so both are
 * read. Anything else that happens to run a `claude` binary — the Chrome native host,
 * a terminal — carries neither and is skipped.
 *
 * `lstart` is second-resolution local time in `ps`'s own format ("Wed Sep  2 12:05:23
 * 2026"), which `Date.parse` reads; a line it cannot parse is kept with a start of 0,
 * because a process that is there and undatable is still a process that is there.
 */
export function parseAgentProcesses(ps: string): Map<string, number> {
	const starts = new Map<string, number>()
	for (const line of ps.split('\n')) {
		// The executable runs up to the first flag: its path holds a space ("Application Support").
		const m = /^\s*\d+\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*?)(?:\s+(--.*))?$/.exec(line)
		if (!m || !/(^|\/)claude$/.test(m[2])) continue
		const args = m[3] ?? ''
		const session =
			/--(?:resume|session-id)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(args)
		if (!session) continue
		const started = Date.parse(m[1])
		const at = Number.isNaN(started) ? 0 : started
		const known = starts.get(session[1])
		starts.set(session[1], known === undefined ? at : Math.max(known, at))
	}
	return starts
}

/**
 * How long one `ps` listing is trusted. The sessions poll asks every 2s, the listing
 * costs tens of milliseconds, and a process that exits is noticed within this window —
 * one poll late, against a wait that is measured in minutes.
 */
const PS_FRESH_MS = 5000

let snapshot: { at: number; sessions: Map<string, number> } = { at: 0, sessions: new Map() }
let refreshing: Promise<void> | null = null

/**
 * The live agent processes, stale-while-revalidate.
 *
 * Synchronous on purpose: `Reads.listSessions` is a plain DB read with six callers
 * that do not await, and a `ps` shell-out is not worth making all of them async. The
 * first call after start answers with an empty map — no wait shown for one poll —
 * and every call after that answers from the last listing while a fresh one lands.
 */
export function agentProcessStarts(): Map<string, number> {
	if (Date.now() - snapshot.at > PS_FRESH_MS && !refreshing) {
		refreshing = exec('ps', ['-axo', 'pid=,lstart=,args='], { maxBuffer: 16 * 1024 * 1024 })
			.then(({ stdout }) => {
				snapshot = { at: Date.now(), sessions: parseAgentProcesses(stdout) }
			})
			.catch(() => {
				// `ps` failing is not a fact about any chat: keep what we had and try again next window.
				snapshot = { ...snapshot, at: Date.now() }
			})
			.finally(() => {
				refreshing = null
			})
	}
	return snapshot.sessions
}
