import { writeAttachment } from '../../files/attachments.ts'
import { chatCursor } from '../../transcript/cursor.ts'
import type { Attachment } from '../../wire.ts'
import type { PersistedDelegation } from './types.ts'

type ReturnJob = Pick<PersistedDelegation, 'id' | 'role' | 'childSessionId' | 'outcome'>

/** The saved outcome owns the report, including when delivery waits or retries. */
export function delegationReturnAttachment(job: ReturnJob, worktree: string): Attachment {
	if (!job.childSessionId || !job.outcome) throw new Error('return state is incomplete')
	const outcome = job.outcome
	const header = [
		`# Delegated ${job.role} report`,
		'',
		`Delegation: ${job.id}`,
		`Child chat: ${job.childSessionId}`,
		...(outcome.assistantRowid === undefined ? [] : [`Completion cursor: ${chatCursor(outcome.assistantRowid)}`])
	]
	if (outcome.kind === 'error') {
		header.push('', `Task failed: ${outcome.error}`)
		if (outcome.text) header.push('', '## Last assistant message (partial)')
	}
	const body = `${header.join('\n')}\n\n${outcome.text ?? ''}`
	const written = writeAttachment(worktree, `Delegated ${job.role} report.md`, body)
	return { name: written.name, path: written.relPath, bytes: written.bytes, token: written.token }
}

/** Wake the parent with one report reference; earlier investigation stays in the child chat. */
export function delegationReturnText(job: ReturnJob, attachment: Attachment): string {
	if (!job.childSessionId || !job.outcome) throw new Error('return state is incomplete')
	const outcome = job.outcome
	const verb = outcome.kind === 'success' ? 'completed' : 'failed'
	const read = {
		session_id: job.childSessionId,
		...(outcome.assistantRowid === undefined ? {} : { near: chatCursor(outcome.assistantRowid), before: 6, after: 0 })
	}
	return [
		`Delegated ${job.role} task ${job.id} ${verb}.`,
		`Report: ${attachment.token}`,
		`For earlier investigation, use read_chat(${JSON.stringify(read)}).`
	].join('\n\n')
}
