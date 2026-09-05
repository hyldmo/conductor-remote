import { isUtf8 } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { AgentImportScanResponse, ImportAgentsRequest } from '../wire.ts'
import { AGENT_NAME, decodeAgent, parseAgentFile } from './agent-file.ts'
import type { AgentStore } from './agent-store.ts'

export const MAX_IMPORT_FILES = 64
export const MAX_IMPORT_BYTES = 256 * 1024

const requestSchema = z
	.object({
		names: z.array(z.string().min(1).max(256)).min(1).max(MAX_IMPORT_FILES),
		overwrite: z.boolean().optional()
	})
	.strict()

export function decodeImportAgents(raw: unknown): ImportAgentsRequest {
	return requestSchema.parse(raw)
}

/** Resolve and open the same regular file, rejecting links and bounding even a growing file's read. */
function readCandidate(directory: string, filename: string): Buffer {
	const file = path.join(directory, filename)
	const resolved = fs.realpathSync(file)
	if (path.dirname(resolved) !== directory) throw new Error('Symlinks outside the agents directory are not imported.')
	const stat = fs.lstatSync(file)
	if (!stat.isFile()) throw new Error('Agent definitions must be regular files, not symlinks or directories.')
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
	try {
		const opened = fs.fstatSync(fd)
		if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
			throw new Error('The agent file changed while opening it. Refresh and try again.')
		if (opened.size > MAX_IMPORT_BYTES) throw new Error(`Agent files must be at most ${MAX_IMPORT_BYTES / 1024} KiB.`)
		const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1)
		let size = 0
		while (size < buffer.length) {
			const count = fs.readSync(fd, buffer, size, buffer.length - size, null)
			if (!count) break
			size += count
		}
		if (size > MAX_IMPORT_BYTES) throw new Error(`Agent files must be at most ${MAX_IMPORT_BYTES / 1024} KiB.`)
		return buffer.subarray(0, size)
	} finally {
		fs.closeSync(fd)
	}
}

/** No recursive/repository discovery. POST re-scans so a changed or rejected file is never copied blind. */
export function scanClaudeAgents(
	store: AgentStore,
	directory = path.join(os.homedir(), '.claude', 'agents')
): { response: AgentImportScanResponse; sources: Map<string, Buffer> } {
	const response: AgentImportScanResponse = { candidates: [], skipped: [], truncated: false, limit: MAX_IMPORT_FILES }
	const sources = new Map<string, Buffer>()
	let root: string
	try {
		root = fs.realpathSync(directory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { response, sources }
		throw error
	}
	const names = fs
		.readdirSync(root)
		.filter(name => name.endsWith('.md'))
		.sort()
	response.truncated = names.length > MAX_IMPORT_FILES
	const existing = new Set(store.names())
	for (const filename of names.slice(0, MAX_IMPORT_FILES)) {
		const name = filename.slice(0, -3)
		try {
			if (!AGENT_NAME.test(name))
				throw new Error(
					'Use a filename starting with a letter and up to 64 lowercase letters, numbers, dashes or underscores.'
				)
			const bytes = readCandidate(root, filename)
			if (!isUtf8(bytes)) throw new Error('Agent definitions must be valid UTF-8.')
			const parsed = parseAgentFile(bytes.toString('utf8'))
			const agent = decodeAgent({ name, ...parsed.fields, preamble: parsed.body })
			response.candidates.push({
				name,
				description: agent.description,
				model: parsed.fields.model!,
				hasBody: !!parsed.body.trim(),
				collision: existing.has(name)
			})
			sources.set(name, bytes)
		} catch (error) {
			response.skipped.push({ name, reason: error instanceof Error ? error.message : String(error) })
		}
	}
	return { response, sources }
}
