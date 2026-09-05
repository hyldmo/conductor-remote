/** Copy the manifest's complete AppleScript program beside its emitted loader. */
import fs from 'node:fs'
import path from 'node:path'
import { packageRoot } from '../src/pkg-root.ts'
import { conductorAppleScriptSources } from '../src/writes/applescript/source.ts'

const root = packageRoot(import.meta.dirname)
const outputRoot = path.join(root, 'dist-node')
const sources = conductorAppleScriptSources()
const copied = new Set<string>()

for (const source of sources) {
	const target = path.join(outputRoot, path.relative(root, source.file))
	fs.mkdirSync(path.dirname(target), { recursive: true })
	fs.copyFileSync(source.file, target)
	copied.add(target)
}

// Repeated builds must not leave renamed sections beside the current manifest.
// Only generated AppleScript assets are removed; emitted JavaScript stays intact.
const directory = path.join(outputRoot, 'src', 'writes', 'applescript')
for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith('.applescript')) continue
	const file = path.join(entry.parentPath, entry.name)
	if (!copied.has(file)) fs.rmSync(file)
}

// This was the build output before the source was divided into ordered parts.
fs.rmSync(path.join(outputRoot, 'src', 'conductor.applescript'), { force: true })
console.log(`applescript: copied ${sources.length} parts into dist-node/`)
