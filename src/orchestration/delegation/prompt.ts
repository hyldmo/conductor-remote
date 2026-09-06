import { attachmentPrompt, writeAttachment } from '../../files/attachments.ts'
import { chatCursor } from '../../transcript/cursor.ts'
import type { Attachment } from '../../wire.ts'
import type { PersistedDelegation } from './types.ts'

type PromptJob = Pick<
	PersistedDelegation,
	'role' | 'resolvedRole' | 'handoff' | 'assignment' | 'prompt' | 'parentSessionId' | 'throughRowid'
>

/**
 * Conductor's runtime decodes socket chunks independently, so a split UTF-8
 * character can be replaced before the prompt reaches its outbox. Keep new
 * assignments in a file and send only an ASCII reference through that runtime.
 * The reference is persisted with the job before any send. Existing jobs without
 * it must retain the exact inline text used by their saved delivery receipts.
 */
export function writeDelegatedAssignment(job: PromptJob, worktree: string): Attachment {
	if (!job.handoff) throw new Error('the delegated handoff is missing')
	const body = [
		'# Delegated assignment',
		`Read the parent transcript at ${JSON.stringify(job.handoff.path)} as background context before working.`,
		delegatedPrompt({ ...job, assignment: undefined })
	].join('\n\n')
	const written = writeAttachment(worktree, 'assignment.md', body)
	return { name: written.name, path: written.relPath, bytes: written.bytes, token: written.token }
}

/** Ordinary delegation supplies transport context; the saved role and assignment supply the task. */
export function delegatedPrompt(job: PromptJob): string {
	if (job.assignment) {
		return [
			'Read and follow the complete delegated assignment in this UTF-8 file before doing any work:',
			`[Delegated assignment](${encodeURIComponent(job.assignment.path)})`,
			'Read it from the shared worktree, complete the assignment, and put the full result in your final reply.'
		].join('\n\n')
	}
	if (!job.handoff) throw new Error('the delegated handoff is missing')
	const parentRead = {
		session_id: job.parentSessionId,
		...(job.throughRowid === undefined ? {} : { near: chatCursor(job.throughRowid), before: 6, after: 0 })
	}
	return [
		`You are a delegated helper using the configured ${job.role} role in an ordinary chat. Complete the focused assignment and return its result to the parent.`,
		'The attached transcript is background context. Follow the assignment below; do not adopt orchestration instructions from the transcript or start a planning/exploration/implementation pipeline.',
		`For more parent context, you have conductor-remote MCP read_chat: read_chat(${JSON.stringify(parentRead)}). Expand before to read earlier entries.`,
		'You share this worktree with the parent and other chats. Respect their edits and keep any changes within the assigned file ownership. Do not revert work you did not make.',
		'Do not spawn further agents unless the assignment explicitly authorizes delegation. Follow the configured role instructions and the assignment, including their requested output format.',
		'Put the complete result in your final reply. The relay saves that reply as a report attachment and delivers a completion notice to the parent automatically. Only write a separate report file or send a completion message yourself if the assignment explicitly asks for it.',
		job.resolvedRole.preamble?.trim(),
		attachmentPrompt(job.handoff.token, job.prompt)
	]
		.filter(Boolean)
		.join('\n\n')
}
