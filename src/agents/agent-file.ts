/** Flat frontmatter only. Unknown blocks and Markdown are never parsed as YAML. */
import { z } from 'zod'
import { AGENT_EFFORTS, modelPickerLabel } from '../shared.ts'
import type { AgentDefinition, AgentsConfig } from '../wire.ts'

export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/
export const MAX_AGENTS = 32
const FRONTMATTER_KEYS = ['description', 'model', 'effort', 'fast', 'routing'] as const
type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number]
type Frontmatter = Pick<AgentDefinition, FrontmatterKey>

const agentSchema = z
	.object({
		name: z.string().regex(AGENT_NAME),
		description: z.string().max(1000).optional(),
		model: z.string().trim().min(1).max(256).transform(modelPickerLabel),
		effort: z.enum(AGENT_EFFORTS).optional(),
		fast: z.boolean().optional(),
		routing: z.boolean().optional(),
		preamble: z.string().max(50_000).optional()
	})
	.strict()
const agentsSchema = z.object({ version: z.literal(1), agents: z.array(agentSchema).max(MAX_AGENTS) }).strict()

export function decodeAgent(raw: unknown): AgentDefinition {
	return agentSchema.parse(raw)
}

export function decodeAgents(raw: unknown): AgentsConfig {
	const config = agentsSchema.parse(raw)
	if (new Set(config.agents.map(agent => agent.name)).size !== config.agents.length)
		throw new Error('Agent names must be unique.')
	return config
}

interface RawBlock {
	key?: string
	lines: string[]
}

export interface AgentFile {
	fields: Partial<Frontmatter>
	body: string
	/** Includes original line endings, comments and unrecognized syntax. */
	blocks: RawBlock[]
	opening: string
	closing: string
	newline: string
}

function lineText(line: string): string {
	return line.replace(/\r?\n$/, '')
}

function knownKey(key: string | undefined): key is FrontmatterKey {
	return FRONTMATTER_KEYS.some(known => known === key)
}

/** Quoted scalars accept YAML single-quote escaping and JSON double-quote escapes. */
function scalar(raw: string, key: string): string {
	const value = raw.trim()
	if (value.startsWith('"')) {
		const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(value)
		if (!match) throw new Error(`${key} has an invalid quoted scalar`)
		try {
			return JSON.parse(match[1]) as string
		} catch {
			throw new Error(`${key} has an invalid quoted scalar`)
		}
	}
	if (value.startsWith("'")) {
		const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value)
		if (!match) throw new Error(`${key} has an invalid quoted scalar`)
		return match[1].replaceAll("''", "'")
	}
	const bare = value.replace(/\s+#.*$/, '').trimEnd()
	if (/^(?:[|>&*!]|\[|\{)/.test(bare)) throw new Error(`${key} must be a flat scalar`)
	return bare
}

/** Parsing does not require a model: imports and body-only files can be patched first. */
export function parseAgentFile(source: string): AgentFile {
	const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const newline = source.includes('\r\n') ? '\r\n' : '\n'
	const file: AgentFile = { fields: {}, body: source, blocks: [], opening: '', closing: '', newline }
	const first = lines[0] ?? ''
	if (lineText(first) !== '---') return file
	const end = lines.findIndex((line, index) => index > 0 && lineText(line) === '---')
	if (end < 0) throw new Error('Frontmatter is missing its closing --- line')
	file.opening = first
	file.closing = lines[end]
	file.body = lines.slice(end + 1).join('')
	for (const line of lines.slice(1, end)) {
		const key = /^([^\s:#][^:]*):/.exec(lineText(line))?.[1]
		const previous = file.blocks.at(-1)
		// Blank lines and comments do not end a key's block. In particular, a
		// colon inside a comment must not detach the next indented continuation.
		if (!key && previous) previous.lines.push(line)
		else file.blocks.push({ key, lines: [line] })
	}
	const seen = new Set<string>()
	for (const block of file.blocks) {
		if (!knownKey(block.key)) continue
		const key = block.key
		if (seen.has(key)) throw new Error(`Duplicate ${key} frontmatter`)
		seen.add(key)
		if (block.lines.slice(1).some(line => /^[ \t]+\S/.test(line) && !line.trimStart().startsWith('#')))
			throw new Error(`${key} must be a flat scalar`)
		const value = scalar(lineText(block.lines[0]).slice(key.length + 1), key)
		if (key === 'fast' || key === 'routing') {
			if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`)
			file.fields[key] = value === 'true'
		} else if (key === 'effort') {
			file.fields.effort = z.enum(AGENT_EFFORTS).parse(value)
		} else file.fields[key] = value
	}
	return file
}

/** Only keys present in patch are touched; undefined removes one known key. */
export function serializeAgentFile(file: AgentFile, patch: Partial<Frontmatter> = {}, body = file.body): string {
	const remaining = new Set(FRONTMATTER_KEYS.filter(key => Object.hasOwn(patch, key)))
	const rendered: string[] = []
	for (const block of file.blocks) {
		const key = block.key
		if (!knownKey(key) || !remaining.has(key)) {
			rendered.push(...block.lines)
			continue
		}
		remaining.delete(key)
		if (patch[key] === file.fields[key]) {
			rendered.push(...block.lines)
			continue
		}
		if (patch[key] !== undefined) {
			const newline = block.lines[0].endsWith('\r\n') ? '\r\n' : '\n'
			rendered.push(`${key}: ${JSON.stringify(patch[key])}${newline}`)
		}
		// Keep comments, blank lines and other opaque syntax around the known line.
		rendered.push(...block.lines.slice(1))
	}
	for (const key of remaining) {
		if (patch[key] !== undefined) rendered.push(`${key}: ${JSON.stringify(patch[key])}${file.newline}`)
	}
	if (!file.opening && !rendered.length) return body
	const opening = file.opening || `---${file.newline}`
	let closing = file.closing || `---${file.newline}`
	if (body && !closing.endsWith('\n')) closing += file.newline
	return `${opening}${rendered.join('')}${closing}${body}`
}
