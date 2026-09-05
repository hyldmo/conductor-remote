/**
 * Conductor attachments, written from outside Conductor.
 *
 * An attachment is two things and, as of Conductor 0.76, only two things:
 *
 *   1. a file at `<worktree>/.context/attachments/<6 chars>/<name>`, and
 *   2. a token in the prompt text: `@⟦<name>⟧(<the path, percent-encoded>)`.
 *
 * There is no third thing, and that is what makes this safe to do here. `conductor.db`
 * *has* an `attachments` table, and it is dead in the same way `workspaces.unread` is:
 * 471 rows, last written 2026-05-19, none of them in the `<id>/<name>` layout every
 * attachment has used since. Verified against attachments made the same day this was
 * written — zero rows. So the relay produces a real attachment while keeping its DB
 * handle read-only, which is not a nicety here but the rule the whole design rests on.
 *
 * A token *written into the composer* is re-parsed, which was the one open question and
 * is now measured: a split sent this way reached the next agent as a real attachment,
 * carrying Conductor's own "The user has attached these files. Read them before
 * proceeding. - <path> (113.8 KB)" ahead of the prompt. The token is therefore the
 * single canonical attachment reference: repeating its path in prose renders a duplicate
 * link in Conductor's chat.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Where Conductor keeps them, relative to the worktree. */
export const ATTACHMENT_DIR = path.join('.context', 'attachments')

/**
 * Conductor's own ids are six mixed-case alphanumerics (`jOTeCX`, `Vyc35T`, `7qygLU`),
 * so this matches the shape rather than inventing one. Modulo bias is irrelevant: the
 * id names a directory, it guards nothing, and the caller retries on collision anyway.
 */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function attachmentId(): string {
	return Array.from(crypto.randomBytes(6), b => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}

/**
 * A file name that cannot leave the directory it was meant for.
 *
 * The name here is built from a chat title, which is free text written by a model, so
 * it can hold a slash as easily as a space. `path.join` would take one and quietly
 * write somewhere else in the worktree.
 */
export function attachmentName(name: string): string {
	const flat = name
		.replace(/[/\\]/g, '-')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must not reach a path
		.replace(/[\u0000-\u001f\u007f]/g, '')
		// A leading dot hides the file, and two of them climb out of the directory.
		.replace(/^\.+/, '')
		.trim()
	// 255 bytes is the filesystem's limit and a title can be long. Count bytes rather
	// than JS code units: 120 emoji fit the latter but not the former. The lower cap
	// leaves room for an extension and works on every filesystem Conductor supports.
	let clipped = ''
	for (const char of flat) {
		if (Buffer.byteLength(clipped + char) > 120) break
		clipped += char
	}
	return clipped.trim() || 'attachment'
}

/** The composer's own syntax for an attached file. `encodeURIComponent` matches it exactly, `/` included. */
export function attachmentToken(name: string, relPath: string): string {
	return `@⟦${name}⟧(${encodeURIComponent(relPath)})`
}

/** Compose a fork handoff, leaving an empty line for the user's added context when needed. */
export function attachmentPrompt(token: string, prompt?: string): string {
	const context = prompt?.trim()
	return context ? `Forked from ${token}\n\n${context}` : `Forked from ${token}\n\n`
}

export interface WrittenAttachment {
	/** The six-character directory id Conductor keeps out of the visible file name. */
	id: string
	/** The file name as the chip shows it. */
	name: string
	/** Worktree-relative, which is how the token spells it and how an agent should read it. */
	relPath: string
	absPath: string
	bytes: number
	/** The `@⟦…⟧(…)` token to drop into the prompt. */
	token: string
}

/**
 * Write one, and return everything a caller needs to reference it.
 *
 * Each attachment gets its own directory, exactly as Conductor does it, so two files
 * with the same name never collide and the id stays out of the visible name.
 */
export function writeAttachment(worktree: string, name: string, body: string | Uint8Array): WrittenAttachment {
	const safe = attachmentName(name)
	let id = attachmentId()
	let dir = path.join(worktree, ATTACHMENT_DIR, id)
	// Six characters from 62 makes this vanishingly unlikely; retrying is still cheaper
	// than overwriting an attachment somebody else is about to send.
	for (let i = 0; i < 5 && fs.existsSync(dir); i++) {
		id = attachmentId()
		dir = path.join(worktree, ATTACHMENT_DIR, id)
	}
	fs.mkdirSync(dir, { recursive: true })
	const absPath = path.join(dir, safe)
	fs.writeFileSync(absPath, body)
	const relPath = path.join(ATTACHMENT_DIR, id, safe)
	return { id, name: safe, relPath, absPath, bytes: Buffer.byteLength(body), token: attachmentToken(safe, relPath) }
}
