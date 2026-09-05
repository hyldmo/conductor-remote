/**
 * The small, user-owned slice of Conductor's settings that the phone edits.
 *
 * These values do not live in conductor.db anymore. Conductor reads them from
 * `~/.conductor/settings.toml`, alongside settings this relay neither understands nor
 * owns. Updates are therefore surgical text edits: keep comments, ordering, review
 * defaults and future Conductor keys byte-for-byte, and replace only the requested
 * provider's default effort value.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type DefaultEffortProvider = 'claude' | 'codex'

export interface DefaultEfforts {
	claude: string | null
	codex: string | null
}

/** The normalized values Conductor's chat controls currently persist. */
export const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
export type DefaultEffortLevel = (typeof DEFAULT_EFFORT_LEVELS)[number]

const EFFORT_LEVELS = new Set<string>(DEFAULT_EFFORT_LEVELS)
const SETTINGS_SCHEMA = 'https://conductor.build/schemas/settings.schema.json'
const PROVIDERS: Record<DefaultEffortProvider, { section: string; key: string }> = {
	claude: { section: 'models.claude_code', key: 'default_effort_level' },
	codex: { section: 'models.codex', key: 'default_thinking_level' }
}

export function conductorSettingsPath(): string {
	return path.join(os.homedir(), '.conductor', 'settings.toml')
}

export function isDefaultEffortLevel(value: unknown): value is DefaultEffortLevel {
	return typeof value === 'string' && EFFORT_LEVELS.has(value)
}

/** Accept ordinary and quoted dotted table names without pretending to be a full TOML parser. */
function sectionName(line: string): string | null {
	const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)
	if (!match) return null
	return match[1]
		.split('.')
		.map(part => part.trim().replace(/^(["'])(.*)\1$/, '$2'))
		.join('.')
}

function assignment(line: string, key: string): { value: string; prefix: string; suffix: string } | null {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = line.match(
		new RegExp(`^(\\s*(?:${escaped}|["']${escaped}["'])\\s*=\\s*)(?:"([^"\\n]*)"|'([^'\\n]*)')(\\s*(?:#.*)?)$`)
	)
	if (!match) return null
	return { prefix: match[1], value: match[2] ?? match[3] ?? '', suffix: match[4] }
}

function readValue(source: string, section: string, key: string): string | null {
	let currentSection: string | null = null
	for (const line of source.split(/\r?\n/)) {
		currentSection = sectionName(line) ?? currentSection
		if (currentSection !== section) continue
		const found = assignment(line, key)
		if (found) return found.value
	}
	return null
}

export function readDefaultEfforts(file = conductorSettingsPath()): DefaultEfforts {
	let source = ''
	try {
		source = fs.readFileSync(file, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	return {
		claude: readValue(source, PROVIDERS.claude.section, PROVIDERS.claude.key),
		codex: readValue(source, PROVIDERS.codex.section, PROVIDERS.codex.key)
	}
}

function replaceValue(source: string, section: string, key: string, value: DefaultEffortLevel): string {
	const newline = source.includes('\r\n') ? '\r\n' : '\n'
	const hadTrailingNewline = source.endsWith('\n')
	const lines = source ? source.split(/\r?\n/) : []
	if (hadTrailingNewline) lines.pop()

	let sectionStart = -1
	let sectionEnd = lines.length
	for (let i = 0; i < lines.length; i++) {
		const found = sectionName(lines[i])
		if (found === section) {
			if (sectionStart >= 0) throw new Error(`duplicate [${section}] table in Conductor settings`)
			sectionStart = i
			continue
		}
		if (sectionStart >= 0 && found !== null) {
			sectionEnd = i
			break
		}
	}

	if (sectionStart >= 0) {
		for (let i = sectionStart + 1; i < sectionEnd; i++) {
			const found = assignment(lines[i], key)
			if (found) {
				lines[i] = `${found.prefix}"${value}"${found.suffix}`
				return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`
			}
			// A line that names our key but uses a shape we cannot preserve safely must fail
			// closed. Appending a duplicate key would make the entire TOML file invalid.
			if (new RegExp(`^\\s*(?:${key}|["']${key}["'])\\s*=`).test(lines[i])) {
				throw new Error(`could not safely update ${key} in Conductor settings`)
			}
		}

		let insertAt = sectionEnd
		while (insertAt > sectionStart + 1 && !lines[insertAt - 1].trim()) insertAt--
		lines.splice(insertAt, 0, `${key} = "${value}"`)
		return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`
	}

	const block = [`[${section}]`, `${key} = "${value}"`]
	if (!lines.length) lines.push(`"$schema" = "${SETTINGS_SCHEMA}"`)
	if (lines.length && lines.at(-1)?.trim()) lines.push('')
	lines.push(...block)
	return `${lines.join(newline)}${newline}`
}

function writableTarget(file: string): string {
	try {
		return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file
		throw error
	}
}

function writeAtomic(file: string, source: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	let mode = 0o600
	try {
		mode = fs.statSync(file).mode & 0o777
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const temp = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
	)
	try {
		fs.writeFileSync(temp, source, { encoding: 'utf8', flag: 'wx', mode })
		fs.renameSync(temp, file)
	} finally {
		try {
			fs.unlinkSync(temp)
		} catch {
			// Best-effort cleanup only. A temp-file error must not mask whether the real
			// settings write succeeded or failed.
		}
	}
}

/** Merge one or both provider defaults into the user TOML and return the persisted result. */
export function writeDefaultEfforts(
	patch: Partial<Record<DefaultEffortProvider, DefaultEffortLevel>>,
	file = conductorSettingsPath()
): DefaultEfforts {
	if (!Object.keys(patch).length) throw new Error('no default effort to update')
	const target = writableTarget(file)
	let source = ''
	try {
		source = fs.readFileSync(target, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	for (const provider of ['claude', 'codex'] as const) {
		const value = patch[provider]
		if (value === undefined) continue
		if (!isDefaultEffortLevel(value)) throw new Error(`unknown ${provider} default effort ${value}`)
		const setting = PROVIDERS[provider]
		source = replaceValue(source, setting.section, setting.key, value)
	}
	writeAtomic(target, source)
	return readDefaultEfforts(target)
}
