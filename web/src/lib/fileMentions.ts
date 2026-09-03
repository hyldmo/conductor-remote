import { createContext, useContext } from 'react'
import { isPreviewableImage, isPreviewableSource } from '../../../src/shared.ts'

/**
 * Turn a file an agent named in prose into a source link.
 *
 * Agents write paths in backticks constantly — "updated `tests/foo.ts`", "plan written
 * to `~/.gstack/plan.md`" — and every one of them was dead text on the phone, while the
 * same path written as a Markdown link has opened the source sheet for a while now
 * (`Markdown.tsx` ▸ `sourceReference`). This is the missing half: the same sheet, from
 * the spelling people actually use.
 *
 * The rule that keeps it from linking prose is **a mention must name a file that is
 * really there**. Inline code holds far more than paths — `yarn build`, `sessions.status`,
 * `Array.map` — so an extension test alone would underline half the transcript and open
 * a "not found" sheet on each one. A relative mention is matched against the worktree's
 * own file list (`GET /api/workspaces/:id/files`), and an ambiguous one links nowhere:
 * `types.ts` naming two files is not a fact about either.
 *
 * An absolute path is the exception, and deliberately: `/Users/…` or `~/…` may point at
 * another workspace, at a plan file, at anything the relay is willing to read, so there
 * is no list to check it against. It is linked on its shape and **the relay decides
 * whether it may be opened** — `isAllowedPreviewPath` refuses everything outside the
 * workspaces root while the funnel is public, exactly as it does for a Markdown link.
 * Linking is not access.
 */
export type ResolveMention = (text: string) => string | null

/** Longer than any path worth linking, and a cheap ceiling on what the regex below sees. */
const MAX_MENTION_CHARS = 200
/** Explicit Markdown and attachment destinations may be longer than an inline-code mention. */
const MAX_EXPLICIT_REFERENCE_CHARS = 1000

/**
 * Resolve an explicit Markdown image destination against the chat's worktree.
 *
 * This intentionally does not consult the git-owned file list: QA images commonly live
 * in ignored `.context` directories, and the author already made an explicit link or
 * image rather than merely typing something path-shaped in prose. The relay still
 * realpaths and authorizes the result before reading a byte.
 */
export function resolveImageReference(href: string | null, worktree: string | null): string | null {
	if (!href || href.length > MAX_EXPLICIT_REFERENCE_CHARS) return null
	let decoded: string
	try {
		decoded = decodeURIComponent(href)
	} catch {
		return null
	}
	if (!isPreviewableImage(decoded) || decoded.includes('\0')) return null
	if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) return null
	if (decoded.split('/').includes('..')) return null
	if (decoded.startsWith('/') || decoded.startsWith('~/')) return decoded
	const relative = decoded.replace(/^(?:\.\/)+/, '')
	if (!relative) return null
	// An archived workspace has no worktree to resolve against. Keep classifying the
	// destination as local so the renderer can show "Image unavailable" instead of
	// following it into the PWA router and silently landing on Home.
	return worktree ? `${worktree}/${relative}` : relative
}

export interface AttachmentPreviewReference {
	reference: string
	kind: 'image' | 'source'
}

/**
 * Resolve a Conductor attachment token against the workspace that owns its chat.
 *
 * Attachments live in ignored `.context` directories, so they cannot use the git-owned
 * file list that ordinary prose mentions do. Their token is already an explicit file
 * reference; validate its exact on-disk shape here, then send it through the same image
 * or source viewer used by explicit Markdown links.
 */
export function resolveAttachmentReference(
	filePath: string | null,
	worktree: string | null
): AttachmentPreviewReference | null {
	if (!filePath || filePath.length > MAX_EXPLICIT_REFERENCE_CHARS || filePath.includes('\0')) return null
	if (!/^\.context\/attachments\/[A-Za-z0-9]{6}\/[^/]+$/.test(filePath)) return null
	const kind = isPreviewableImage(filePath) ? 'image' : isPreviewableSource(filePath) ? 'source' : null
	if (!kind) return null
	return { reference: worktree ? `${worktree}/${filePath}` : filePath, kind }
}

/**
 * The reference `/api/files/:reference` takes, or null.
 *
 * `worktree` is what makes a relative mention absolute; without one (an archived
 * workspace, whose worktree is deleted) only absolute mentions resolve.
 */
export function buildResolver(worktree: string | null, files: readonly string[] | undefined): ResolveMention {
	// Basename → the paths carrying it, so a mention costs one map lookup and a filter
	// over its namesakes rather than a scan of every file in the repo, on every code span.
	const byName = new Map<string, string[]>()
	for (const file of files ?? []) {
		const name = file.slice(file.lastIndexOf('/') + 1)
		const paths = byName.get(name)
		if (paths) paths.push(file)
		else byName.set(name, [file])
	}

	return text => {
		const mention = parseMention(text)
		if (!mention) return null
		const { path, location } = mention
		if (path.startsWith('/') || path.startsWith('~/')) return path + location
		if (!worktree) return null
		const match = uniqueFile(byName, path)
		return match ? `${worktree}/${match}${location}` : null
	}
}

/** The path an inline code span names, split from the `:line` or `:line:col` an agent appended. */
function parseMention(text: string): { path: string; location: string } | null {
	// Whitespace means this is a command, a sentence or a list — not one path. Nothing is
	// trimmed first, and that is load-bearing rather than strict: a fenced block with no
	// info string reaches the same component with no class either, and its trailing newline
	// is the one thing separating "`src/git.ts`" from a code block whose only line is that
	// path. A file name may legally contain a space; a mention of one simply doesn't link.
	if (!text || text.length > MAX_MENTION_CHARS || /\s/.test(text)) return null
	// A URL ends in a path and would otherwise resolve as one, taking the tap away from the browser.
	if (text.includes('://')) return null

	const found = text.match(/:([1-9]\d*)(?::\d+)?$/)
	const location = found ? found[0] : ''
	const path = found ? text.slice(0, -location.length) : text
	// `..` cannot be resolved against the file list, and the extension test is what keeps
	// ordinary prose (`status`, `Array.map`) out of the source sheet.
	if (path.startsWith('../') || path.includes('/../')) return null
	return isPreviewableSource(path) ? { path: path.startsWith('./') ? path.slice(2) : path, location } : null
}

/**
 * The one file this mention names, or null if the repo holds none or several.
 *
 * A suffix match is what lets `Markdown.tsx` and `components/Markdown.tsx` both find
 * `web/src/components/Markdown.tsx`, and the `/` boundary is what stops `dex.ts` from
 * matching `index.ts`. Requiring a *unique* hit is the same fail-closed rule the sidebar
 * row lookup follows: two candidates mean we don't know which was meant.
 */
function uniqueFile(byName: Map<string, string[]>, mention: string): string | null {
	const name = mention.slice(mention.lastIndexOf('/') + 1)
	const namesakes = byName.get(name)
	if (!namesakes) return null
	const matches = namesakes.filter(file => file === mention || file.endsWith(`/${mention}`))
	return matches.length === 1 ? matches[0] : null
}

/**
 * The resolver for the workspace on screen, or null where there is none.
 *
 * Context rather than a prop because the consumer is `ChatCode`, one entry in
 * `Markdown.tsx`'s static component map, which no caller threads props through. It also
 * has to update past `Markdown`'s `memo`: the file list lands a moment after the first
 * paint, and a context read is the one thing that re-renders a bailed-out subtree.
 */
interface FileReferenceContext {
	resolveMention: ResolveMention
	worktree: string | null
}

const FileReferences = createContext<FileReferenceContext | null>(null)

export const MentionResolverProvider = FileReferences.Provider

/**
 * What a chat outside a live workspace still resolves: absolute paths, which need no file
 * list. An archived chat is read from the same transcript as any other and its `~/plan.md`
 * is as readable as ever — only its worktree is gone — so the fallback is what stops the
 * same sentence linking in one chat and not in the one beside it.
 */
const ABSOLUTE_ONLY = buildResolver(null, undefined)

/** The reference an inline code span points at, or null when it is ordinary code. */
export function useFileMention(text: string | null): string | null {
	const resolve = useContext(FileReferences)?.resolveMention ?? ABSOLUTE_ONLY
	return text === null ? null : resolve(text)
}

/** Resolve a Markdown image or image link in the workspace currently on screen. */
export function useImageReference(href: string | null): string | null {
	return resolveImageReference(href, useContext(FileReferences)?.worktree ?? null)
}

/** Resolve a parsed attachment token in the workspace currently on screen. */
export function useAttachmentReference(filePath: string | null): AttachmentPreviewReference | null {
	return resolveAttachmentReference(filePath, useContext(FileReferences)?.worktree ?? null)
}
