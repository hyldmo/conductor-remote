import fs from 'node:fs'

import { routeParam, routes } from '../../routes.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createFilesRoutes(
	services: Pick<RelayServices, 'reads' | 'json' | 'serveLocalImage' | 'serveFilePreview'>
): RouteHandler {
	const { reads, json, serveLocalImage, serveFilePreview } = services
	return async (req, res, url) => {
		const { pathname } = url

		// GET /api/repos/:name/icon — the repo's resolved sidebar icon (see src/files/icons.ts)
		const repo = routeParam(routes.repoIcon, req.method, pathname)

		if (repo) {
			const icon = reads.resolveRepoIcon(repo)
			if (!icon) return json(req, res, 404, { error: 'no icon' })
			return void fs.readFile(icon.path, (err, data) => {
				if (err) return void json(req, res, 404, { error: 'no icon' })
				// Cache briefly on the phone; the resolver itself refreshes within ~30s of an icon change.
				res.writeHead(200, { 'content-type': icon.contentType, 'cache-control': 'public, max-age=300' })
				res.end(data)
			})
		}

		// GET /api/local-images/:path — local images linked from agent Markdown. The browser fetches this
		// with its Authorization header and turns the reply into an object URL (web/src/components/transcript/Markdown.tsx), so the secret
		// stays out of the image URL. `serveLocalImage` limits reads to temp files and permitted workspace paths.
		const localImage = routeParam(routes.localImage, req.method, pathname)

		if (localImage) return serveLocalImage(req, res, localImage)

		// GET /api/tool-images/:reference — a screenshot or other image a tool returned. Held
		// back from the transcript itself (~100 kB of base64 each) and fetched only for a step
		// the reader opened, with the phone's auth header, like every other image route here.
		const toolImageRef = routeParam(routes.toolImage, req.method, pathname)

		if (toolImageRef) {
			const image = reads.toolImage(toolImageRef)
			if (!image) return json(req, res, 404, { error: 'image not found' })
			const bytes = Buffer.from(image.data, 'base64')
			// Immutable: a transcript row is written once, so the reference names one picture
			// forever and re-opening the step costs nothing.
			res.writeHead(200, {
				'content-type': image.mediaType,
				'content-length': String(bytes.length),
				'cache-control': 'private, max-age=86400, immutable'
			})
			return void res.end(bytes)
		}

		// GET /api/files/:reference — source linked from an agent reply. The Markdown component
		// intercepts the browser navigation and fetches this endpoint with its auth header.
		const fileReference = routeParam(routes.filePreview, req.method, pathname)

		if (fileReference) return serveFilePreview(req, res, fileReference)
		return NOT_HANDLED
	}
}
