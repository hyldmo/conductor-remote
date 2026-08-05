import type { Workspace } from './types.ts'

export function workspaceLabel(w: Workspace): string {
	return w.workspace_name || w.pr_title || humanizeBranch(w.branch) || w.directory_name || w.id.slice(0, 8)
}

/**
 * Conductor's own workspace title precedence, reproduced:
 *   manual name → PR title → humanized branch → worktree codename → id.
 * `pr_title` is Conductor's cached PR title, present exactly when the workspace
 * has a PR (in-review or done) and cleared back to empty otherwise — so it's the
 * live sidebar title, not a stale value. The branch minus its prefix, sentence-
 * cased, is Conductor's own fallback while a workspace is still in-progress:
 * prefix-agnostic (github_username/custom/none), stripping the first path segment
 * rather than reading Conductor's `branch_prefix_type` setting since the branch
 * already embeds the resolved prefix. directory_name (the worktree codename, e.g.
 * "managua-v2") is a last resort for a branchless workspace.
 */
function humanizeBranch(branch: string | null): string {
	if (!branch) return ''
	const slug = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch
	const words = slug.replace(/[-_]/g, ' ').trim()
	return words ? words[0].toUpperCase() + words.slice(1) : ''
}

/** Fallback avatar glyph when a repo has no resolvable icon — its leading letter. */
export function repoMonogram(w: Workspace): string {
	const src = w.repo_name || workspaceLabel(w)
	return (src.trim()[0] ?? '?').toUpperCase()
}

/**
 * A workspace Conductor is still provisioning (creating the worktree / running the
 * setup command). Its session may already be idle, but the desktop app dims it and
 * labels it "setting up" — mirror that so a workspace stranded in this state (a known
 * Conductor stuck-state) stays visible here with an honest badge instead of vanishing.
 */
export function isSettingUp(w: Workspace): boolean {
	return w.state === 'setting_up'
}

/** Normalize the many status sources into one of three UI states. */
export type UiStatus = 'working' | 'idle' | 'done'

export function uiStatus(w: Workspace): UiStatus {
	if (w.session_status === 'working') return 'working'
	if (w.derived_status === 'done' || w.manual_status === 'done') return 'done'
	return 'idle'
}

export function statusLabel(w: Workspace): string {
	const s = uiStatus(w)
	if (s === 'working') return 'working'
	if (s === 'done') return 'done'
	return w.session_status || 'idle'
}

const PR_DOT_COLORS: Record<NonNullable<Workspace['pr_status']>, string> = {
	merged: 'var(--color-pr-merged)',
	draft: 'var(--color-pr-draft)',
	conflicts: 'var(--color-pr-conflicts)',
	mergeable: 'var(--color-pr-mergeable)'
}

/**
 * The workspace dot: PR state drives the colour (merged/draft/conflicts/mergeable),
 * everything else falls back to the accent. While the agent is working the dot is
 * drawn as a spinner in that colour instead (`StatusDot`).
 */
export function statusDot(w: Workspace): { color: string; working: boolean } {
	const color = (w.pr_status && PR_DOT_COLORS[w.pr_status]) || 'var(--color-accent)'
	return { color, working: w.session_status === 'working' }
}

/**
 * The workspace lifecycle status the desktop sidebar groups by — a manual
 * override beats the derived one (same precedence as the app).
 */
export function workspaceStatus(w: Workspace): string {
	// A still-provisioning workspace groups on its own — it isn't an active agent run,
	// so folding it into "In progress" (as Conductor does) is the confusion we avoid.
	if (isSettingUp(w)) return 'setting-up'
	return w.manual_status || w.derived_status || 'in-progress'
}

/** Group order matches the desktop sidebar (Done → In review → In progress → Setting up → Backlog). */
export const STATUS_ORDER = ['done', 'in-review', 'in-progress', 'setting-up', 'backlog']

export function workspaceStatusLabel(status: string): string {
	const labels: Record<string, string> = {
		done: 'Done',
		'in-review': 'In review',
		'in-progress': 'In progress',
		'setting-up': 'Setting up',
		backlog: 'Backlog'
	}
	return labels[status] ?? status
}

/** Compact model name: strip the `claude-`/date noise for the phone. */
export function shortModel(model: string | null): string {
	if (!model) return ''
	return model
		.replace(/^claude-/, '')
		.replace(/-\d{8}$/, '')
		.replace(/-latest$/, '')
}

export function relativeTime(iso: string): string {
	const then = new Date(iso).getTime()
	if (!Number.isFinite(then)) return ''
	const secs = Math.round((Date.now() - then) / 1000)
	if (secs < 45) return 'now'
	if (secs < 90) return '1m'
	const mins = Math.round(secs / 60)
	if (mins < 60) return `${mins}m`
	const hrs = Math.round(mins / 60)
	if (hrs < 24) return `${hrs}h`
	return `${Math.round(hrs / 24)}d`
}
