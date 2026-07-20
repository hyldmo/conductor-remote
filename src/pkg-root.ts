import fs from 'node:fs'
import path from 'node:path'

/**
 * The package root — the directory holding package.json (and thus bin/ and the Vite dist/). Walk up from
 * `fromDir` because these modules run at two depths: src/ in a dev checkout (Node type-stripping) and
 * dist-node/src/ in the published tarball (compiled by tsconfig.build.json). Anchoring on the nearest
 * package.json resolves both to the same real root, and conductor-remote's own package.json is always the
 * first one found, so it never escapes into a parent node_modules.
 */
export function packageRoot(fromDir: string): string {
	let dir = fromDir
	for (;;) {
		if (fs.existsSync(path.join(dir, 'package.json'))) return dir
		const parent = path.dirname(dir)
		if (parent === dir) return fromDir
		dir = parent
	}
}
