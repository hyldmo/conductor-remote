/**
 * Guard the one boundary that lets the relay and the PWA share types: what the web
 * app is allowed to import from `src/`.
 *
 * `src/` and `web/src/` are one TypeScript project, so `web/src/lib/types.ts` can
 * re-export `src/wire.ts` and the phone gets the relay's real shapes instead of a
 * hand-written mirror. That works because `verbatimModuleSyntax` erases a type-only
 * import outright — the `node:sqlite` module next door is never emitted. A *value*
 * import from the same place drags Node builtins into a browser bundle.
 *
 * Two rules, and `tsc` enforces neither:
 *
 *   1. `web/src/**` may import from `src/` only with a **statement-level** `import
 *      type` / `export type`. The inline form is not good enough and this is the
 *      trap: `import { type Reads } from '../../src/reads/repository.ts'` emits
 *      `import {} from '…/reads/repository.ts'` under `verbatimModuleSyntax` — a real, side-
 *      effecting runtime import of Node-backed read helpers. It typechecks, it
 *      lints, and it reaches the phone as a blank screen.
 *   2. The value-importable modules — `src/shared.ts` and `src/routes.ts` — are the
 *      only exceptions, so each must stay worth being one: no `node:` import, in it or
 *      in anything it pulls in.
 *
 * `yarn build` might catch rule 1 as a Rollup warning about an externalised builtin,
 * on a good day, at the bottom of a wall of output. This says which line.
 *
 * Portable (no macOS, no relay), stdlib-only, strip-clean — see CLAUDE.md.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const webRoot = path.join(root, 'web', 'src')
const relayRoot = path.join(root, 'src')
/**
 * The modules `web/src` may import a *value* from. Two, and adding a third should be an
 * argument rather than an edit: each one is a promise that nothing under it ever reaches
 * for Node. `shared.ts` holds what both sides must compute identically; `routes.ts` holds
 * the `/api` paths both sides must agree on.
 */
const VALUE_MODULES = [path.join(relayRoot, 'shared.ts'), path.join(relayRoot, 'routes.ts')]

const failures: string[] = []
function check(label: string, pass: boolean, detail = ''): void {
	if (pass) console.info(`  ok    ${label}`)
	else {
		console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
		failures.push(label)
	}
}

function sources(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) out.push(...sources(full))
		else if (/\.tsx?$/.test(entry.name)) out.push(full)
	}
	return out
}

interface ImportRef {
	/** 1-based line the statement starts on. */
	line: number
	/** The module specifier, verbatim. */
	spec: string
	/** True only for `import type …` / `export type …`, which TypeScript erases whole. */
	typeOnly: boolean
}

/**
 * Every `import`/`export … from '…'` in a file. Deliberately a regex rather than a
 * parse: this runs under plain-node type-stripping with no dependencies, and the
 * shape it has to recognise is one line of syntax.
 */
function imports(text: string): ImportRef[] {
	const refs: ImportRef[] = []
	const re = /^[ \t]*(import|export)\s+(type\s+)?([^'"]*?)from\s*['"]([^'"]+)['"]/gm
	for (const m of text.matchAll(re)) {
		refs.push({
			line: text.slice(0, m.index).split('\n').length,
			spec: m[4],
			typeOnly: Boolean(m[2])
		})
	}
	// `import 'x'` and `import type X from 'x'` without braces are covered above or
	// have no specifier list; a bare side-effect import is caught here.
	for (const m of text.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)) {
		refs.push({ line: text.slice(0, m.index).split('\n').length, spec: m[1], typeOnly: false })
	}
	return refs
}

/** Resolve a relative specifier to a real file, tolerating the `.ts` extensions this repo requires. */
function resolveSpec(fromFile: string, spec: string): string | null {
	if (!spec.startsWith('.')) return null
	const base = path.resolve(path.dirname(fromFile), spec)
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
	}
	return base
}

const rel = (p: string): string => path.relative(root, p)

// ── rule 1: the web app may only `import type` from the relay ───────────────────

const offenders: string[] = []
for (const file of sources(webRoot)) {
	const text = fs.readFileSync(file, 'utf8')
	for (const ref of imports(text)) {
		const target = resolveSpec(file, ref.spec)
		if (!target?.startsWith(relayRoot + path.sep)) continue
		if (VALUE_MODULES.includes(target)) continue
		if (ref.typeOnly) continue
		offenders.push(`${rel(file)}:${ref.line} imports ${ref.spec} as a value`)
	}
}
check('web/src imports the relay type-only (the value modules aside)', offenders.length === 0, offenders.join('; '))

// ── rule 2: the value modules stay free of Node ─────────────────────────────────

for (const mod of VALUE_MODULES) check(`${rel(mod)} exists`, fs.existsSync(mod))

const seen = new Set<string>()
const nodeUsers: string[] = []
const queue = [...VALUE_MODULES]
while (queue.length) {
	const file = queue.shift() as string
	if (seen.has(file) || !fs.existsSync(file)) continue
	seen.add(file)
	const text = fs.readFileSync(file, 'utf8')
	for (const ref of imports(text)) {
		// A type-only import of a Node type is erased, so it can't break the bundle.
		if (ref.spec.startsWith('node:')) {
			if (!ref.typeOnly) nodeUsers.push(`${rel(file)}:${ref.line} imports ${ref.spec}`)
			continue
		}
		const target = resolveSpec(file, ref.spec)
		if (target) queue.push(target)
	}
}
check('the value modules pull in no node: builtin', nodeUsers.length === 0, nodeUsers.join('; '))

// ── rule 3: the wire contract has no runtime half ───────────────────────────────
// `src/wire.ts` says it holds no runtime code, and the whole reason a type may live
// beside the `node:sqlite` that produces it is that nothing there is emitted. Rule 1
// already stops `export *` from replacing the `export type *` in web/src/lib/types.ts;
// this keeps the file itself honest, so that stays a safe thing to re-export.

const wire = path.join(relayRoot, 'wire.ts')
const wireText = fs.existsSync(wire) ? fs.readFileSync(wire, 'utf8') : ''
const wireValues = wireText
	.split('\n')
	.map((l, n) => ({ l, n: n + 1 }))
	.filter(({ l }) => /^export\s+(?!type\b|interface\b)/.test(l))
	.map(({ l, n }) => `${rel(wire)}:${n} ${l.trim()}`)
check('src/wire.ts declares types only', wireValues.length === 0, wireValues.join('; '))

if (failures.length) {
	console.error(`imports: ${failures.length} rule(s) broken`)
	process.exit(1)
}
console.info('imports: relay/web boundary ok')
