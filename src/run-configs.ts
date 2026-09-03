import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Workspace } from './reads.ts'

/** One visible, local Run choice from Conductor's effective settings. */
export interface DevRunConfig {
	id: string
	/** Conductor's display form: hyphens become spaces and words are capitalized. */
	name: string
}

interface RunConfigPatch {
	id: string
	command?: true
	hide?: boolean
	availableIn?: string[]
}

interface RunConfigLayer {
	kind: 'legacy' | 'named' | null
	configs: RunConfigPatch[]
}

interface CachedLayer {
	mtimeMs: number
	size: number
	value: RunConfigLayer | null
}

const fileCache = new Map<string, CachedLayer>()

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

/** Strip comments from a value that can span several physical TOML lines. */
function withoutComments(value: string): string {
	return value
		.split(/\r?\n/)
		.map(line => withoutComment(line))
		.join('\n')
}

function tomlString(raw: string): string | null {
	const value = withoutComment(raw).trim()
	if (value.startsWith("'") && value.endsWith("'") && !value.startsWith("'''")) return value.slice(1, -1)
	if (!(value.startsWith('"') && value.endsWith('"')) || value.startsWith('"""')) return null
	try {
		return JSON.parse(value) as string
	} catch {
		return null
	}
}

/** Split a TOML dotted key, retaining dots inside quoted components. */
function dottedKey(raw: string): string[] | null {
	const parts: string[] = []
	let start = 0
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]
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
		else if (char === '.') {
			parts.push(raw.slice(start, i))
			start = i + 1
		}
	}
	if (quote) return null
	parts.push(raw.slice(start))
	const decoded = parts.map(part => {
		const value = part.trim()
		if (!value) return null
		if (value.startsWith('"') || value.startsWith("'")) return tomlString(value)
		return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
	})
	return decoded.every((part): part is string => part !== null) ? decoded : null
}

function tablePath(line: string): string[] | null {
	const clean = withoutComment(line).trim()
	if (clean.startsWith('[[')) return null
	const match = clean.match(/^\[([^\]]+)]$/)
	return match ? dottedKey(match[1]) : null
}

function assignment(line: string): { key: string; value: string } | null {
	const clean = withoutComment(line)
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 0; i < clean.length; i++) {
		const char = clean[i]
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
		else if (char === '=') {
			const key = dottedKey(clean.slice(0, i))
			if (key?.length !== 1) return null
			return { key: key[0], value: clean.slice(i + 1).trim() }
		}
	}
	return null
}

function multilineDelimiter(value: string): '"""' | "'''" | null {
	const trimmed = value.trimStart()
	for (const delimiter of ['"""', "'''"] as const) {
		if (!trimmed.startsWith(delimiter)) continue
		return trimmed.indexOf(delimiter, delimiter.length) < 0 ? delimiter : null
	}
	return null
}

function stringValue(value: string): boolean {
	if (tomlString(value) !== null) return true
	const trimmed = withoutComments(value).trim()
	return (
		(trimmed.startsWith('"""') && trimmed.indexOf('"""', 3) >= 3) ||
		(trimmed.startsWith("'''") && trimmed.indexOf("'''", 3) >= 3)
	)
}

function arrayOpen(value: string): boolean {
	let depth = 0
	let quote: '"' | "'" | null = null
	let escaped = false
	for (const char of withoutComments(value)) {
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
		else if (char === '[') depth++
		else if (char === ']') depth--
	}
	return depth > 0
}

function stringList(raw: string): string[] | null {
	const scalar = tomlString(raw)
	if (scalar !== null) return [scalar]
	const value = withoutComments(raw).trim()
	if (!value.startsWith('[') || !value.endsWith(']')) return null
	const values: string[] = []
	let start = 1
	let quote: '"' | "'" | null = null
	let escaped = false
	for (let i = 1; i < value.length - 1; i++) {
		const char = value[i]
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
			const item = tomlString(value.slice(start, i))
			if (item === null) return null
			values.push(item)
			start = i + 1
		}
	}
	const tail = value.slice(start, -1).trim()
	if (tail) {
		const item = tomlString(tail)
		if (item === null) return null
		values.push(item)
	}
	return values
}

function displayName(id: string): string {
	return id
		.replace(/[-\s]+/g, ' ')
		.trim()
		.replace(/(^| )([a-z])/g, (_whole, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
}

function parseLayer(text: string): RunConfigLayer {
	const configs = new Map<string, RunConfigPatch>()
	let kind: RunConfigLayer['kind'] = null
	let section: string[] = []
	let multiline: '"""' | "'''" | null = null
	const lines = text.split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (multiline) {
			if (line.includes(multiline)) multiline = null
			continue
		}
		const header = tablePath(line)
		if (header) {
			section = header
			if (section.length === 3 && section[0] === 'scripts' && section[1] === 'run') {
				kind = 'named'
				const id = section[2]
				if (!configs.has(id)) configs.set(id, { id })
			}
			continue
		}
		const found = assignment(line)
		if (!found) continue
		multiline = multilineDelimiter(found.value)
		if (section.length === 1 && section[0] === 'scripts' && found.key === 'run') {
			if (stringValue(found.value) || multiline) kind = 'legacy'
			continue
		}
		if (section.length !== 3 || section[0] !== 'scripts' || section[1] !== 'run') continue
		const config = configs.get(section[2]) ?? { id: section[2] }
		configs.set(config.id, config)
		if (found.key === 'command' && (stringValue(found.value) || multiline)) config.command = true
		else if (found.key === 'hide' && /^(?:true|false)$/.test(found.value)) config.hide = found.value === 'true'
		else if (found.key === 'available_in') {
			let value = found.value
			while (arrayOpen(value) && i + 1 < lines.length) value += `\n${lines[++i]}`
			const available = stringList(value)
			if (available) config.availableIn = available
		}
	}
	return { kind, configs: [...configs.values()] }
}

function resolveLayers(layers: RunConfigLayer[]): DevRunConfig[] {
	let kind: RunConfigLayer['kind'] = null
	const resolved = new Map<string, RunConfigPatch>()
	for (const layer of layers) {
		if (layer.kind === 'legacy') {
			kind = 'legacy'
			resolved.clear()
			continue
		}
		if (layer.kind !== 'named') continue
		if (kind === 'legacy') resolved.clear()
		kind = 'named'
		for (const patch of layer.configs) {
			const previous = resolved.get(patch.id) ?? { id: patch.id }
			resolved.set(patch.id, { ...previous, ...patch })
		}
	}
	if (kind !== 'named') return []
	return [...resolved.values()].flatMap(config => {
		if (!config.command || config.hide || (config.availableIn && !config.availableIn.includes('local'))) return []
		return [{ id: config.id, name: displayName(config.id) }]
	})
}

/** Resolve lower-to-higher-priority TOML layers using Conductor's per-ID merge. */
export function resolveRunConfigs(layers: string[]): DevRunConfig[] {
	return resolveLayers(layers.map(parseLayer))
}

function readLayer(file: string): RunConfigLayer | null {
	try {
		const stat = fs.statSync(file)
		const cached = fileCache.get(file)
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
		const source = fs.readFileSync(file, 'utf8')
		const value = parseLayer(source)
		fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
		return value
	} catch {
		fileCache.delete(file)
		return null
	}
}

/** Read the same user -> shared -> local -> managed settings layers Conductor resolves. */
export function runConfigsFor(workspace: Workspace): DevRunConfig[] {
	const shared = workspace.worktree
		? path.join(workspace.worktree, '.conductor', 'settings.toml')
		: workspace.repo_root
			? path.join(workspace.repo_root, '.conductor', 'settings.toml')
			: null
	const files = [
		path.join(os.homedir(), '.conductor', 'settings.toml'),
		shared,
		workspace.repo_root ? path.join(workspace.repo_root, '.conductor', 'settings.local.toml') : null,
		workspace.worktree ? path.join(workspace.worktree, '.conductor', 'settings.local.toml') : null,
		path.join(os.homedir(), '.conductor', 'settings.managed.toml')
	]
	return resolveLayers(
		files.flatMap(file => (file ? [readLayer(file)].filter((layer): layer is RunConfigLayer => layer !== null) : []))
	)
}
