import crypto from 'node:crypto'

import fs from 'node:fs'

import path from 'node:path'

import { agentConfigMatches } from '../../agents/agent-config.ts'
import { ATTACHMENT_DIR, attachmentName, attachmentToken } from '../../files/attachments.ts'
import type { WorkflowRunRecord } from '../../orchestration/persistence/types.ts'
import { WorkflowCoordinatorError } from '../../orchestration/workflow/errors.ts'
import type { FrozenWorkflowRole } from '../../orchestration/workflow/prompts.ts'
import type {
	WorkflowDeliveryCursor,
	WorkflowEffectCall,
	WorkflowRootInspection
} from '../../orchestration/workflow/types.ts'
import type { DeliveryCursor, DeliveryReceipt, SessionRow, Workspace } from '../../reads/types.ts'
import { timestampMs, workspaceTitle } from '../../shared.ts'

import { retryWontHelp } from '../../writes/guards.ts'
import { uiTurn, withGatedUiCommand } from '../../writes/ui-lock.ts'
import type { BaseServices } from './base.ts'
import type { DeliveryServices } from './delivery.ts'

export interface WorkflowWorkspaceBaseline {
	kind: 'workspace_ids'
	repo: string
	workspaceIds: string[]
}

export interface WorkflowSessionBaseline {
	kind: 'session_ids'
	workspaceId: string
	sessionIds: string[]
}

export function sessionMatchesWorkflowRole(session: SessionRow, role: FrozenWorkflowRole): boolean {
	return (
		session.agent_type === role.agentType &&
		agentConfigMatches(
			{
				agentType: session.agent_type,
				model: session.model,
				effort: session.claude_effort_level,
				plan: session.permission_mode === 'plan',
				fast: Boolean(session.fast_mode)
			},
			role
		)
	)
}

export function createWorkflowProbesServices(
	services: Pick<BaseServices, 'reads' | 'actuator'> &
		Pick<
			DeliveryServices,
			| 'firstPrompts'
			| 'parkedPrompts'
			| 'deliverPrompt'
			| 'SEND_BUDGET_MS'
			| 'locateChat'
			| 'confirmDelivery'
			| 'CONFIRM_WINDOW_MS'
		>
) {
	const {
		reads,
		actuator,
		firstPrompts,
		parkedPrompts,
		deliverPrompt,
		SEND_BUDGET_MS,
		locateChat,
		confirmDelivery,
		CONFIRM_WINDOW_MS
	} = services

	function workflowDeliveryCursor(sessionId: string): WorkflowDeliveryCursor {
		const cursor = reads.deliveryCursor(sessionId)
		return { rowid: cursor.rowid, outboxIds: [...cursor.outboxIds].sort() }
	}

	function readsDeliveryCursor(value: unknown): DeliveryCursor | null {
		if (!value || typeof value !== 'object') return null
		const cursor = value as { rowid?: unknown; outboxIds?: unknown }
		if (!Number.isSafeInteger(cursor.rowid) || !Array.isArray(cursor.outboxIds)) return null
		if (cursor.outboxIds.some(id => typeof id !== 'string')) return null
		return { rowid: cursor.rowid as number, outboxIds: new Set(cursor.outboxIds as string[]) }
	}

	function workspaceBaseline(value: unknown): WorkflowWorkspaceBaseline | null {
		if (!value || typeof value !== 'object') return null
		const baseline = value as Partial<WorkflowWorkspaceBaseline>
		return baseline.kind === 'workspace_ids' &&
			typeof baseline.repo === 'string' &&
			Array.isArray(baseline.workspaceIds) &&
			baseline.workspaceIds.every(id => typeof id === 'string')
			? (baseline as WorkflowWorkspaceBaseline)
			: null
	}

	function sessionBaseline(value: unknown): WorkflowSessionBaseline | null {
		if (!value || typeof value !== 'object') return null
		const baseline = value as Partial<WorkflowSessionBaseline>
		return baseline.kind === 'session_ids' &&
			typeof baseline.workspaceId === 'string' &&
			Array.isArray(baseline.sessionIds) &&
			baseline.sessionIds.every(id => typeof id === 'string')
			? (baseline as WorkflowSessionBaseline)
			: null
	}

	function workflowRootInspection(ws: Workspace, session: SessionRow): WorkflowRootInspection {
		const cursor = workflowDeliveryCursor(session.id)
		const userRows = reads.getMessages(session.id).entries.filter(entry => entry.role === 'user')
		const firstPrompt = firstPrompts.list().some(entry => entry.workspaceId === ws.id)
		const parked = parkedPrompts.list().some(entry => entry.sessionId === session.id)
		const reasons = [
			session.status !== 'idle' ? `the chat status is ${session.status ?? 'unknown'}, not idle` : '',
			session.background_tasks.length ? 'the chat is waiting on a background task' : '',
			session.last_user_message_at ? 'the chat already has a user message timestamp' : '',
			userRows.length ? 'the chat already has a user message' : '',
			cursor.outboxIds.length ? 'the chat already has a queued prompt' : '',
			firstPrompt ? 'the workspace already has a pending first prompt' : '',
			parked ? 'the chat already has a parked prompt' : ''
		].filter(Boolean)
		return {
			workspaceId: ws.id,
			rootSessionId: session.id,
			pristine: reasons.length === 0,
			pristineEvidence: {
				status: session.status,
				backgroundTasks: session.background_tasks.length,
				lastUserMessageAt: session.last_user_message_at,
				userRows: userRows.length,
				outboxRows: cursor.outboxIds.length,
				firstPrompt,
				parked
			},
			deliveryCursor: cursor,
			...(reasons.length ? { reason: `Workflow requires a pristine root: ${reasons.join('; ')}.` } : {})
		}
	}

	function assertWorkflowRootStillPristine(run: WorkflowRunRecord, expectedSessionId: string): void {
		const ws = run.workspaceId ? reads.getWorkspace(run.workspaceId) : null
		const session = reads.getSession(expectedSessionId)
		if (
			!ws ||
			!run.rootSessionId ||
			run.rootSessionId !== expectedSessionId ||
			!session ||
			reads.sessionWorkspaceId(expectedSessionId) !== ws.id
		) {
			throw new WorkflowCoordinatorError(
				'workflow_root_not_pristine',
				'The exact Workflow root binding changed before its first prompt could be dispatched.'
			)
		}
		const inspection = workflowRootInspection(ws, session)
		if (!inspection.pristine) {
			throw new WorkflowCoordinatorError(
				'workflow_root_not_pristine',
				inspection.reason ?? 'Workflow requires a pristine root chat.'
			)
		}
	}

	function stableWorkflowFile(worktree: string, jobId: string, name: string, body: string) {
		// Conductor requires six alphanumerics. Preserve all six characters' entropy
		// instead of truncating a hex digest to only 24 bits for a long-lived stable path.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
		const digest = crypto.createHash('sha256').update(`workflow-handoff:${jobId}`).digest()
		const id = Array.from(digest.subarray(0, 6), byte => alphabet[byte % alphabet.length]).join('')
		const safeName = attachmentName(name)
		const directory = path.join(worktree, ATTACHMENT_DIR, id)
		const destination = path.join(directory, safeName)
		fs.mkdirSync(directory, { recursive: true })
		try {
			fs.writeFileSync(destination, body, { flag: 'wx' })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			if (fs.readFileSync(destination, 'utf8') !== body) {
				throw new Error(`the stable Workflow handoff path ${path.join(ATTACHMENT_DIR, id, safeName)} is occupied`)
			}
		}
		return { name: safeName, relPath: path.join(ATTACHMENT_DIR, id, safeName) }
	}

	function stableWorkflowAttachment(worktree: string, jobId: string, name: string, body: string): string {
		const file = stableWorkflowFile(worktree, jobId, name, body)
		return attachmentToken(file.name, file.relPath)
	}

	function workflowWorkspaceCandidate(ws: Workspace) {
		return {
			id: ws.id,
			title: workspaceTitle(ws),
			repo: ws.repo_name ?? '',
			createdAt: timestampMs(ws.created_at),
			kind: 'workspace' as const
		}
	}

	function workflowSessionCandidate(ws: Workspace, session: SessionRow) {
		return {
			id: session.id,
			title: session.title?.trim() || '(untitled chat)',
			repo: ws.repo_name ?? '',
			createdAt: timestampMs(session.created_at),
			kind: 'session' as const
		}
	}

	function workflowSessionId(effect: WorkflowEffectCall['effect']): string | null {
		if (!effect.target || typeof effect.target !== 'object') return null
		const id = (effect.target as { sessionId?: unknown }).sessionId
		return typeof id === 'string' ? id : null
	}

	function workflowEffectPrompt(effect: WorkflowEffectCall['effect']): string | null {
		if (!effect.inputs || typeof effect.inputs !== 'object') return null
		const prompt = (effect.inputs as { prompt?: unknown }).prompt
		return typeof prompt === 'string' ? prompt : null
	}

	function workflowEffectMarker(effect: WorkflowEffectCall['effect']): string | null {
		if (!effect.inputs || typeof effect.inputs !== 'object') return null
		const marker = (effect.inputs as { correlationMarker?: unknown }).correlationMarker
		return typeof marker === 'string' ? marker : null
	}

	function withWorkflowEffectGate<T>(call: WorkflowEffectCall, operation: () => Promise<T>): Promise<T> {
		return call.dispatch.mode === 'gated_child'
			? withGatedUiCommand(call.dispatch.gatedProcessReady, () => uiTurn(operation))
			: uiTurn(operation)
	}

	async function sendWorkflowPrompt(
		call: WorkflowEffectCall & { sessionId: string; text: string },
		queue: boolean
	): Promise<DeliveryReceipt> {
		const ws = call.run.workspaceId ? reads.getWorkspace(call.run.workspaceId) : null
		if (!ws || reads.sessionWorkspaceId(call.sessionId) !== ws.id) {
			throw new WorkflowCoordinatorError('workflow_not_found', 'The Workflow destination chat is unavailable.', {
				status: 404
			})
		}
		const before = readsDeliveryCursor(call.effect.cursor) ?? reads.deliveryCursor(call.sessionId)
		const result = await withWorkflowEffectGate(call, async () => {
			if (actuator.name !== 'sidecar') return deliverPrompt(ws, call.sessionId, call.text, SEND_BUDGET_MS, queue)
			const located = locateChat(ws, call.sessionId)
			if ('error' in located) return { ok: false, strategy: actuator.name, attempts: 0, error: located.error }
			const sent = await actuator.send({ workspace: ws, sessionId: call.sessionId, tab: located.tab }, call.text, {
				queue
			})
			if (!sent.ok) return { ...sent, attempts: 1 }
			const landed = await confirmDelivery(call.sessionId, call.text, before, Date.now() + CONFIRM_WINDOW_MS)
			return landed
				? { ...sent, attempts: 1 }
				: {
						ok: false,
						strategy: sent.strategy,
						attempts: 1,
						error: 'Conductor did not record the sidecar Workflow prompt; automatic replay is disabled.'
					}
		})
		const receipt = reads.deliveryReceiptSince(call.sessionId, call.text, before)
		if (receipt) return receipt
		throw new WorkflowCoordinatorError(
			'workflow_effect_failed',
			result.error ?? 'Conductor did not record an accepted Workflow prompt.',
			{ retryable: !retryWontHelp(result.error) }
		)
	}
	return {
		workflowRootInspection,
		withWorkflowEffectGate,
		sessionMatchesWorkflowRole,
		workflowDeliveryCursor,
		stableWorkflowAttachment,
		stableWorkflowFile,
		sendWorkflowPrompt,
		workflowSessionId,
		assertWorkflowRootStillPristine,
		workspaceBaseline,
		workflowWorkspaceCandidate,
		sessionBaseline,
		workflowSessionCandidate,
		workflowEffectPrompt,
		readsDeliveryCursor,
		workflowEffectMarker
	}
}
export type WorkflowProbesServices = ReturnType<typeof createWorkflowProbesServices>
