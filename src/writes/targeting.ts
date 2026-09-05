import path from 'node:path'
import type { Workspace } from '../reads/types.ts'
import type { SendTarget } from './types.ts'

/**
 * The URL scheme Conductor registers, which is per *release channel*: the
 * production build answers `conductor://`, the pre-release ones
 * `conductor-alpha://`, `conductor-beta://`, `conductor-dev://` and friends.
 * Everything else in this file addresses `application "Conductor"` by name, so
 * production is the only channel the write path works against anyway — the
 * override exists so a channel build needs a variable rather than a patch.
 */
export const CONDUCTOR_SCHEME = process.env.RELAY_CONDUCTOR_SCHEME || 'conductor'

/**
 * Conductor's own link to a workspace, and optionally to one chat inside it —
 * exactly what its sidebar row menu copies under "Copy link" (Cmd+Shift+C).
 *
 * `conductor://workspace?id=<workspace>&session=<chat>` is the shape that works,
 * and the near misses all fail *badly*, so this is the one place that builds it:
 * the parameters sit behind a real `?` (unlike the create-workspace links, which
 * are flat after the scheme), the workspace id is `id` rather than `workspace`,
 * and `workspace` must be the URL's **host** — `conductor:///workspace/<id>`,
 * with the id in the path, falls through to the flat-parameter parser and
 * **creates a new workspace in the first repo**. A path-shaped link with the
 * right host (`conductor://workspace/<id>`) is merely ignored.
 *
 * `session` is optional and names a chat by `sessions.id`, the same id the relay
 * already serves; omitted, Conductor opens whichever tab that workspace had.
 * Current Conductor builds also unhide a session named by this route, through
 * their own session service. `restoreChat` uses that behavior and confirms the
 * exact id became visible; older builds may ignore it, so opening is no receipt.
 *
 * The https form Conductor copies for sharing —
 * `https://app.conductor.build/workspace/<id>?session=<chat>` — reaches the same
 * handler, but only once macOS has decided to hand it to the app; the desktop
 * build declares no associated domain, so a browser gets it first. Locally the
 * scheme form is the one that always lands.
 */
export function workspaceLink(workspaceId: string, sessionId: string | null): string {
	const params = new URLSearchParams({ id: workspaceId })
	if (sessionId) params.set('session', sessionId)
	return `${CONDUCTOR_SCHEME}://workspace?${params.toString()}`
}

/** Conductor's command palette matches workspaces by branch — its unique key. A
 * looser query (directory name) can match a command like unarchive, so prefer
 * branch and only fall back when it's absent. */
export function focusQuery(ws: Workspace): string {
	return ws.branch || ws.workspace_name || ws.directory_name || ''
}

/**
 * Every title Conductor might be showing for this workspace in the sidebar
 * (its precedence: manual name → PR title → humanized branch → codename). The
 * sidebar press tries each and requires a unique row; a miss just means we fall
 * back to the palette, so this doesn't have to reproduce the precedence exactly.
 */
function sidebarTitles(ws: Workspace): string[] {
	const slug = ws.branch?.includes('/') ? ws.branch.slice(ws.branch.indexOf('/') + 1) : ws.branch
	const humanized = slug?.replace(/[-_]/g, ' ').trim()
	return [
		ws.workspace_name,
		ws.pr_title,
		humanized ? humanized[0].toUpperCase() + humanized.slice(1) : '',
		ws.directory_name
	].filter((t): t is string => Boolean(t))
}

/**
 * May the actuator restart Conductor to force a window into existence?
 *
 * Restarting is the only lever left when a running, windowless Conductor ignores
 * both `reopen` and a Dock click — it is single-window and single-instance, so
 * there is nothing else to press. It is also the one step here that can destroy
 * work: quitting takes any agent mid-turn down with it. "Nothing is running" is a
 * fact only the read side has, so src/http/services/base.ts wires this to a DB read rather than
 * src/writes/targeting.ts guessing. Unset → never restart, which is the safe default for any
 * caller that hasn't opted in.
 */
let restartGuard: (() => boolean) | null = null

export function setRestartGuard(guard: (() => boolean) | null): void {
	restartGuard = guard
}

function restartAllowed(): boolean {
	try {
		return restartGuard?.() ?? false
	} catch {
		return false
	}
}

/** Fixed targeting values travel in the environment; the three UI labels ride in RELAY_TARGET_FILE. */
function targetEnv(target: SendTarget): Record<string, string> {
	return {
		RELAY_ALLOW_RESTART: restartAllowed() ? '1' : '',
		RELAY_TAB_INDEX: String(target.tab?.index ?? 0),
		RELAY_TAB_COUNT: String(target.tab?.count ?? 0),
		RELAY_WS_BRANCH: target.workspace.branch ?? '',
		RELAY_WS_REPO: target.workspace.repo_name ?? '',
		RELAY_WS_LINK: workspaceLink(target.workspace.id, target.sessionId)
	}
}

/**
 * The target file is line-based: tab title, palette query, then sidebar-title candidates. Conductor labels
 * cannot contain a newline, and `do shell script` reads this file as UTF-8 rather than MacRoman.
 */
function targetLines(target: SendTarget): string[] {
	return [target.tab?.title ?? '', focusQuery(target.workspace), ...sidebarTitles(target.workspace)]
}

/**
 * Give one UI action the three matching labels in a UTF-8 file. `system attribute` decodes text as MacRoman,
 * but it safely carries the temporary file path.
 */
export async function withTargetEnvironment<T>(
	target: SendTarget,
	action: (environment: Record<string, string>) => Promise<T>
): Promise<T> {
	const fs = await import('node:fs/promises')
	const os = await import('node:os')
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-target-'))
	const file = path.join(directory, 'text')
	try {
		await fs.writeFile(file, targetLines(target).join('\n'), 'utf8')
		return await action({ ...targetEnv(target), RELAY_TARGET_FILE: file })
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
	}
}
