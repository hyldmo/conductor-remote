import { attachmentPrompt } from '../../files/attachments.ts'
import { chatCursor } from '../../transcript/cursor.ts'
import type { PersistedDelegation } from './types.ts'

/** Ordinary delegation supplies transport context; the saved role and assignment supply the task. */
export function delegatedPrompt(
	job: Pick<PersistedDelegation, 'role' | 'resolvedRole' | 'handoff' | 'prompt' | 'parentSessionId' | 'throughRowid'>
): string {
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
