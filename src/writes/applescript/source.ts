import fs from 'node:fs'
import path from 'node:path'

/**
 * One AppleScript program, split only for editing. Order is intentional: runtime
 * loading, compile checking and package copying all consume this same manifest.
 * Parts retain their original whitespace; joining inserts no extra separators.
 */
const PARTS = [
	'window.applescript',
	'workspace-targeting.applescript',
	'chat-targeting.applescript',
	'composer.applescript',
	'run-tasks.applescript',
	'lifecycle.applescript',
	'agent-options.applescript',
	'workspace-status.applescript',
	'hotspot.applescript'
] as const

interface AppleScriptSource {
	file: string
	text: string
	/** One-based line in the concatenated program, for compiler diagnostics. */
	firstLine: number
}

/**
 * Assets are siblings of this module in both src/ and dist-node/src/. Validate
 * the directory too, so adding a section without listing it cannot silently
 * leave handlers out of a local run, repository check, or published package.
 */
export function conductorAppleScriptSources(): AppleScriptSource[] {
	const files = fs
		.readdirSync(import.meta.dirname, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith('.applescript'))
		.map(entry => path.relative(import.meta.dirname, path.join(entry.parentPath, entry.name)))
	const expected = new Set<string>(PARTS)
	const missing = PARTS.filter(file => !files.includes(file))
	const unlisted = files.filter(file => !expected.has(file))
	if (expected.size !== PARTS.length || missing.length || unlisted.length) {
		throw new Error(
			`AppleScript manifest mismatch: ${[
				...(expected.size !== PARTS.length ? ['duplicate parts'] : []),
				...(missing.length ? [`missing ${missing.join(', ')}`] : []),
				...(unlisted.length ? [`unlisted ${unlisted.join(', ')}`] : [])
			].join('; ')}`
		)
	}
	let firstLine = 1
	return PARTS.map(part => {
		const file = path.join(import.meta.dirname, part)
		const text = fs.readFileSync(file, 'utf8')
		const source = { file, text, firstLine }
		firstLine += text.split('\n').length - 1
		return source
	})
}

export function readConductorAppleScript(): string {
	return conductorAppleScriptSources()
		.map(source => source.text)
		.join('')
}
