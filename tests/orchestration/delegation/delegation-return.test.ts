import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTools } from '../../../src/mcp/registry.ts'
import { delegationReturnAttachment, delegationReturnText } from '../../../src/orchestration/delegation/return.ts'
import { DelegationStore } from '../../../src/orchestration/delegation/store.ts'
import type { PersistedDelegation } from '../../../src/orchestration/delegation/types.ts'
import { attachmentTokens } from '../../../src/shared.ts'
import { chatCursor } from '../../../src/transcript/cursor.ts'
import type { TranscriptEntry } from '../../../src/wire.ts'

const temporaryDirs: string[] = []

function worktree(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-delegation-return-'))
	temporaryDirs.push(directory)
	return directory
}

function job(overrides: Partial<PersistedDelegation> = {}): PersistedDelegation {
	return {
		version: 1,
		id: 'job-1',
		workspaceId: 'workspace-1',
		parentSessionId: 'parent-1',
		childSessionId: 'child-1',
		role: 'exploration',
		resolvedRole: { model: '5.6 Terra', agentType: 'codex' },
		prompt: 'Inspect the queue.',
		returnMode: 'queue',
		includeThinking: true,
		status: 'returning',
		attempts: 0,
		createdAt: 100,
		updatedAt: 100,
		sentRowid: 20,
		completionRowid: 30,
		outcome: {
			kind: 'success',
			assistantRowid: 30,
			text: 'Keep the UI lock.\n\n## Baton\nThe receipt owns delivery.\n'
		},
		...overrides
	}
}

afterEach(() => {
	for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('delegated reports', () => {
	test.each([
		'Keep the UI lock.\n\n## Baton\nThe receipt owns delivery.\n',
		'{"changed":true,"file":"src/queue.ts"}\n',
		`Detailed findings:\n${'Preserve each receipt.\n'.repeat(10_000)}`
	])('preserves the full saved answer while sending only one attachment reference (%#)', finalReply => {
		const directory = worktree()
		new DelegationStore(directory).put(job({ outcome: { kind: 'success', assistantRowid: 30, text: finalReply } }))
		const saved = new DelegationStore(directory).get('job-1')!
		const attachment = delegationReturnAttachment(saved, directory)
		const report = fs.readFileSync(path.join(directory, attachment.path), 'utf8')
		const notice = delegationReturnText(saved, attachment)

		expect(report).toContain('Child chat: child-1')
		expect(report).toContain(`Completion cursor: ${chatCursor(30)}`)
		expect(report.slice(report.indexOf(finalReply))).toBe(finalReply)
		expect(report.split(finalReply)).toHaveLength(2)
		expect(attachment.bytes).toBe(Buffer.byteLength(report))
		expect(attachmentTokens(notice)).toMatchObject([{ path: attachment.path }])
		expect(notice).not.toContain(finalReply.trim())
		expect(notice.length).toBeLessThan(600)
	})

	test('the completion reference reads earlier investigation without picking up a later follow-up', async () => {
		const saved = job()
		const notice = delegationReturnText(saved, delegationReturnAttachment(saved, worktree()))
		const args = JSON.parse(notice.match(/read_chat\((\{[^\n]+\})\)/)![1])
		const entries: TranscriptEntry[] = [
			{ rowid: 21, role: 'thinking', text: 'Private investigation' },
			{ rowid: 22, role: 'assistant', text: 'Earlier evidence' },
			{ rowid: 30, role: 'assistant', text: saved.outcome!.text! },
			{ rowid: 40, role: 'user', text: 'Later question' },
			{ rowid: 50, role: 'assistant', text: 'Later answer' }
		].map(entry => ({ ...entry, id: `entry-${entry.rowid}`, ts: '2026-09-05', queued: false }) as TranscriptEntry)
		const read = createTools(async <T>(route: string) => {
			expect(route).toContain('/api/sessions/child-1/messages')
			return { entries, cursor: 50 } as T
		}).find(tool => tool.name === 'read_chat')!
		const output = await read.run(args)
		expect(args).toMatchObject({ session_id: 'child-1', near: chatCursor(30), after: 0 })
		expect(output).toContain('Earlier evidence')
		expect(output).toContain('Keep the UI lock.')
		expect(output).not.toMatch(/Private investigation|Later question|Later answer/)
	})

	test('keeps the failure reason and labels the last assistant reply as partial', () => {
		const directory = worktree()
		const saved = job({
			outcome: { kind: 'error', assistantRowid: 30, error: 'The agent stopped with an error.', text: 'Checking files…' }
		})
		const attachment = delegationReturnAttachment(saved, directory)
		const report = fs.readFileSync(path.join(directory, attachment.path), 'utf8')
		expect(report).toContain('Task failed: The agent stopped with an error.')
		expect(report).toContain('Last assistant message (partial)')
		expect(report).toContain('Checking files…')
		expect(delegationReturnText(saved, attachment)).toContain('failed.')
	})

	test('reports a vanished child without inventing a final-answer cursor', () => {
		const directory = worktree()
		const saved = job({ completionRowid: undefined, outcome: { kind: 'error', error: 'The child chat disappeared.' } })
		const attachment = delegationReturnAttachment(saved, directory)
		const report = fs.readFileSync(path.join(directory, attachment.path), 'utf8')
		expect(report).toContain('Task failed: The child chat disappeared.')
		expect(report).not.toContain('Completion cursor:')
		expect(delegationReturnText(saved, attachment)).not.toContain('"near"')
	})
})
