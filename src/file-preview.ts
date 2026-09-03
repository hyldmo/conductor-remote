import os from 'node:os'
import path from 'node:path'
import { isPreviewableImage, isPreviewableSource } from './shared.ts'

/** A source location as coding agents write it in Markdown: an absolute path, with an optional line or column. */
export interface FileReference {
	path: string
	line: number | null
}

/** True only for a descendant. A prefix test would let `/workspaces-old` escape `/workspaces`. */
function insideDirectory(filePath: string, root: string): boolean {
	const relative = path.relative(root, filePath)
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Public Funnel clients may preview source under Conductor's workspaces only.
 * A tailnet relay is limited to trusted devices, so it can also show project
 * notes and supporting files from the signed-in user's home directory.
 *
 * Call this only with real paths. That ensures a symlink cannot point outside
 * an allowed directory after this check.
 */
export function isAllowedPreviewPath(
	filePath: string,
	workspaceRoot: string,
	homeRoot: string,
	exposeMode: 'public' | 'tailnet',
	bundledSkillsRoot: string | null = null
): boolean {
	return (
		insideDirectory(filePath, workspaceRoot) ||
		(exposeMode === 'tailnet' &&
			(insideDirectory(filePath, homeRoot) ||
				(bundledSkillsRoot !== null && insideDirectory(filePath, bundledSkillsRoot))))
	)
}

/**
 * Parse a source link without treating ordinary PWA routes as file references.
 * The extension allowlist keeps links such as `/w/a-workspace` in the browser,
 * while also preventing this endpoint from becoming a generic file reader.
 *
 * `~/notes.md` is expanded here because that is how agents write a home path —
 * "plan written to `~/.gstack/plan.md`" — and the phone cannot expand it, having no
 * idea which account the relay runs as. Expanding it grants nothing: the result goes
 * through `isAllowedPreviewPath` like any other path, so a public relay still refuses
 * everything outside the workspaces root. Only `~/` counts, never `~someone/`.
 */
export function parseFileReference(reference: string): FileReference | null {
	const location = reference.match(/:([1-9]\d*)(?::\d+)?$/)
	const line = location ? Number(location[1]) : null
	if (line !== null && !Number.isSafeInteger(line)) return null

	const written = location ? reference.slice(0, -location[0].length) : reference
	const filePath = written.startsWith('~/') ? path.join(os.homedir(), written.slice(2)) : written
	if (!filePath.startsWith('/')) return null
	if (!isPreviewableSource(filePath)) return null
	return { path: filePath, line }
}

/** Parse an absolute image path supplied to the authenticated local-image route. */
export function parseImageReference(reference: string): string | null {
	const filePath = reference.startsWith('~/') ? path.join(os.homedir(), reference.slice(2)) : reference
	if (!path.isAbsolute(filePath) || !isPreviewableImage(filePath)) return null
	return filePath
}
