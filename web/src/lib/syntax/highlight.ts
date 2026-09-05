import type { Element, ElementContent, RootContent } from 'hast'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'

/**
 * Syntax colouring for the places the phone shows code: Bash commands, Read outputs,
 * source previews, and fenced blocks inside chat messages.
 *
 * The languages are registered one by one rather than taken as a set, because every
 * one of them is bytes the phone re-downloads on each release (the service worker
 * precaches the whole bundle). Measured, gzipped, against the app's own 254 kB:
 * these eleven cost 22.8 kB, highlight.js's full set costs 313 kB and Shiki's
 * smallest useful build costs 113 kB. The list covers what `SOURCE_EXTENSIONS`
 * (src/shared.ts) actually accepts and what this Mac's repos hold; anything else
 * renders as it does today, plain, so an unregistered language is a missing colour
 * rather than a missing file.
 *
 * `lowlight` is highlight.js with a hast tree instead of an HTML string, and the tree
 * is what makes `highlightLines` possible — see the note there.
 */
const low = createLowlight({
	bash,
	css,
	ini,
	javascript,
	json,
	markdown,
	python,
	sql,
	typescript,
	xml,
	yaml
})

/** Extension → registered language. Everything absent from here stays plain. */
const EXTENSION_LANGUAGES: Record<string, string> = {
	bash: 'bash',
	sh: 'bash',
	zsh: 'bash',
	css: 'css',
	scss: 'css',
	toml: 'ini',
	ini: 'ini',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	md: 'markdown',
	markdown: 'markdown',
	py: 'python',
	sql: 'sql',
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	html: 'xml',
	svg: 'xml',
	xml: 'xml',
	yaml: 'yaml',
	yml: 'yaml'
}

/** Fence info string → registered language, for the aliases people actually type. */
const FENCE_LANGUAGES: Record<string, string> = {
	...EXTENSION_LANGUAGES,
	shell: 'bash',
	console: 'bash',
	javascript: 'javascript',
	typescript: 'typescript',
	python: 'python',
	yaml: 'yaml',
	json: 'json',
	sql: 'sql'
}

/** The tools whose mono detail is code rather than a path, a pattern or a URL. */
const TOOL_LANGUAGES: Record<string, string> = { Bash: 'bash' }

export function languageForTool(tool: string | undefined): string | null {
	return (tool && TOOL_LANGUAGES[tool]) ?? null
}

export function languageForPath(filePath: string): string | null {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	if (dot < 1) return null
	return EXTENSION_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null
}

/** A Read result is source code in the language named by its path; other outputs stay plain. */
export function languageForToolOutput(tool: string | undefined, detail: string | undefined): string | null {
	return tool === 'Read' && detail ? languageForPath(detail) : null
}

/** react-markdown gives a fence its info string as `language-<name>` on the `code` element. */
export function languageForFence(className: string | undefined): string | null {
	const name = className?.match(/(?:^|\s)language-([\w+-]+)/)?.[1]
	return name ? (FENCE_LANGUAGES[name.toLowerCase()] ?? null) : null
}

/** Tokens for one block of code, or null when the language isn't registered. */
export function highlightCode(code: string, language: string | null): ElementContent[] | null {
	if (!language || !low.registered(language)) return null
	// A hast root may hold a doctype, which a highlighter never emits. Narrowing here
	// keeps the splitter and the renderer down to the two node types they handle.
	return low.highlight(language, code).children.filter(isElementContent)
}

function isElementContent(node: RootContent): node is ElementContent {
	return node.type === 'element' || node.type === 'text'
}

/**
 * The same tokens, cut into one array per line.
 *
 * A source preview draws its own line per row, for the number gutter and for the line
 * the agent pointed at, and a token routinely covers several lines: a block comment, a
 * template literal, a heredoc. Highlight.js hands back one span holding all four lines
 * of a comment, so splitting its output at "\n" cuts through the tag itself. Splitting
 * the *tree* instead re-opens the enclosing spans on each new line, which is the whole
 * reason this goes through lowlight rather than `hljs.highlight`.
 *
 * Empty lines come back as empty arrays and are never dropped. A line lost here shifts
 * every number below it, and the preview would still look perfectly reasonable.
 */
export function highlightLines(code: string, language: string | null): ElementContent[][] | null {
	const tokens = highlightCode(code, language)
	return tokens ? splitLines(tokens) : null
}

export function splitLines(nodes: ElementContent[]): ElementContent[][] {
	const lines: ElementContent[][] = [[]]
	for (const node of nodes) {
		const parts = splitNode(node)
		lines[lines.length - 1].push(...parts[0])
		for (let i = 1; i < parts.length; i++) lines.push(parts[i])
	}
	return lines
}

/** One node's contribution to each line it touches. An empty contribution stays empty. */
function splitNode(node: ElementContent): ElementContent[][] {
	if (node.type === 'text')
		return node.value.split('\n').map(part => (part ? [{ type: 'text', value: part } as ElementContent] : []))
	if (node.type !== 'element') return [[node]]
	const element: Element = node
	return splitLines(element.children).map(line => (line.length ? [{ ...element, children: line }] : []))
}
