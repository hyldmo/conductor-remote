import { writeAttachment } from '../../files/attachments.ts'

import { delegatedPrompt } from '../../orchestration/delegation/prompt.ts'
import { DelegationQueue } from '../../orchestration/delegation/queue.ts'
import type { DelegationActionError, PersistedDelegation } from '../../orchestration/delegation/types.ts'

import type { Workspace } from '../../reads/types.ts'

import { withoutWindowEvidence } from '../../shared.ts'

import { renderTranscript, transcriptThrough } from '../../transcript/parser.ts'

import type { Attachment, DelegationError, DelegationProjection } from '../../wire.ts'

import { lockBlocked, screenLocked } from '../../writes/guards.ts'
import { UiBusyError, uiBusy, withUiPriority } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'
import type { DeliveryServices } from './delivery.ts'

export function createDelegationsServices(
	services: Pick<BaseServices, 'reads' | 'actuator' | 'sessionPoller' | 'delegationStore'> &
		Pick<
			DeliveryServices,
			| 'openChat'
			| 'applyAgentPatch'
			| 'deliverPrompt'
			| 'deliveredRowSince'
			| 'SEND_BUDGET_MS'
			| 'locateChat'
			| 'confirmDeliveryRow'
			| 'CONFIRM_WINDOW_MS'
		>
) {
	const {
		reads,
		actuator,
		sessionPoller,
		delegationStore,
		openChat,
		applyAgentPatch,
		deliverPrompt,
		deliveredRowSince,
		SEND_BUDGET_MS,
		locateChat,
		confirmDeliveryRow,
		CONFIRM_WINDOW_MS
	} = services

	function delegationError(code: DelegationError['code'], error: string, retryable = true): DelegationActionError {
		const clean = withoutWindowEvidence(error)
		if (clean !== error) console.warn(`[relay] ${error}`)
		return { ok: false, code, error: clean, retryable, blocked: lockBlocked(error) || uiBusy(error) }
	}

	function wireAttachment(written: ReturnType<typeof writeAttachment>): Attachment {
		return {
			name: written.name,
			path: written.relPath,
			bytes: written.bytes,
			token: written.token
		}
	}

	/** Write the frozen parent transcript cut before opening its child tab. */
	function delegationHandoff(job: PersistedDelegation, ws: Workspace): Attachment {
		if (!ws.worktree) throw new Error('worktree path unresolved')
		const source = reads.getSession(job.parentSessionId)
		if (!source) throw new Error('parent chat not found in that workspace')
		const { entries } = reads.getMessages(job.parentSessionId)
		const cut = job.throughRowid === undefined ? { entries, later: 0 } : transcriptThrough(entries, job.throughRowid)
		if (!cut) throw new Error('the requested handoff message is not in the parent chat')
		const rendered = renderTranscript(cut.entries, { thinking: job.includeThinking, tools: false })
		if (!rendered.kept) throw new Error('the parent chat has nothing to hand off yet')
		const title = source.title?.trim() || 'chat'
		const header = [
			`# Transcript of ${title}`,
			'',
			[ws.repo_name, ws.branch].filter(Boolean).join(' · '),
			`Delegation ${job.id} copied this chat through ${job.throughRowid ?? 'its latest row'}.`,
			cut.later ? `${cut.later} later ${cut.later === 1 ? 'entry is' : 'entries are'} intentionally omitted.` : '',
			'',
			''
		]
			.filter((line, index) => line || index < 2 || index >= 5)
			.join('\n')
		return wireAttachment(writeAttachment(ws.worktree, `Transcript of ${title}.md`, header + rendered.text))
	}

	async function openDelegation(job: PersistedDelegation) {
		const ws = reads.getWorkspace(job.workspaceId)
		if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
		if (!ws.worktree) return delegationError('worktree_unavailable', 'worktree path unresolved', false)
		if ((await screenLocked()) === true) {
			return delegationError('opening_failed', 'The Mac is locked — unlock it and try again.')
		}
		let handoff: Attachment
		try {
			handoff = delegationHandoff(job, ws)
		} catch (err) {
			return delegationError('opening_failed', err instanceof Error ? err.message : String(err), false)
		}
		const opened = await withUiPriority('background', () => openChat(ws))
		if ('error' in opened) {
			return delegationError(
				'opening_failed',
				opened.result.error ?? 'Conductor did not open a child chat',
				opened.retryable !== false
			)
		}
		if (!opened.sessionId)
			return delegationError('opening_failed', 'Conductor opened a tab but did not record its chat id', false)
		return { ok: true as const, childSessionId: opened.sessionId, handoff }
	}

	async function configureDelegation(job: PersistedDelegation) {
		const ws = reads.getWorkspace(job.workspaceId)
		if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
		if (!job.childSessionId) return delegationError('state_invalid', 'the delegated child id is missing', false)
		const before = reads.getSession(job.childSessionId)
		if (!before) return delegationError('session_not_found', 'the delegated child chat is gone', false)
		const applied = await withUiPriority('background', () =>
			applyAgentPatch(ws, job.childSessionId as string, {
				model: job.resolvedRole.model,
				effort: job.resolvedRole.effort,
				fast: job.resolvedRole.fast
			})
		)
		if (!applied.ok)
			return delegationError('configuration_failed', applied.error ?? 'agent configuration did not stick')
		const after = reads.getSession(job.childSessionId)
		if (!after) return delegationError('session_not_found', 'the configured child chat disappeared', false)
		if (after.agent_type !== job.resolvedRole.agentType) {
			return delegationError(
				'configuration_failed',
				`Conductor recorded provider ${after.agent_type ?? 'unknown'}, not ${job.resolvedRole.agentType}`
			)
		}
		return { ok: true as const }
	}

	async function sendDelegation(job: PersistedDelegation) {
		const ws = reads.getWorkspace(job.workspaceId)
		if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
		if (!job.childSessionId) return delegationError('state_invalid', 'the delegated child id is missing', false)
		let text: string
		try {
			text = delegatedPrompt(job)
		} catch (err) {
			return delegationError('state_invalid', err instanceof Error ? err.message : String(err), false)
		}
		const cursor = reads.getMessages(job.childSessionId).cursor
		const result = await withUiPriority('background', () => deliverPrompt(ws, job.childSessionId as string, text))
		if (!result.ok) return delegationError('send_failed', result.error ?? 'the delegated prompt did not land')
		const sentRowid = deliveredRowSince(job.childSessionId, text, cursor)
		if (sentRowid === null) return delegationError('send_failed', 'the delegated prompt has no transcript receipt')
		return { ok: true as const, sentRowid }
	}

	function delegationCompletion(job: PersistedDelegation) {
		if (!job.childSessionId || job.sentRowid === undefined) return null
		const child = reads.getSession(job.childSessionId)
		if (!child) {
			return {
				outcome: { kind: 'error' as const, error: 'the delegated child chat disappeared' }
			}
		}
		const assistants = reads
			.getMessages(job.childSessionId, job.sentRowid)
			.entries.filter(entry => entry.role === 'assistant' && entry.text.trim())
		const last = assistants.at(-1)
		if (child.status === 'error') {
			return {
				outcome: {
					kind: 'error' as const,
					error: 'the delegated agent stopped with an error',
					...(last ? { assistantRowid: last.rowid, text: last.text.trim() } : {})
				},
				...(last ? { completionRowid: last.rowid } : {})
			}
		}
		if (child.status !== 'idle' || child.background_tasks.length || !last) return null
		return {
			outcome: { kind: 'success' as const, assistantRowid: last.rowid, text: last.text.trim() },
			completionRowid: last.rowid
		}
	}

	/** Keep the structured Baton tail when present; otherwise the complete answer is the Baton. */
	function batonText(text: string): string {
		const match = /^## Baton\b/im.exec(text)
		return match ? text.slice(match.index).trim() : text.trim()
	}

	function delegationReturnAttachment(job: PersistedDelegation, ws: Workspace): Attachment {
		if (!ws.worktree || !job.childSessionId || job.sentRowid === undefined)
			throw new Error('return state is incomplete')
		const rendered = renderTranscript(reads.getMessages(job.childSessionId, job.sentRowid).entries, {
			thinking: true,
			tools: false
		})
		const outcomeText = job.outcome
			? job.outcome.kind === 'success'
				? job.outcome.text
				: (job.outcome.text ?? job.outcome.error)
			: '(no transcript prose)'
		const body = [
			`# Delegated ${job.role} result`,
			'',
			`Delegation: ${job.id}`,
			`Child chat: ${job.childSessionId}`,
			'',
			rendered.text || outcomeText
		].join('\n')
		return wireAttachment(writeAttachment(ws.worktree, `Delegated ${job.role} result.md`, body))
	}

	function delegationReturnText(job: PersistedDelegation, attachment: Attachment): string {
		if (!job.outcome) throw new Error('the delegated outcome is missing')
		const result =
			job.outcome.kind === 'success' ? batonText(job.outcome.text) : batonText(job.outcome.text ?? job.outcome.error)
		const verb = job.outcome.kind === 'success' ? 'completed' : 'failed'
		return [`Delegated ${job.role} task ${job.id} ${verb}.`, '', result, '', attachment.token].join('\n')
	}

	async function returnDelegation(job: PersistedDelegation) {
		const ws = reads.getWorkspace(job.workspaceId)
		if (!ws) return delegationError('workspace_not_found', 'the delegated workspace is gone', false)
		if (!reads.getSession(job.parentSessionId)) {
			return delegationError('session_not_found', 'the parent chat is gone', false)
		}
		if (job.returnCursor !== undefined) {
			if (!job.returnAttachment || !job.returnText) {
				return delegationError('state_invalid', 'the queued return receipt state is incomplete', false)
			}
			const rowid = deliveredRowSince(job.parentSessionId, job.returnText, job.returnCursor)
			return rowid === null
				? {
						ok: true as const,
						pending: true as const,
						returnCursor: job.returnCursor,
						returnAttachment: job.returnAttachment,
						returnText: job.returnText
					}
				: { ok: true as const, returnRowid: rowid }
		}

		let attachment: Attachment
		let text: string
		try {
			attachment = delegationReturnAttachment(job, ws)
			text = delegationReturnText(job, attachment)
		} catch (err) {
			return delegationError('return_failed', err instanceof Error ? err.message : String(err), false)
		}
		const cursor = reads.getMessages(job.parentSessionId).cursor
		if (job.returnMode === 'steer') {
			const result = await withUiPriority('background', () =>
				deliverPrompt(ws, job.parentSessionId, text, SEND_BUDGET_MS, false)
			)
			if (!result.ok) return delegationError('return_failed', result.error ?? 'the delegated result did not return')
			const rowid = deliveredRowSince(job.parentSessionId, text, cursor)
			return rowid === null
				? delegationError('return_failed', 'the delegated result has no transcript receipt')
				: { ok: true as const, returnRowid: rowid }
		}

		const located = locateChat(ws, job.parentSessionId)
		if ('error' in located) return delegationError('return_failed', located.error, false)
		const result = await withUiPriority('background', () =>
			actuator.send({ workspace: ws, sessionId: job.parentSessionId, tab: located.tab }, text, {
				deadline: Date.now() + SEND_BUDGET_MS,
				queue: true
			})
		)
		const immediate = deliveredRowSince(job.parentSessionId, text, cursor)
		if (immediate !== null) return { ok: true as const, returnRowid: immediate }
		if (!result.ok) {
			const late = await confirmDeliveryRow(job.parentSessionId, text, cursor, Date.now() + CONFIRM_WINDOW_MS)
			if (late !== null) return { ok: true as const, returnRowid: late }
			return delegationError('return_failed', result.error ?? 'Conductor did not accept the queued result')
		}
		return {
			ok: true as const,
			pending: true as const,
			returnCursor: cursor,
			returnAttachment: attachment,
			returnText: text
		}
	}

	const delegationQueue = new DelegationQueue(
		{
			open: openDelegation,
			configure: configureDelegation,
			send: sendDelegation,
			completion: delegationCompletion,
			returnResult: returnDelegation
		},
		{
			blockedError: error => error instanceof UiBusyError
		}
	)

	sessionPoller.subscribe(() => {
		void delegationQueue.wake()
	})

	function projectDelegation(job: PersistedDelegation): DelegationProjection {
		return {
			id: job.id,
			workspaceId: job.workspaceId,
			parentSessionId: job.parentSessionId,
			...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
			role: job.role,
			resolvedRole: job.resolvedRole,
			prompt: job.prompt,
			returnMode: job.returnMode,
			status: job.status,
			attempts: job.attempts,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			...(job.outcome ? { outcome: job.outcome } : {}),
			...(job.failure ? { failure: job.failure } : {})
		}
	}

	function attachDelegationState(workspaces: Workspace[]): void {
		for (const ws of workspaces) {
			const store = delegationStore(ws)
			if (!store) continue
			const listed = store.list()
			const jobs = listed.jobs.filter(job => job.status !== 'returned').map(projectDelegation)
			const roles = store.sessionRoles()
			if (jobs.length) Object.assign(ws, { delegations: jobs })
			if (Object.keys(roles.sessions).length) Object.assign(ws, { session_roles: roles.sessions })
			const warnings = [...listed.warnings.map(warning => `${warning.file}: ${warning.message}`)]
			if (roles.warning) warnings.push(`sessions.json: ${roles.warning}`)
			if (warnings.length) Object.assign(ws, { delegation_warning: warnings.join('; ') })
		}
	}
	return { batonText, attachDelegationState, projectDelegation, delegationQueue }
}
export type DelegationsServices = ReturnType<typeof createDelegationsServices>
