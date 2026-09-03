/**
 * Files picked before a new workspace exists.
 *
 * Conductor's attachment files belong inside a worktree, but its deep link creates
 * that worktree after the phone has supplied the first prompt. Keep the bytes in the
 * relay state directory for that gap. The first-prompt queue moves them into the
 * worktree before it can send the token that refers to them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ATTACHMENT_DIR, attachmentName, attachmentToken, writeAttachment } from './attachments.ts'

const STAGE_ID = /^[A-Za-z0-9]{6}$/

export interface StagedAttachment {
	stageId: string
	name: string
	path: string
	bytes: number
	token: string
}

function attachmentDirectory(root: string, stageId: string): string | null {
	if (!STAGE_ID.test(stageId)) return null
	return path.join(root, ATTACHMENT_DIR, stageId)
}

/** Write a phone file outside a worktree until the new workspace has one. */
export function stageAttachment(root: string, name: string, body: Uint8Array): StagedAttachment {
	const written = writeAttachment(root, name, body)
	return { stageId: written.id, name: written.name, path: written.relPath, bytes: written.bytes, token: written.token }
}

/**
 * Read staged files back from disk. The directory is the authority, so a relay restart
 * between selecting files and creating the workspace keeps the files usable.
 */
export function stagedAttachments(root: string, stageIds: string[]): StagedAttachment[] | null {
	if (new Set(stageIds).size !== stageIds.length) return null
	const staged: StagedAttachment[] = []
	for (const stageId of stageIds) {
		const dir = attachmentDirectory(root, stageId)
		if (!dir) return null
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return null
		}
		const files = entries.filter(entry => entry.isFile())
		if (files.length !== 1 || files[0].name !== attachmentName(files[0].name)) return null
		const file = files[0]
		try {
			const info = fs.statSync(path.join(dir, file.name))
			if (!info.isFile()) return null
			const relPath = path.join(ATTACHMENT_DIR, stageId, file.name)
			staged.push({
				stageId,
				name: file.name,
				path: relPath,
				bytes: info.size,
				token: attachmentToken(file.name, relPath)
			})
		} catch {
			return null
		}
	}
	return staged
}

/** Copy every staged file to its token path. The queue removes the staged copies after it persists this step. */
export function materializeStagedAttachments(root: string, worktree: string, stageIds: string[]): void {
	const staged = stagedAttachments(root, stageIds)
	if (!staged) throw new Error('an attached file is no longer available')
	for (const attachment of staged) {
		const source = path.join(root, attachment.path)
		const destination = path.join(worktree, attachment.path)
		fs.mkdirSync(path.dirname(destination), { recursive: true })
		try {
			fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
		} catch (err) {
			if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err
			// A relay restart can resume midway through a multi-file copy. An identical file
			// is the successful half of that earlier run, not a collision to overwrite.
			const sourceBytes = fs.readFileSync(source)
			const destinationBytes = fs.readFileSync(destination)
			if (!sourceBytes.equals(destinationBytes)) throw new Error(`an attachment already exists at ${attachment.path}`)
		}
	}
}

/** Discard an upload that was cancelled before any synced draft could reference it. */
export function discardStagedAttachment(root: string, stageId: string): boolean {
	const dir = attachmentDirectory(root, stageId)
	if (!dir || !fs.existsSync(dir)) return false
	fs.rmSync(dir, { recursive: true, force: true })
	return true
}

/**
 * Remove abandoned New Workspace uploads without touching a draft or delivery queue
 * that still names one. Age is measured on the six-character directory, and only
 * directories matching that exact shape are eligible — a corrupt or hand-added path
 * is evidence to leave alone, not permission to recurse through it.
 */
export function pruneStagedAttachments(
	root: string,
	referenced: ReadonlySet<string>,
	maxAgeMs: number,
	now = Date.now()
): number {
	const base = path.join(root, ATTACHMENT_DIR)
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(base, { withFileTypes: true })
	} catch {
		return 0
	}
	let removed = 0
	for (const entry of entries) {
		if (!entry.isDirectory() || !STAGE_ID.test(entry.name) || referenced.has(entry.name)) continue
		const directory = attachmentDirectory(root, entry.name)
		if (!directory) continue
		try {
			if (now - fs.statSync(directory).mtimeMs < maxAgeMs) continue
			fs.rmSync(directory, { recursive: true, force: true })
			removed += 1
		} catch {
			// Cleanup is best-effort. A file being changed or removed concurrently is not
			// a reason to fail the relay or touch a broader path.
		}
	}
	return removed
}
