import fs from 'node:fs'

import type http from 'node:http'

import os from 'node:os'

import path from 'node:path'

import { isAllowedPreviewPath, parseFileReference, parseImageReference } from '../../files/file-preview.ts'

import { readExposeMode } from '../../host/tailscale.ts'
import type { BaseServices } from './base.ts'
import type { ResponsesServices } from './responses.ts'

export function createFilesServices(services: Pick<ResponsesServices, 'json'> & Pick<BaseServices, 'cfg'>) {
	const { json, cfg } = services

	const MIME: Record<string, string> = {
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.webmanifest': 'application/manifest+json; charset=utf-8',
		'.svg': 'image/svg+xml',
		'.png': 'image/png'
	}

	const LOCAL_IMAGE_TYPES: Record<string, string> = {
		'.avif': 'image/avif',
		'.gif': 'image/gif',
		'.jpeg': 'image/jpeg',
		'.jpg': 'image/jpeg',
		'.png': 'image/png',
		'.webp': 'image/webp'
	}

	const LOCAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024

	// `/tmp` is a symlink to `/private/tmp` on macOS. os.tmpdir() also covers tools that use the user's
	// per-login temporary directory instead. Resolve both before checking a requested file's real path.
	const LOCAL_IMAGE_ROOTS = [...new Set([os.tmpdir(), '/tmp'].map(root => fs.realpathSync(root)))]

	function insideRoot(filePath: string, root: string): boolean {
		const rel = path.relative(root, filePath)
		return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	}

	async function serveLocalImage(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		requestedPath: string
	): Promise<void> {
		const target = parseImageReference(requestedPath)
		const contentType = target ? LOCAL_IMAGE_TYPES[path.extname(target).toLowerCase()] : null
		if (!target || !contentType) return json(req, res, 404, { error: 'image not found' })

		let filePath: string
		let size: number
		try {
			filePath = await fs.promises.realpath(target)
			if (!LOCAL_IMAGE_ROOTS.some(root => insideRoot(filePath, root))) {
				const [workspaceRoot, homeRoot, bundledSkillsRoot] = await Promise.all([
					fs.promises.realpath(cfg.workspacesRoot),
					fs.promises.realpath(os.homedir()),
					fs.promises.realpath(BUNDLED_SKILLS_ROOT).catch(() => null)
				])
				if (!isAllowedPreviewPath(filePath, workspaceRoot, homeRoot, readExposeMode(), bundledSkillsRoot)) {
					return json(req, res, 404, { error: 'image not found' })
				}
			}
			const info = await fs.promises.stat(filePath)
			if (!info.isFile()) return json(req, res, 404, { error: 'image not found' })
			size = info.size
		} catch {
			return json(req, res, 404, { error: 'image not found' })
		}
		if (size > LOCAL_IMAGE_MAX_BYTES) return json(req, res, 413, { error: 'image is too large' })

		res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
		fs.createReadStream(filePath)
			.once('error', () => res.destroy())
			.pipe(res)
	}

	/** A preview stays small enough to render smoothly in the phone's source sheet. */
	const FILE_PREVIEW_MAX_BYTES = 512 * 1024

	const FILE_PREVIEW_CONTEXT_LINES = 100

	const FILE_PREVIEW_FIRST_LINES = 500

	const BUNDLED_SKILLS_ROOT = '/Applications/Conductor.app/Contents/Resources/conductor-skill/skills'

	/**
	 * Serve source that an agent linked in its Markdown. The link format comes from
	 * coding-agent file references, but its path still arrives from a remote client.
	 * Public Funnel clients stay within Conductor workspaces. Tailnet-only relays may
	 * also read supporting source files from the signed-in user's home directory.
	 */
	async function serveFilePreview(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		reference: string
	): Promise<void> {
		const target = parseFileReference(reference)
		if (!target) return json(req, res, 404, { error: 'source file not found' })
		const refused = (filePath: string) => {
			const answer = previewRefusal(filePath)
			return json(req, res, answer.status, { error: answer.error })
		}

		let filePath: string
		let workspaceRoot: string
		let homeRoot: string
		let bundledSkillsRoot: string | null
		let size: number
		try {
			;[filePath, workspaceRoot, homeRoot, bundledSkillsRoot] = await Promise.all([
				fs.promises.realpath(target.path),
				fs.promises.realpath(cfg.workspacesRoot),
				fs.promises.realpath(os.homedir()),
				fs.promises.realpath(BUNDLED_SKILLS_ROOT).catch(() => null)
			])
			if (!isAllowedPreviewPath(filePath, workspaceRoot, homeRoot, readExposeMode(), bundledSkillsRoot)) {
				return refused(filePath)
			}
			const info = await fs.promises.stat(filePath)
			if (!info.isFile()) return json(req, res, 404, { error: 'source file not found' })
			size = info.size
		} catch {
			// A path this relay would refuse must answer the same whether or not it is there, or
			// a public client learns which home files exist by watching 404 turn into 403.
			return refused(target.path)
		}
		if (size > FILE_PREVIEW_MAX_BYTES) return json(req, res, 413, { error: 'source file is too large to preview' })

		let content: string
		try {
			const raw = await fs.promises.readFile(filePath)
			if (raw.includes(0)) return json(req, res, 415, { error: 'source file is not text' })
			content = new TextDecoder('utf-8', { fatal: true }).decode(raw)
		} catch {
			return json(req, res, 415, { error: 'source file is not text' })
		}

		const lines = content.split('\n')
		const focus = target.line === null ? null : Math.min(target.line, lines.length)
		const start = focus === null ? 0 : Math.max(0, focus - FILE_PREVIEW_CONTEXT_LINES - 1)
		const end =
			focus === null
				? Math.min(lines.length, FILE_PREVIEW_FIRST_LINES)
				: Math.min(lines.length, focus + FILE_PREVIEW_CONTEXT_LINES)
		return json(req, res, 200, {
			path: target.path,
			line: focus,
			lineStart: start + 1,
			lineEnd: end,
			totalLines: lines.length,
			content: lines.slice(start, end).join('\n'),
			truncated: start > 0 || end < lines.length
		})
	}

	/**
	 * How to answer for a file the preview will not serve, from the path alone.
	 *
	 * Chat mentions made the home-directory case ordinary — agents write "plan written to
	 * `~/.gstack/plan.md`" constantly — and on a public funnel every one of those is refused
	 * by policy. Answering "source file not found" then sends someone hunting for a file that
	 * is sitting right there, so a refusal says it is a refusal. It discloses nothing: the
	 * verdict comes from the path and the funnel's posture, never from the disk, and it is
	 * the answer for an out-of-bounds path whether or not that path exists.
	 */
	function previewRefusal(filePath: string): { status: number; error: string } {
		const mode = readExposeMode()
		if (isAllowedPreviewPath(path.resolve(filePath), cfg.workspacesRoot, os.homedir(), mode, BUNDLED_SKILLS_ROOT)) {
			return { status: 404, error: 'source file not found' }
		}
		return {
			status: 403,
			error:
				mode === 'public'
					? 'this relay is reachable from the internet, so it previews files inside Conductor workspaces only'
					: 'outside the files this relay may read'
		}
	}

	/** Hashed Vite assets are immutable and cache-forever; the shell/SW must never go stale. */
	function cacheControl(rel: string): string {
		if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'
		return 'no-cache'
	}

	function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
		const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
		const filePath = path.resolve(cfg.publicDir, rel)
		// Contain to publicDir. The URL parser already collapses `..`/`%2e%2e` dot-segments, but don't lean on
		// that: reject anything that resolves outside the dir (a bare `startsWith` would also admit a sibling
		// like `dist-node/`). An empty relative (filePath === publicDir) falls through to the SPA shell below.
		const within = path.relative(cfg.publicDir, filePath)
		if (within.startsWith('..') || path.isAbsolute(within)) {
			res.writeHead(403).end()
			return
		}
		fs.readFile(filePath, (err, data) => {
			if (err) {
				// SPA fallback to shell.
				fs.readFile(path.join(cfg.publicDir, 'index.html'), (e2, shell) => {
					if (e2) return void res.writeHead(404).end('not found')
					res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
					res.end(shell)
				})
				return
			}
			const ext = path.extname(filePath)
			res.writeHead(200, {
				'content-type': MIME[ext] ?? 'application/octet-stream',
				'cache-control': cacheControl(rel)
			})
			res.end(data)
		})
	}
	return { serveStatic, serveLocalImage, serveFilePreview }
}
export type FilesServices = ReturnType<typeof createFilesServices>
