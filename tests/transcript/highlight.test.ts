import type { ElementContent } from 'hast'
import { describe, expect, test } from 'vitest'
import {
	highlightCode,
	highlightLines,
	languageForFence,
	languageForPath,
	languageForTool,
	languageForToolOutput
} from '../../web/src/lib/syntax/highlight.ts'

/**
 * The syntax highlighter's line splitter (web/src/lib/syntax/highlight.ts).
 *
 * The source preview draws one element per line, for the number gutter and for the
 * line an agent pointed at, and highlight.js hands back tokens that cover several
 * lines at once: a block comment, a template literal, a heredoc. So the tree has to
 * be cut at every newline and the enclosing spans re-opened on the next line, and
 * both ways of getting that wrong are silent. Drop a line and every number below it
 * names the wrong code, which still reads as a perfectly ordinary file. Drop the text
 * inside a token and the preview quietly shows less than the file holds.
 *
 * The properties pinned here are the two that cost something: the lines put the input
 * back together exactly, and a token spanning lines keeps its colour on each one.
 */
function textOf(nodes: ElementContent[]): string {
	return nodes
		.map(node => {
			if (node.type === 'text') return node.value
			if (node.type !== 'element') return ''
			return textOf(node.children)
		})
		.join('')
}

function classesOf(nodes: ElementContent[]): string[] {
	return nodes.flatMap(node => {
		if (node.type !== 'element') return []
		const own = node.properties?.className
		return [...(Array.isArray(own) ? own.map(String) : []), ...classesOf(node.children)]
	})
}

describe('highlightLines', () => {
	test('rebuilds the input exactly, line for line', () => {
		const code = [
			'/**',
			' * A block comment.',
			' * Two lines of it.',
			' */',
			'const query = `select *',
			'  from t`',
			'',
			'export const n = 1',
			''
		].join('\n')
		const lines = highlightLines(code, 'typescript')
		expect(lines).not.toBeNull()
		expect(lines?.length).toBe(code.split('\n').length)
		expect(lines?.map(textOf).join('\n')).toBe(code)
	})

	test('re-opens a token that covers several lines', () => {
		const lines = highlightLines('/*\n one\n two\n*/', 'typescript')
		expect(lines?.length).toBe(4)
		for (const line of lines ?? []) expect(classesOf(line)).toContain('hljs-comment')
	})

	test('keeps blank lines, so the gutter stays in step', () => {
		const code = 'echo one\n\n\necho two'
		const lines = highlightLines(code, 'bash')
		expect(lines?.length).toBe(4)
		expect(lines?.[1]).toEqual([])
		expect(lines?.[2]).toEqual([])
		expect(lines?.map(textOf)).toEqual(['echo one', '', '', 'echo two'])
	})

	test('a trailing newline is its own empty line, not a lost one', () => {
		const lines = highlightLines('echo one\n', 'bash')
		expect(lines?.length).toBe(2)
		expect(lines?.map(textOf).join('\n')).toBe('echo one\n')
	})

	test('an unregistered language colours nothing rather than throwing', () => {
		expect(highlightLines('SELECT 1', 'brainfuck')).toBeNull()
		expect(highlightCode('SELECT 1', null)).toBeNull()
	})
})

describe('language resolution', () => {
	test('reads a file extension, and only a known one', () => {
		expect(languageForPath('src/writes.ts')).toBe('typescript')
		expect(languageForPath('/Users/me/repo/web/src/app.tsx')).toBe('typescript')
		expect(languageForPath('scripts/deploy.sh')).toBe('bash')
		expect(languageForPath('src/conductor.applescript')).toBeNull()
		expect(languageForPath('Makefile')).toBeNull()
		expect(languageForPath('.gitignore')).toBeNull()
	})

	test('reads a fence info string through its aliases', () => {
		expect(languageForFence('language-ts')).toBe('typescript')
		expect(languageForFence('lang language-shell')).toBe('bash')
		expect(languageForFence('language-TSX')).toBe('typescript')
		expect(languageForFence('language-rust')).toBeNull()
		expect(languageForFence(undefined)).toBeNull()
	})

	test('only a tool whose detail is code gets a language', () => {
		expect(languageForTool('Bash')).toBe('bash')
		expect(languageForTool('Read')).toBeNull()
		expect(languageForTool('Grep')).toBeNull()
		expect(languageForTool(undefined)).toBeNull()
	})

	test('a Read output gets the language of its file path', () => {
		expect(languageForToolOutput('Read', 'src/writes.ts')).toBe('typescript')
		expect(languageForToolOutput('Read', '/Users/me/repo/styles/main.css')).toBe('css')
		expect(languageForToolOutput('Read', 'Makefile')).toBeNull()
		expect(languageForToolOutput('Grep', 'src/writes.ts')).toBeNull()
		expect(languageForToolOutput(undefined, 'src/writes.ts')).toBeNull()
	})
})
