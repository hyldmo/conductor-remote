// The relay computes a workspace's title, the query's tokens and the snippet markers
// too, so all three come from src/shared.ts — the one module under src/ this app may
// import a *value* from (it is stdlib-free on purpose; everything else is `import type`
// only, enforced by scripts/check-imports.ts). Two implementations of `workspaceTitle`
// meant the sidebar and a push notification could name the same workspace differently.
import {
	HIT_CLOSE,
	HIT_OPEN,
	modelLabel,
	queryTokens,
	shortModel,
	type Titled,
	timestampMs,
	workspaceTitle
} from '../../../src/shared.ts'
import type { Workspace } from './types.ts'

export { modelLabel, queryTokens, shortModel, type Titled, timestampMs, workspaceTitle }

function trimDecimal(value: string): string {
	return value.endsWith('.0') ? value.slice(0, -2) : value
}

/** Compact token counts without throwing away the useful first decimal below 100k. */
export function formatContextTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimDecimal((tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0))}M`
	if (tokens >= 1_000) return `${trimDecimal((tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0))}k`
	return String(tokens)
}

/** A nonzero context sliver should never be presented as zero percent. */
export function formatContextShare(tokens: number, total: number): string {
	if (tokens <= 0 || total <= 0) return '0%'
	const percent = (tokens / total) * 100
	return percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

/**
 * Split a relay snippet into plain and highlighted runs. The markers are control
 * characters, so they must never reach the DOM: an unsplit snippet renders as
 * invisible garbage between the words it was supposed to emphasise. Written with
 * splits rather than a regex because a control character inside one is a lint error
 * (Biome ▸ noControlCharactersInRegex), and suppressing that rule to save four lines
 * would be the wrong trade.
 */
export function splitSnippet(text: string): { text: string; hit: boolean }[] {
	const runs: { text: string; hit: boolean }[] = []
	const segments = text.split(HIT_OPEN)
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]
		if (i === 0) {
			if (segment) runs.push({ text: segment, hit: false })
			continue
		}
		const close = segment.indexOf(HIT_CLOSE)
		// An unterminated marker means the snippet was cut mid-highlight: keep the words
		// and drop the marker, rather than printing it.
		if (close < 0) {
			if (segment) runs.push({ text: segment, hit: true })
			continue
		}
		const hit = segment.slice(0, close)
		const rest = segment.slice(close + 1)
		if (hit) runs.push({ text: hit, hit: true })
		if (rest) runs.push({ text: rest, hit: false })
	}
	return runs
}

/** Fallback avatar glyph when a repo has no resolvable icon — its leading letter. */
export function repoMonogram(w: Workspace): string {
	const src = w.repo_name || workspaceTitle(w)
	return (src.trim()[0] ?? '?').toUpperCase()
}

/**
 * A workspace Conductor is still provisioning (creating the worktree / running the
 * setup command). Its session may already be idle, but the desktop app dims it and
 * labels it "setting up" — mirror that so a workspace stranded in this state (a known
 * Conductor stuck-state) stays visible here with an honest spinner instead of vanishing.
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
	conflicts: 'var(--color-pr-attention)',
	checks_failed: 'var(--color-pr-attention)',
	checks_pending: 'var(--color-working)',
	mergeable: 'var(--color-pr-mergeable)'
}

/**
 * The workspace dot: PR state drives the colour (merged/draft/attention/mergeable),
 * everything else falls back to blue. Setup uses a muted spinner. An active
 * agent or a PR with checks still running uses a spinner in its status colour
 * (`StatusDot`), so pending CI stays distinct from the solid attention dot used
 * by failed checks and merge conflicts.
 */
export function statusDot(w: Workspace): { color: string; spinning: boolean } {
	if (isSettingUp(w)) return { color: 'var(--color-muted)', spinning: true }
	const color = (w.pr_status && PR_DOT_COLORS[w.pr_status]) || 'var(--color-done)'
	return { color, spinning: w.session_status === 'working' || w.pr_status === 'checks_pending' }
}

/**
 * Has this workspace's PR landed? Read off `pr_status`, which the relay resolves
 * from `gh pr list` per repo (src/pr.ts) — **not** off Conductor's own status,
 * and the two genuinely disagree:
 *  - Conductor derives its status from a PR it sometimes never links (one opened
 *    and merged inside its poll window is invisible to it afterwards), so merged
 *    work sits in "In progress" indefinitely. And its `done` isn't a merge claim
 *    in the other direction either — it can be set by hand on work that never
 *    landed, so folding it in here would hide unmerged branches.
 *  - Ours lags too, just briefly and in the safe direction: the PR map is cached
 *    for 60s and degrades to `null` whenever `gh` is missing or unauthenticated.
 *    So a just-merged (or unresolvable) workspace stays *visible* for a moment
 *    rather than vanishing — the only lag a hide filter can afford.
 */
export function isMerged(w: Workspace): boolean {
	return w.pr_status === 'merged'
}

/**
 * Is this workspace marked Done? Read off the same status the sidebar groups by, so
 * the filter hides exactly the rows sitting under the "Done" header — a workspace
 * whose PR has landed but whose status was never moved stays put, which is what
 * `isMerged` is for. The two are separate toggles because they answer different
 * questions: one is the branch, the other is the label a person put on the work.
 */
export function isDone(w: Workspace): boolean {
	return workspaceStatus(w) === 'done'
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
export const STATUS_ORDER = ['done', 'in-review', 'in-progress', 'setting-up', 'backlog', 'canceled']

/**
 * The statuses you can *set*, in the order Conductor's own "Set status" menu lists
 * them. `setting-up` isn't here on purpose: it's a lifecycle state the app derives
 * from a provisioning worktree, not something the menu offers.
 */
export const SETTABLE_STATUSES = ['backlog', 'in-progress', 'in-review', 'done', 'canceled']

export function workspaceStatusLabel(status: string): string {
	const labels: Record<string, string> = {
		done: 'Done',
		'in-review': 'In review',
		'in-progress': 'In progress',
		'setting-up': 'Setting up',
		backlog: 'Backlog',
		canceled: 'Canceled'
	}
	return labels[status] ?? status
}

/**
 * The Recent view's day buckets, newest first. There is no status here on purpose:
 * grouping by status sorts finished work to the top, which buries the workspace you
 * were just in — the one a phone is nearly always reaching for.
 */
export const RECENT_BUCKETS = ['today', 'yesterday', 'week', 'month', 'older'] as const
export type RecentBucket = (typeof RECENT_BUCKETS)[number]

export function recentBucketLabel(bucket: RecentBucket): string {
	const labels: Record<RecentBucket, string> = {
		today: 'Today',
		yesterday: 'Yesterday',
		week: 'Past week',
		month: 'Past month',
		older: 'Older'
	}
	return labels[bucket]
}

function startOfDay(at: Date): number {
	const day = new Date(at)
	day.setHours(0, 0, 0, 0)
	return day.getTime()
}

/**
 * Which bucket a timestamp falls in, by whole calendar days on *this device* — the
 * card's `relativeTime` reads the same column, and both should agree with the clock
 * in the status bar. Days apart rather than hours elapsed, or a workspace touched at
 * 23:50 would still say "Today" at 00:10; `Math.round` absorbs the 23- and 25-hour
 * days DST makes. A stamp ahead of this clock (the relay's Mac and the phone need
 * not agree) lands in `today` rather than somewhere past it.
 */
export function recentBucket(iso: string, now: Date = new Date()): RecentBucket {
	const at = new Date(timestampMs(iso))
	if (!Number.isFinite(at.getTime())) return 'older'
	const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
	if (days <= 0) return 'today'
	if (days === 1) return 'yesterday'
	if (days < 7) return 'week'
	if (days < 30) return 'month'
	return 'older'
}

/**
 * Conductor's lifecycle labels, coloured in the workspace dot's existing PR
 * language. This changes only presentation: grouping and writes still use
 * `manual_status` / `derived_status` above.
 */
export const STATUS_COLORS: Record<string, string> = {
	done: 'var(--color-pr-merged)',
	'in-review': 'var(--color-pr-mergeable)',
	'in-progress': 'var(--color-done)',
	'setting-up': 'var(--color-muted)'
}

/**
 * One flat line of a prompt, for the jump sheet's rows (components/MessageNav.tsx).
 * The first line that has anything in it — a prompt often opens with a heading or a
 * bullet, and the marker is noise at this size — collapsed and cut to a little past
 * the two lines the row clamps to, so the ellipsis lands where the row does.
 */
export function messagePreview(text: string, max = 120): string {
	const line = text.split('\n').find(l => l.trim()) ?? ''
	const flat = line
		.replace(/^[\s>#*\-+]+/, '')
		.replace(/`/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A running duration for the working indicator: `12s` → `4m 07s` → `1h 04m 07s`.
 * Padded once a bigger unit is in play so the label stops twitching as it counts,
 * and clamped at zero — the relay's clock and the phone's don't have to agree.
 */
export function elapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const s = total % 60
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	const pad = (n: number) => String(n).padStart(2, '0')
	if (h) return `${h}h ${pad(m)}m ${pad(s)}s`
	if (m) return `${m}m ${pad(s)}s`
	return `${s}s`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Where an age in words stops being useful and a date takes over. */
const AGE_LIMIT = 7 * DAY

/** The clock alone, in the phone's own locale and timezone. */
function clockTime(at: Date): string {
	return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * `Jul 7, 04:40`, carrying the year once it isn't the current one — most of the chats
 * this reaches are archived, and half of them are older than the calendar on screen.
 */
function dateStamp(at: Date, now: Date): string {
	const date = at.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
	})
	return `${date}, ${clockTime(at)}`
}

/**
 * When a message was sent, in the phone's own locale and timezone. The date is only
 * spelled out once the message isn't from today — a chat left open overnight would
 * otherwise show two "09:14"s a day apart.
 */
export function messageTime(iso: string): string {
	const at = new Date(timestampMs(iso))
	if (!Number.isFinite(at.getTime())) return ''
	const now = new Date()
	return at.toDateString() === now.toDateString() ? clockTime(at) : dateStamp(at, now)
}

/**
 * How long ago something happened, for a row with the width to say it in words.
 *
 * Under a week it is `relativeAge`, the same wording the sidebar prints, because one
 * age said two ways in one app reads as two different ages. From a week on it becomes
 * the date instead: "23 days ago" is arithmetic where "9 Aug, 22:43" is the answer,
 * and it is the cut-off that keeps this from ever reaching that helper's month and
 * year buckets.
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
	const at = new Date(timestampMs(iso))
	const age = now - at.getTime()
	if (!Number.isFinite(age)) return ''
	if (age >= AGE_LIMIT) return dateStamp(at, new Date(now))
	return relativeAge(iso, now)
}

export function relativeTime(iso: string): string {
	const then = timestampMs(iso)
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

/**
 * One formatter, kept: a `Intl.RelativeTimeFormat` costs real work to build and the
 * sidebar prints one age per row on a list that re-reads every 2.5s. The locale is
 * the phone's own and doesn't change under a running app.
 */
let relativeWords: Intl.RelativeTimeFormat | undefined

/**
 * The same age as `relativeTime`, spelled out — "2 hours ago" where a row has the
 * width for it. Intl does the wording, so it follows the phone's language and says
 * "yesterday" rather than "1 day ago" where that reads better; only "now" is ours,
 * because Intl has no word for the age a row spends most of its life at.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
	const then = timestampMs(iso)
	if (!Number.isFinite(then)) return ''
	const secs = Math.round((now - then) / 1000)
	if (secs < 45) return 'now'
	relativeWords ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
	if (secs < 90) return relativeWords.format(-1, 'minute')
	const mins = Math.round(secs / 60)
	if (mins < 60) return relativeWords.format(-mins, 'minute')
	const hrs = Math.round(mins / 60)
	if (hrs < 24) return relativeWords.format(-hrs, 'hour')
	const days = Math.round(hrs / 24)
	// Days stop being a unit anyone reads at a glance somewhere around a month: the
	// short form can afford "157d", where the words cannot.
	if (days < 30) return relativeWords.format(-days, 'day')
	const months = Math.round(days / 30.4)
	if (months < 12) return relativeWords.format(-months, 'month')
	return relativeWords.format(-Math.round(days / 365), 'year')
}
