import { createBundledHighlighter } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

/**
 * The source formats the relay can preview, expressed as the canonical language
 * names Pierre infers from filenames. A hand-sized registry keeps the published
 * build bounded; Vite puts each loader in the runtime-cached diff-syntax directory.
 */
export const bundledLanguages = {
	applescript: () => import('shiki/langs/applescript.mjs'),
	c: () => import('shiki/langs/c.mjs'),
	cpp: () => import('shiki/langs/cpp.mjs'),
	css: () => import('shiki/langs/css.mjs'),
	go: () => import('shiki/langs/go.mjs'),
	html: () => import('shiki/langs/html.mjs'),
	java: () => import('shiki/langs/java.mjs'),
	javascript: () => import('shiki/langs/javascript.mjs'),
	json: () => import('shiki/langs/json.mjs'),
	jsx: () => import('shiki/langs/jsx.mjs'),
	markdown: () => import('shiki/langs/markdown.mjs'),
	'objective-cpp': () => import('shiki/langs/objective-cpp.mjs'),
	php: () => import('shiki/langs/php.mjs'),
	python: () => import('shiki/langs/python.mjs'),
	ruby: () => import('shiki/langs/ruby.mjs'),
	rust: () => import('shiki/langs/rust.mjs'),
	scss: () => import('shiki/langs/scss.mjs'),
	sql: () => import('shiki/langs/sql.mjs'),
	swift: () => import('shiki/langs/swift.mjs'),
	toml: () => import('shiki/langs/toml.mjs'),
	tsx: () => import('shiki/langs/tsx.mjs'),
	typescript: () => import('shiki/langs/typescript.mjs'),
	xml: () => import('shiki/langs/xml.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	yml: () => import('shiki/langs/yml.mjs'),
	zsh: () => import('shiki/langs/zsh.mjs')
} as const

export const PIERRE_SYNTAX_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(bundledLanguages))

// This mirrors Shiki's fine-grained bundle factory. Pierre supplies its own
// engine and loads themes lazily, so the defaults are intentionally empty.
export const createHighlighter = createBundledHighlighter({
	langs: bundledLanguages,
	themes: {},
	engine: () => createJavaScriptRegexEngine()
})

export * from 'shiki/core'
export { createJavaScriptRegexEngine, createOnigurumaEngine }
