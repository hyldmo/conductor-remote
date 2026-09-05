import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { attachmentName, attachmentPrompt, attachmentToken, writeAttachment } from '../../src/files/attachments.ts'
import {
	discardStagedAttachment,
	materializeStagedAttachments,
	pruneStagedAttachments,
	stageAttachment,
	stagedAttachments
} from '../../src/files/staged-attachments.ts'
import { attachmentTokens } from '../../src/shared.ts'

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-attachments-'))
	temporaryDirectories.push(root)
	return root
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('attachment tokens', () => {
	test('matches the exact token syntax Conductor stores', () => {
		expect(attachmentToken('image.png', '.context/attachments/jOTeCX/image.png')).toBe(
			'@⟦image.png⟧(.context%2Fattachments%2FjOTeCX%2Fimage.png)'
		)
		expect(
			attachmentToken('Transcript of Approve plan.md', '.context/attachments/kuB8pt/Transcript of Approve plan.md')
		).toBe('@⟦Transcript of Approve plan.md⟧(.context%2Fattachments%2FkuB8pt%2FTranscript%20of%20Approve%20plan.md)')
	})

	test('parses a complete token when its filename contains parentheses', () => {
		const token = '@⟦diagram (old).png⟧(.context%2Fattachments%2FjOTeCX%2Fdiagram%20(old).png)'
		expect(attachmentTokens(token)).toEqual([
			{
				start: 0,
				end: token.length,
				name: 'diagram (old).png',
				path: '.context/attachments/jOTeCX/diagram (old).png'
			}
		])
		expect(attachmentTokens('@⟦file.md⟧(example.md)')).toEqual([])
	})

	test('builds a fork prompt with one source token and optional direction', () => {
		const token = attachmentToken(
			'Transcript of Approve plan.md',
			'.context/attachments/kuB8pt/Transcript of Approve plan.md'
		)
		const prompt = attachmentPrompt(token, 'Continue from this transcript.')
		expect(prompt.match(/\.context%2Fattachments%2FkuB8pt/g)).toHaveLength(1)
		expect(prompt).toMatch(/^Forked from /)
		expect(prompt).toMatch(/Continue from this transcript\.$/)
		expect(attachmentPrompt(token)).toMatch(/\n\n$/)
	})
})

describe('attachment names', () => {
	test('preserves a plain safe name', () => {
		expect(attachmentName('Transcript of Select product colors.md')).toBe('Transcript of Select product colors.md')
	})

	test('removes path traversal and always returns a usable name', () => {
		expect(attachmentName('a/b\\c')).not.toMatch(/[/\\]/)
		expect(attachmentName('../../etc/passwd')).not.toMatch(/^\./)
		expect(attachmentName('...')).toBe('attachment')
	})

	test.each(['x'.repeat(400), '😀'.repeat(400)])('limits %s to 120 UTF-8 bytes', title => {
		expect(Buffer.byteLength(attachmentName(title))).toBeLessThanOrEqual(120)
	})
})

describe('attachment storage', () => {
	test('writes text and binary attachments inside unique worktree directories', () => {
		const root = temporaryRoot()
		const written = writeAttachment(root, 'Transcript of Select product colors.md', '# hi\n')
		expect(written.relPath).toMatch(/^\.context[/\\]attachments[/\\][A-Za-z0-9]{6}[/\\]/)
		expect(fs.readFileSync(path.join(root, written.relPath), 'utf8')).toBe('# hi\n')
		expect(written.token).toBe(attachmentToken(written.name, written.relPath))

		const evil = writeAttachment(root, '../../../../tmp/pwned.md', 'x')
		expect(path.resolve(evil.absPath).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true)

		const second = writeAttachment(root, 'Transcript of Select product colors.md', '# other\n')
		expect(fs.readFileSync(written.absPath, 'utf8')).toBe('# hi\n')
		expect(path.dirname(second.absPath)).not.toBe(path.dirname(written.absPath))

		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
		const image = writeAttachment(root, 'image.png', bytes)
		expect(fs.readFileSync(image.absPath)).toEqual(bytes)
	})

	test('stages, materializes, and discards an attachment', () => {
		const root = temporaryRoot()
		const staging = path.join(root, 'staging')
		const worktree = path.join(root, 'worktree')
		const staged = stageAttachment(staging, 'ship plans (final).md', Buffer.from('# Power circuits\n'))

		expect(staged.token).toBe(attachmentToken(staged.name, staged.path))
		expect(stagedAttachments(staging, [staged.stageId])?.[0]?.name).toBe(staged.name)
		materializeStagedAttachments(staging, worktree, [staged.stageId])
		expect(fs.readFileSync(path.join(worktree, staged.path), 'utf8')).toBe('# Power circuits\n')
		expect(stagedAttachments(staging, [staged.stageId])).not.toBeNull()

		discardStagedAttachment(staging, staged.stageId)
		expect(stagedAttachments(staging, [staged.stageId])).toBeNull()
	})

	test('prunes only old unreferenced staging directories', () => {
		const root = temporaryRoot()
		const staging = path.join(root, 'staging')
		const old = stageAttachment(staging, 'old.txt', Buffer.from('old'))
		const kept = stageAttachment(staging, 'kept.txt', Buffer.from('kept'))
		const recent = stageAttachment(staging, 'recent.txt', Buffer.from('recent'))
		const now = Date.now()
		for (const attachment of [old, kept]) {
			const directory = path.dirname(path.join(staging, attachment.path))
			fs.utimesSync(directory, new Date(now - 10_000), new Date(now - 10_000))
		}

		expect(pruneStagedAttachments(staging, new Set([kept.stageId]), 5_000, now)).toBe(1)
		expect(stagedAttachments(staging, [old.stageId])).toBeNull()
		expect(stagedAttachments(staging, [kept.stageId])).not.toBeNull()
		expect(stagedAttachments(staging, [recent.stageId])).not.toBeNull()
	})
})
