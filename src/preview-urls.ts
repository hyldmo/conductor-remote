import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Workspace } from './reads.ts'

/** One entry in Conductor's repository/user `preview_urls` setting. */
export interface PreviewUrlSetting {
	name?: string
	url: string
}

/** A loopback HTTP preview the relay can put behind Tailscale Serve. */
export interface PreviewTarget {
	name: string
	port: number
	/** Path, query and fragment from the configured preview URL. */
	path: string
}

const MAX_PREVIEWS = 10

function validPort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= 65535
}

/** Remove a TOML comment without treating a `#` inside a quoted string as one. */
function withoutComment(line: string): string {
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 0; i < line.length; i++) {
		const char = line[i]
		if (quote === '"' && escaped) {
			escaped = false
			continue
		}
		if (quote === '"' && char === '\\') {
			escaped = true
			continue
		}
		if (quote) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") quote = char
		else if (char === '#') return line.slice(0, i)
	}
	return line
}

function tomlString(raw: string): string | null {
	const value = withoutComment(raw).trim()
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
	if (!(value.startsWith('"') && value.endsWith('"'))) return null
	try {
		return JSON.parse(value) as string
	} catch {
		return null
	}
}

function fields(text: string): Partial<PreviewUrlSetting> {
	const found: Partial<PreviewUrlSetting> = {}
	for (const line of text.split('\n')) {
		const match = withoutComment(line).match(/^\s*(name|url)\s*=\s*(.+?)\s*$/)
		if (!match) continue
		const value = tomlString(match[2])
		if (value !== null) found[match[1] as 'name' | 'url'] = value
	}
	return found
}

/**
 * Split an inline TOML table on top-level commas. Preview URL fields are strings,
 * so this deliberately implements only the small grammar the Conductor schema
 * permits instead of pulling a TOML runtime into the dependency-free relay.
 */
function inlineFields(text: string): Partial<PreviewUrlSetting> {
	const parts: string[] = []
	let start = 0
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (quote === '"' && escaped) {
			escaped = false
			continue
		}
		if (quote === '"' && char === '\\') {
			escaped = true
			continue
		}
		if (quote) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'") quote = char
		else if (char === ',') {
			parts.push(text.slice(start, i))
			start = i + 1
		}
	}
	parts.push(text.slice(start))
	return fields(parts.join('\n'))
}

/** Extract a balanced TOML array, ignoring brackets inside strings and comments. */
function arrayAt(text: string, start: number): { body: string; end: number } | null {
	let depth = 0
	let quote: '"' | "'" | null = null
	let escaped = false
	let comment = false
	for (let i = start; i < text.length; i++) {
		const char = text[i]
		if (comment) {
			if (char === '\n') comment = false
			continue
		}
		if (quote === '"' && escaped) {
			escaped = false
			continue
		}
		if (quote === '"' && char === '\\') {
			escaped = true
			continue
		}
		if (quote) {
			if (char === quote) quote = null
			continue
		}
		if (char === '#') comment = true
		else if (char === '"' || char === "'") quote = char
		else if (char === '[') depth++
		else if (char === ']' && --depth === 0) return { body: text.slice(start + 1, i), end: i + 1 }
	}
	return null
}

function inlineTables(body: string): Partial<PreviewUrlSetting>[] {
	const tables: Partial<PreviewUrlSetting>[] = []
	let quote: '"' | "'" | null = null
	let escaped = false
	let comment = false
	let start = -1
	for (let i = 0; i < body.length; i++) {
		const char = body[i]
		if (comment) {
			if (char === '\n') comment = false
			continue
		}
		if (quote === '"' && escaped) {
			escaped = false
			continue
		}
		if (quote === '"' && char === '\\') {
			escaped = true
			continue
		}
		if (quote) {
			if (char === quote) quote = null
			continue
		}
		if (char === '#') comment = true
		else if (char === '"' || char === "'") quote = char
		else if (char === '{') start = i + 1
		else if (char === '}' && start >= 0) {
			tables.push(inlineFields(body.slice(start, i)))
			start = -1
		}
	}
	return tables
}

/**
 * Read just Conductor's `preview_urls` setting from TOML. Conductor serializes
 * these as `[[preview_urls]]`; the inline-array form is accepted as well because
 * it is equally valid against the public schema. `null` means the layer did not
 * set the key, while `[]` is an explicit override.
 */
export function parsePreviewUrlsToml(text: string): PreviewUrlSetting[] | null {
	const tables: Partial<PreviewUrlSetting>[] = []
	let seen = false
	const headers = [...text.matchAll(/^\s*\[\[\s*preview_urls\s*\]\]\s*(?:#.*)?$/gm)]
	for (const [index, header] of headers.entries()) {
		seen = true
		const start = (header.index ?? 0) + header[0].length
		const nextHeader = text.slice(start).search(/^\s*\[{1,2}[^\n]+\]{1,2}\s*(?:#.*)?$/m)
		const end = nextHeader < 0 ? text.length : start + nextHeader
		tables.push(fields(text.slice(start, end)))
		if (index >= MAX_PREVIEWS - 1) break
	}

	// A root inline array has to appear before the first TOML table; after a table
	// header, an unqualified key belongs to that table rather than to the root.
	const firstTable = text.search(/^\s*\[/m)
	const root = firstTable < 0 ? text : text.slice(0, firstTable)
	const inline = root.match(/^\s*preview_urls\s*=\s*\[/m)
	if (inline?.index !== undefined) {
		seen = true
		const open = inline.index + inline[0].lastIndexOf('[')
		const array = arrayAt(root, open)
		if (array) tables.unshift(...inlineTables(array.body))
	}

	if (!seen) return null
	return tables
		.flatMap(entry => (typeof entry.url === 'string' ? [{ name: entry.name, url: entry.url }] : []))
		.slice(0, MAX_PREVIEWS)
}

interface CachedFile {
	mtimeMs: number
	size: number
	value: PreviewUrlSetting[] | null
}

const fileCache = new Map<string, CachedFile>()

function readLayer(file: string): PreviewUrlSetting[] | null {
	try {
		const stat = fs.statSync(file)
		const cached = fileCache.get(file)
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
		const value = parsePreviewUrlsToml(fs.readFileSync(file, 'utf8'))
		fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
		return value
	} catch {
		fileCache.delete(file)
		return null
	}
}

/** Resolve Conductor's user → repository → repository-local → managed precedence. */
export function previewUrlSettings(workspace: Workspace): PreviewUrlSetting[] {
	let resolved = readLayer(path.join(os.homedir(), '.conductor', 'settings.toml')) ?? []
	const shared = workspace.worktree
		? path.join(workspace.worktree, '.conductor', 'settings.toml')
		: workspace.repo_root
			? path.join(workspace.repo_root, '.conductor', 'settings.toml')
			: null
	if (shared) resolved = readLayer(shared) ?? resolved
	// Machine-local repository settings live in the main checkout and outrank the
	// shared file. A copied worktree-local file wins when one intentionally exists.
	for (const file of [
		workspace.repo_root ? path.join(workspace.repo_root, '.conductor', 'settings.local.toml') : null,
		workspace.worktree ? path.join(workspace.worktree, '.conductor', 'settings.local.toml') : null
	]) {
		if (!file) continue
		resolved = readLayer(file) ?? resolved
	}
	resolved = readLayer(path.join(os.homedir(), '.conductor', 'settings.managed.toml')) ?? resolved
	return resolved
}

/** Expand the supported Conductor template and retain only loopback HTTP servers. */
export function resolvePreviewTargets(settings: PreviewUrlSetting[], conductorPort: number | null): PreviewTarget[] {
	const targets: PreviewTarget[] = []
	const seen = new Set<string>()
	for (const setting of settings) {
		let value = setting.url
		if (/\$(?:CONDUCTOR_PORT\b|\{CONDUCTOR_PORT\})/.test(value)) {
			if (!conductorPort) continue
			value = value.replace(/\$(?:CONDUCTOR_PORT\b|\{CONDUCTOR_PORT\})/g, String(conductorPort))
		}
		// Other Conductor variables can describe paths, but forwarding an unresolved
		// template would point at a URL different from the one Conductor opens.
		if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value)) continue
		try {
			const url = new URL(value)
			if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) continue
			const port = Number(url.port || 80)
			if (!validPort(port)) continue
			const previewPath = `${url.pathname || '/'}${url.search}${url.hash}`
			const key = `${port}\0${previewPath}`
			if (seen.has(key)) continue
			seen.add(key)
			targets.push({ name: setting.name?.trim() || `Port ${port}`, port, path: previewPath })
			if (targets.length >= MAX_PREVIEWS) break
		} catch {
			// Invalid settings are already surfaced by Conductor's schema UI. They are
			// not a reason for the relay to guess at a different host or port.
		}
	}
	return targets
}
