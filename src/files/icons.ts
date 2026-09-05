import fs from 'node:fs'
import path from 'node:path'

/**
 * Repo-icon resolution, mirroring Conductor's own logic so the phone sidebar shows
 * the same avatar as the desktop app. Precedence (see `describeRepoIcon`):
 *
 *   1. an explicit icon chosen in Conductor — the repos.icon column, either an
 *      `emoji:<glyph>` or a named Lucide icon (e.g. `book`, `monitor`);
 *   2. a known icon filename in the repository root — the FAQ's ordered list, at
 *      https://www.conductor.build/docs/faq#where-does-conductor-get-the-repo-icon;
 *   3. the GitHub owner's avatar (`github.com/<owner>.png`), derived from the
 *      remote URL — the fallback Conductor uses when nothing local matches;
 *   4. nothing → the phone renders a letter monogram.
 *
 * File lookup reads from the repo's root checkout (the shared, canonical tree),
 * not a per-workspace worktree, so every workspace of a repo resolves to one icon.
 */
const ICON_CANDIDATES = [
	'public/apple-touch-icon.png',
	'apple-touch-icon.png',
	'public/favicon.svg',
	'favicon.svg',
	'public/favicon.png',
	'public/icon.png',
	'public/logo.png',
	'favicon.png',
	'app/icon.png',
	'src/app/icon.png',
	'public/favicon.ico',
	'favicon.ico',
	'app/favicon.ico',
	'static/favicon.ico',
	'src-tauri/icons/icon.png',
	'assets/icon.png',
	'src/assets/icon.png'
]

const CONTENT_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon'
}

export interface ResolvedIcon {
	/** Absolute path to the icon file on disk. */
	path: string
	contentType: string
}

// Icons rarely change; a short TTL keeps the 2.5s state poll from stat-storming the
// disk while still picking up a freshly-added icon within a tick or two.
const TTL_MS = 30_000
const cache = new Map<string, { at: number; icon: ResolvedIcon | null }>()

/** First matching icon under `repoRoot`, or null if the repo has none. Cached per root. */
export function resolveRepoIcon(repoRoot: string): ResolvedIcon | null {
	const now = Date.now()
	const hit = cache.get(repoRoot)
	if (hit && now - hit.at < TTL_MS) return hit.icon

	let icon: ResolvedIcon | null = null
	for (const rel of ICON_CANDIDATES) {
		const abs = path.join(repoRoot, rel)
		if (fs.existsSync(abs)) {
			icon = { path: abs, contentType: CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' }
			break
		}
	}
	cache.set(repoRoot, { at: now, icon })
	return icon
}

/**
 * How the phone should render a repo's sidebar avatar. `emoji`/`named` render
 * inline (no bytes fetched); `file` is served by `/api/repos/:name/icon`;
 * `github` is loaded straight from `github.com/<owner>.png`. Null → monogram.
 */
export type RepoIcon =
	| { kind: 'emoji'; value: string }
	| { kind: 'named'; value: string }
	| { kind: 'file' }
	| { kind: 'github'; owner: string }

/**
 * GitHub owner (user or org) from a git remote URL, used for the
 * `github.com/<owner>.png` avatar. Handles https and scp-style ssh remotes;
 * null for non-GitHub hosts (the avatar URL is GitHub-specific).
 */
export function githubOwner(remoteUrl: string): string | null {
	const m = remoteUrl.match(/github\.com[:/]+([^/]+)\/[^/]+$/i)
	return m ? m[1].replace(/\.git$/i, '') : null
}

/** Resolve a repo's sidebar avatar to a render descriptor, following Conductor's precedence. */
export function describeRepoIcon(args: {
	icon: string | null
	repoRoot: string | null
	remoteUrl: string | null
}): RepoIcon | null {
	const explicit = args.icon?.trim()
	if (explicit) {
		if (explicit.startsWith('emoji:')) {
			const value = explicit.slice('emoji:'.length).trim()
			if (value) return { kind: 'emoji', value }
			// An empty `emoji:` is meaningless — fall through to the file/GitHub fallbacks.
		} else {
			return { kind: 'named', value: explicit }
		}
	}
	if (args.repoRoot && resolveRepoIcon(args.repoRoot)) return { kind: 'file' }
	const owner = args.remoteUrl ? githubOwner(args.remoteUrl) : null
	if (owner) return { kind: 'github', owner }
	return null
}
