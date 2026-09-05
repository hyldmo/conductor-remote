/**
 * The sidebar's "this workspace has a Run going" badge, re-derived from `ps`.
 *
 * Conductor's Run task is a long-lived shell wrapper. Starting Run in a workspace
 * spawns `/bin/zsh <worktree-key>/run-run:<n>.sh`, where the wrapper lives under
 * `~/.conductor/projects/<worktree-key>/` and `<worktree-key>` is that workspace's
 * own worktree path with every `/` turned into `--` (a leading slash becomes a
 * leading `--`). The wrapper *file* is written once and stays on disk after the task
 * stops, so its presence proves nothing — the live **process** is the fact. While a
 * Run is active that zsh process is in the table; when Run stops, it leaves.
 *
 * This is a better signal than "the dev-server port is open": a Run config can be a
 * non-server command that never listens, and an unrelated process can hold the port a
 * server-style Run would use. Matching the wrapper process ties the badge to the exact
 * task Conductor started, and to nothing else.
 *
 * Two things keep it from false-firing. The wrapper path must be zsh's **immediate
 * script argument** — not merely somewhere on the command line — so `zsh -c 'echo
 * …/run-run:1.sh'` and a non-zsh command that names the file both miss, and the script
 * must be `run-run:<n>.sh` specifically, so the setup wrapper (`run-setup:<n>.sh`) that
 * runs beside it is not read as an active Run.
 *
 * Like src/reads/background-tasks.ts, only `ps` **args** are read, never the environment. The
 * args snapshot can itself hold sensitive command-line data, so it is never logged.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Workspace } from '../reads/types.ts'

const exec = promisify(execFile)
const RUN_PROJECTS_DIR = path.join(homedir(), '.conductor', 'projects')

/**
 * The `~/.conductor/projects` key for a worktree: its absolute path with every `/`
 * replaced by `--`, so `/Users/me/conductor/workspaces/repo/praia` becomes
 * `--Users--me--conductor--workspaces--repo--praia`.
 */
export function runWrapperKey(worktree: string): string {
	return worktree.replace(/\//g, '--')
}

/**
 * The set of project keys with a live Run wrapper process, from one `ps -axww -o args=`
 * listing.
 *
 * The line must be `zsh <home>/.conductor/projects/<key>/run-run:<n>.sh`, with that
 * exact projects directory as zsh's **immediate** first argument. So a `-c` form
 * (whether it echoes the file or names it directly), another script argument, and any
 * non-zsh process naming it all miss. Escaping the known directory rather than parsing
 * shell words also preserves spaces and punctuation in both the home path and project
 * key. Two wrappers for one workspace — a restart, or two run ids — fold to one key.
 */
export function parseRunWrappers(ps: string, projectsDir = RUN_PROJECTS_DIR): Set<string> {
	const escapedDir = projectsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const runWrapper = new RegExp(`^(?:\\S*\\/)?zsh\\s+${escapedDir}\\/([^/\\r\\n]+?)\\/run-run:\\d+\\.sh(?:\\s|$)`)
	const keys = new Set<string>()
	for (const raw of ps.split('\n')) {
		const m = runWrapper.exec(raw.trim())
		if (m) keys.add(m[1])
	}
	return keys
}

/**
 * How long one `ps` listing is trusted. The sidebar polls `/api/state` every 2.5s, the
 * listing costs tens of milliseconds, and a Run that starts or stops is reflected
 * within this window — one poll late, against a badge nobody is timing to the second.
 */
const PS_FRESH_MS = 5000

let snapshot: { at: number; keys: Set<string> } = { at: 0, keys: new Set() }
let refreshing: Promise<void> | null = null

/**
 * The project keys with a live Run wrapper, stale-while-revalidate.
 *
 * Synchronous on purpose, exactly like src/reads/background-tasks.ts ▸ `agentProcessStarts`:
 * `/api/state` is assembled from plain reads and must not fork a `ps` on every 2.5s
 * poll. The first call after start answers empty — no badge for one poll — and every
 * call after that answers from the last listing while a fresh one lands.
 */
export function activeRunProjects(): Set<string> {
	if (Date.now() - snapshot.at > PS_FRESH_MS && !refreshing) {
		refreshing = exec('ps', ['-axww', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024 })
			.then(({ stdout }) => {
				snapshot = { at: Date.now(), keys: parseRunWrappers(stdout) }
			})
			.catch(() => {
				// `ps` failing is not a fact about any workspace: keep what we had, retry next window.
				snapshot = { ...snapshot, at: Date.now() }
			})
			.finally(() => {
				refreshing = null
			})
	}
	return snapshot.keys
}

/**
 * Flag each workspace whose worktree has a live Run wrapper process. Reads the cached
 * snapshot and refreshes it in the background, so `/api/state` stays synchronous.
 */
export function attachRunActivity(workspaces: Workspace[], liveRuns: () => Set<string> = activeRunProjects): void {
	const keys = liveRuns()
	for (const workspace of workspaces) {
		workspace.run_active = workspace.worktree ? keys.has(runWrapperKey(workspace.worktree)) : false
	}
}
