import type { DiffFile } from './types.ts'

export type DiffFileScope = 'changed' | 'all'

/** The rail entries for one scope. All-files rows retain diff counts when they have them. */
export function filesForScope(
	scope: DiffFileScope,
	changedFiles: readonly DiffFile[],
	workspaceFiles: readonly string[]
): readonly DiffFile[] {
	if (scope === 'changed') return changedFiles
	const changedByPath = new Map(changedFiles.map(file => [file.path, file]))
	return [...workspaceFiles].sort().map(path => changedByPath.get(path) ?? { path, added: 0, removed: 0 })
}

/**
 * The workspace endpoint ships one ordinary unified patch. The review UI presents it
 * one file at a time, so split only at git's file headers — hunk contents may contain
 * any other header-looking text once prefixed with + / - / space.
 */
export function splitWorkspacePatch(patch: string): string[] {
	if (!patch) return []
	const lines = patch.split('\n')
	const starts: number[] = []
	for (const [index, line] of lines.entries()) {
		if (line.startsWith('diff --git ')) starts.push(index)
	}
	// A workspace patch normally always carries `diff --git`, but retaining a lone
	// section makes the viewer useful against older relay responses too.
	if (!starts.length) return [patch]
	return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n'))
}

/** The patch section belonging to a selected changed-file row, or null if truncation omitted it. */
export function patchForFile(patch: string, files: readonly DiffFile[], path: string): string | null {
	const index = files.findIndex(file => file.path === path)
	if (index < 0) return null
	return splitWorkspacePatch(patch)[index] ?? null
}
