import path from 'node:path'
import type { Workspace } from '../reads/types.ts'
import { CONDUCTOR_HANDLERS, osaError, SEND_ATTEMPT_MS } from './runner.ts'
import { CONDUCTOR_SCHEME, focusQuery, withTargetEnvironment } from './targeting.ts'
import type { RunTaskResult, SendResult, SendTarget } from './types.ts'
import { exec, uiTurn } from './ui-lock.ts'

/**
 * Put a workspace away — Conductor's own "Archive workspace" (Command-Shift-A),
 * pressed on the workspace this run has just focused and asserted.
 *
 * The chord acts on whatever the pane is showing, so the assertion is the entire
 * guard and the branch is required rather than optional, exactly as it is for
 * `stopTurn`. The damage is worse here than a mis-aimed prompt: archiving deletes
 * the worktree and takes any agent mid-turn down with it, so a workspace whose pane
 * cannot be checked is refused instead of guessed at.
 *
 * `stopAgents` is what the caller has said about that second half. Conductor draws a
 * confirmation ("Stop agents and archive") when the workspace still has an agent
 * working, and the script presses it only with this set; without it the dialog is
 * dismissed and the run fails, so a tap that meant "archive" can never quietly end
 * someone else's turn. An idle workspace draws no dialog at all.
 *
 * Nothing is confirmed here. `workspaces.state` becoming `archived` is the receipt
 * and src/http/routes/workspaces.ts waits for it, the same way the stop and the status change do.
 */
export async function archiveWorkspace(workspace: Workspace, stopAgents: boolean): Promise<SendResult> {
	if (!workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my archiveWorkspace()
return "ok"`.trim()
	try {
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment, RELAY_ARCHIVE_AGENTS: stopAgents ? '1' : '' },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Continue a merged workspace on a new branch through Conductor's own Continue
 * button. This deliberately does not perform `git checkout` itself: the native
 * action also updates Conductor's workspace identity, preserves the existing
 * sessions, clears the merged PR metadata, and stages its Branch continued.md
 * context in the selected chat. Reproducing only the git half would leave the DB
 * and UI describing the branch we just moved away from; writing the DB is forbidden.
 *
 * The exact chat matters even though every chat survives. Conductor attaches the
 * continuation note to the selected one, so the target carries the phone's current
 * session and `selectChatTab` asserts it before the button is found. The button is
 * available only in Conductor's merged action bar; an absent or ambiguous control
 * fails closed. src/http/routes/workspaces.ts confirms success from the resulting branch change.
 */
export async function continueWorkspace(target: SendTarget): Promise<SendResult> {
	if (!target.workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my continueWorkspaceOnNewBranch()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * The workspace statuses Conductor's sidebar groups by, mapped from the value it
 * stores in `workspaces.manual_status` to the label on its own menu. `canceled`
 * is on the menu but has never been written in this DB, so it's the one spelling
 * here that is taken from the UI rather than confirmed against stored data — a
 * mismatch surfaces as a failed confirmation naming what Conductor actually wrote.
 */
export const WORKSPACE_STATUS_LABELS: Record<string, string> = {
	backlog: 'Backlog',
	'in-progress': 'In progress',
	'in-review': 'In review',
	done: 'Done',
	canceled: 'Canceled'
}

/**
 * Move a workspace between the sidebar's status groups — the thing a merged PR
 * that Conductor never linked can't do for itself.
 *
 * Unlike every other write here this one never changes what's on screen: it
 * right-clicks the workspace's *row* (AXShowMenu) and works the menu, so the
 * workspace you were reading stays open. It does need the row to be rendered, and
 * a collapsed sidebar section renders none — so the script opens the folded
 * sections itself, looks again, and folds back exactly the ones it opened. That
 * costs a second sidebar scan, which is affordable only because that scan reads
 * every row's name in two Apple events rather than one per row (15s → ~1s on a
 * 50-workspace sidebar; see findSidebarRow). Measured end to end on 2026-09-01:
 * 8.2s through a folded section, 5.4s through an open one. The budget is 35s
 * anyway, because sidebarRowsAndNames falls back to the per-row reads when the
 * list no longer matches its shape, and that path pays the old 15s twice.
 */
export async function setWorkspaceStatus(workspace: Workspace, status: string): Promise<SendResult> {
	const label = WORKSPACE_STATUS_LABELS[status]
	if (!label) return { ok: false, strategy: 'applescript', error: `unknown status ${status}` }
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my setWorkspaceStatus()
return "ok"`.trim()
	try {
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_SET_STATUS: label
					},
					timeout: 35000
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Create a *new workspace*, optionally with a first prompt, via Conductor's
 * deep-link scheme (conductor.build/docs/reference/deep-links).
 *
 * This is the one write here that touches no UI at all: no Accessibility, no
 * keystrokes, no focus dependency — macOS hands the URL to Conductor and it
 * creates the worktree. Nothing to rebreak on an update, unlike every other
 * path in this file.
 *
 * Three things the scheme dictates:
 *  - Parameters sit *flat* after the scheme (`conductor://prompt=…&path=…`), not
 *    behind a `?`, and every value must be URL-encoded — which is also what stops
 *    a prompt containing `&path=` from redirecting the workspace to another repo.
 *  - **An unmatched (or absent) `path` silently falls back to the first repo**, so
 *    the caller resolves a real `root_path` first rather than trusting a name.
 *  - **`prompt` is optional**: a bare `conductor://path=…` opens an empty
 *    workspace, same as Conductor's own New workspace. That form isn't in the
 *    docs (every documented route carries a prompt) but is verified against the
 *    live app — so if it ever stops working, this is the line to suspect.
 *
 * The link is fire-and-forget: it reports that Conductor was *handed* the URL,
 * never that a workspace appeared. The caller watches the DB for that.
 */
export async function createWorkspace(prompt: string, repoPath: string | null): Promise<SendResult> {
	if (!prompt.trim() && !repoPath) {
		return { ok: false, strategy: 'deeplink', error: 'a new workspace needs a repo or a first prompt' }
	}
	const query = [
		prompt.trim() ? `prompt=${encodeURIComponent(prompt)}` : '',
		repoPath ? `path=${encodeURIComponent(repoPath)}` : ''
	]
		.filter(Boolean)
		.join('&')
	try {
		// Serialized with the AX writes: creating a workspace pulls Conductor forward and
		// switches which one is showing, which is precisely what a concurrent send assumes.
		await uiTurn(() => exec('open', [`${CONDUCTOR_SCHEME}://${query}`], { timeout: 15000 }))
		return { ok: true, strategy: 'deeplink' }
	} catch (err) {
		return { ok: false, strategy: 'deeplink', error: osaError(err) }
	}
}

/**
 * Start one exact workspace Run task, or stop the running one, through Conductor's toolbar.
 *
 * The task stays owned by Conductor — it appears in the Run panel, inherits the
 * repository's run mode and environment, and Conductor performs its normal
 * process-group shutdown. A named start selects that item from Conductor's own
 * Run menu; an unnamed legacy start proceeds only when the live menu contains one
 * task. Every path focuses and asserts the target workspace before touching it.
 */
export async function setRunTask(workspace: Workspace, running: boolean, runTaskName?: string): Promise<RunTaskResult> {
	if (!focusQuery(workspace)) return { ok: false, error: 'workspace has no branch to focus' }
	const script = `
${CONDUCTOR_HANDLERS}

set wantRunning to (system attribute "RELAY_RUN_WANTED") is "1"
set wantedTask to do shell script "cat " & quoted form of (system attribute "RELAY_RUN_TASK_FILE")
return my setRunTask(wantRunning, wantedTask)`.trim()
	const os = await import('node:os')
	const fs = await import('node:fs/promises')
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-run-task-'))
	const taskFile = path.join(directory, 'name')
	try {
		await fs.writeFile(taskFile, runTaskName ?? '', 'utf8')
		const { stdout } = await withTargetEnvironment(
			{ workspace, sessionId: workspace.active_session_id },
			targetEnvironment =>
				uiTurn(() =>
					exec('osascript', ['-e', script], {
						env: {
							...process.env,
							...targetEnvironment,
							RELAY_RUN_WANTED: running ? '1' : '0',
							RELAY_RUN_TASK_FILE: taskFile
						},
						timeout: SEND_ATTEMPT_MS
					})
				)
		)
		const [state, task, changed, rawPorts = '', rawPreviewUrls = ''] = stdout.trim().split('\t')
		if (state !== 'running' && state !== 'stopped') throw new Error(`unexpected Run state: ${state || 'empty'}`)
		const ports = rawPorts
			.split(',')
			.map(Number)
			.filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
		const previewUrls = rawPreviewUrls
			.split('\x1e')
			.map(url => url.trim())
			.filter(Boolean)
		return { ok: true, state, task, changed: changed === 'true', previewUrls, ports }
	} catch (err) {
		return { ok: false, error: osaError(err, 'Conductor took too long to change the Run task') }
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
	}
}
