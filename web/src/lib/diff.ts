import type { DiffFile } from './types.ts'

export type DiffFileScope = 'changed' | 'all'

export interface DiffFileTreeFile {
	kind: 'file'
	name: string
	path: string
	file: DiffFile
}

export interface DiffFileTreeFolder {
	kind: 'folder'
	name: string
	path: string
	fileCount: number
	added: number
	removed: number
	children: DiffFileTreeNode[]
}

export type DiffFileTreeNode = DiffFileTreeFile | DiffFileTreeFolder

interface MutableDiffFileTreeFolder {
	name: string
	path: string
	fileCount: number
	added: number
	removed: number
	folders: Map<string, MutableDiffFileTreeFolder>
	files: DiffFileTreeFile[]
}

const treeNameOrder = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name)

const filePathOrder = (a: DiffFile, b: DiffFile) =>
	a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path)

/** Build the repository-shaped hierarchy shared by Changed and All files. */
export function buildDiffFileTree(files: readonly DiffFile[]): DiffFileTreeNode[] {
	const root: MutableDiffFileTreeFolder = {
		name: '',
		path: '',
		fileCount: 0,
		added: 0,
		removed: 0,
		folders: new Map(),
		files: []
	}

	for (const file of files) {
		const parts = file.path.split('/')
		const name = parts.pop() ?? file.path
		let parent = root

		for (const part of parts) {
			const path = parent.path ? `${parent.path}/${part}` : part
			let folder = parent.folders.get(part)
			if (!folder) {
				folder = {
					name: part,
					path,
					fileCount: 0,
					added: 0,
					removed: 0,
					folders: new Map(),
					files: []
				}
				parent.folders.set(part, folder)
			}
			folder.fileCount += 1
			folder.added += file.added
			folder.removed += file.removed
			parent = folder
		}

		parent.files.push({ kind: 'file', name, path: file.path, file })
	}

	const finish = (folder: MutableDiffFileTreeFolder): DiffFileTreeNode[] => [
		...[...folder.folders.values()].sort(treeNameOrder).map(
			(child): DiffFileTreeFolder => ({
				kind: 'folder',
				name: child.name,
				path: child.path,
				fileCount: child.fileCount,
				added: child.added,
				removed: child.removed,
				children: finish(child)
			})
		),
		...folder.files.sort(treeNameOrder)
	]

	return finish(root)
}

/** File order as it appears while every folder in the tree is expanded. */
export function filesInTreeOrder(files: readonly DiffFile[]): DiffFile[] {
	const ordered: DiffFile[] = []
	const visit = (nodes: readonly DiffFileTreeNode[]) => {
		for (const node of nodes) {
			if (node.kind === 'folder') visit(node.children)
			else ordered.push(node.file)
		}
	}
	visit(buildDiffFileTree(files))
	return ordered
}

/** Files as one ungrouped list, with full paths sorted naturally. */
export function filesInFlatOrder(files: readonly DiffFile[]): DiffFile[] {
	return [...files].sort(filePathOrder)
}

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
 * The workspace endpoint ships one ordinary unified patch. For a bounded response,
 * split only at Git's file headers — hunk contents cannot masquerade as one because
 * their lines are prefixed with + / - / space.
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

/** The patch section belonging to a selected changed-file row, or null if it is absent. */
export function patchForFile(patch: string, files: readonly DiffFile[], path: string): string | null {
	const index = files.findIndex(file => file.path === path)
	if (index < 0) return null
	return splitWorkspacePatch(patch)[index] ?? null
}

export interface PreparedPatch {
	/** A single-file unified patch that @pierre/diffs can parse. */
	patch: string
	/** Conductor's edit status, when it preceded a bare hunk. */
	preamble: string | null
}

/**
 * Conductor edit results contain only `@@` hunks, prefixed by a human status line.
 * Pierre deliberately accepts complete unified patches instead, so give those hunks
 * synthetic file headers while keeping the status available to render above them.
 */
export function preparePatch(patch: string, fileName?: string): PreparedPatch {
	const lines = patch.split('\n')
	const firstHunk = lines.findIndex(line => line.startsWith('@@ '))
	if (firstHunk < 0) return { patch, preamble: null }

	const headerIndex = lines
		.slice(0, firstHunk)
		.findIndex(line => line.startsWith('diff --git ') || line.startsWith('--- '))
	if (headerIndex >= 0) {
		const preamble = lines.slice(0, headerIndex).join('\n').trim()
		return {
			patch: lines.slice(headerIndex).join('\n'),
			preamble: preamble || null
		}
	}

	const preamble = lines.slice(0, firstHunk).join('\n').trim()
	const safeName = (fileName?.trim() || 'change.txt').replace(/[\t\r\n]/g, ' ')
	return {
		patch: [`--- ${safeName}`, `+++ ${safeName}`, ...lines.slice(firstHunk)].join('\n'),
		preamble: preamble || null
	}
}
