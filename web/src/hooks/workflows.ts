import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { client } from '../lib/api.ts'
import type {
	StartWorkflowRequest,
	StateResponse,
	UiQuarantineWire,
	WorkflowAdoptionCandidate,
	WorkflowRunWire
} from '../lib/types.ts'
import { useApp } from '../store.ts'

/**
 * Put an accepted/mutated run on screen before the next state poll. Bound runs
 * own their workspace projection; the top-level list keeps pre-binding runs
 * visible as well.
 */
function cacheWorkflowProjection(queryClient: QueryClient, workflow: WorkflowRunWire): void {
	queryClient.setQueryData<StateResponse>(['state'], current => {
		if (!current) return current
		const workflows = [...(current.workflows ?? []).filter(run => run.id !== workflow.id), workflow]
		const workspaces = current.workspaces.map(workspace =>
			workspace.id === workflow.workspaceId ? { ...workspace, workflow } : workspace
		)
		return { ...current, workflows, workspaces }
	})
}

/** Dedicated UI authorization boundary for Workflow intake. */
export function useStartWorkflow() {
	const queryClient = useQueryClient()
	return useCallback(
		async (request: StartWorkflowRequest) => {
			const response = await client.startWorkflow(request)
			cacheWorkflowProjection(queryClient, response.workflow)
			void queryClient.invalidateQueries({ queryKey: ['state'] })
			return response
		},
		[queryClient]
	)
}

/**
 * Phone-owned recovery controls. A failed network response keeps the operation's
 * client id so a repeated tap cannot duplicate a mutation whose response was lost.
 */
export function useWorkflowActions() {
	const queryClient = useQueryClient()
	const workflowClientId = useApp(s => s.workflowClientId)
	const finishWorkflowAttempt = useApp(s => s.finishWorkflowAttempt)

	const mutate = useCallback(
		async (key: string, request: (clientId: string) => Promise<{ workflow: WorkflowRunWire }>) => {
			const clientId = workflowClientId(key, key)
			const response = await request(clientId)
			finishWorkflowAttempt(key, clientId)
			cacheWorkflowProjection(queryClient, response.workflow)
			void queryClient.invalidateQueries({ queryKey: ['state'] })
			return response.workflow
		},
		[queryClient, workflowClientId, finishWorkflowAttempt]
	)

	return useMemo(
		() => ({
			retry: (workflow: WorkflowRunWire) =>
				mutate(`retry:${workflow.id}:${workflow.adoption?.actionId ?? workflow.updatedAt}`, clientId =>
					client.retryWorkflow(workflow.id, { clientId })
				),
			adopt: (workflow: WorkflowRunWire, candidate: WorkflowAdoptionCandidate) => {
				const actionId = workflow.adoption?.actionId
				if (!actionId) return Promise.reject(new Error('This Workflow has no action to adopt.'))
				return mutate(`adopt:${workflow.id}:${actionId}:${candidate.id}`, clientId =>
					client.adoptWorkflow(workflow.id, {
						clientId,
						actionId,
						...(workflow.adoption?.kind === 'workspace' ? { workspaceId: candidate.id } : { sessionId: candidate.id })
					})
				)
			},
			replay: (workflow: WorkflowRunWire) => {
				const actionId = workflow.adoption?.actionId
				if (!actionId) return Promise.reject(new Error('This Workflow has no ambiguous action to replay.'))
				return mutate(`replay:${workflow.id}:${actionId}`, clientId =>
					client.replayWorkflow(workflow.id, { clientId, actionId, confirmDuplicateRisk: true })
				)
			},
			complete: (workflow: WorkflowRunWire) =>
				mutate(`complete:${workflow.id}`, clientId => client.completeWorkflow(workflow.id, { clientId })),
			cancel: (workflow: WorkflowRunWire) =>
				mutate(`cancel:${workflow.id}`, clientId => client.cancelWorkflow(workflow.id, { clientId }))
		}),
		[mutate]
	)
}

function uiQuarantineFingerprint(quarantine: UiQuarantineWire): string {
	return JSON.stringify([quarantine.createdAt, quarantine.actionId ?? '', quarantine.effectId ?? '', quarantine.reason])
}

/**
 * A UI quarantine outlives any one Workflow, including cancellation. Keep the
 * phone acknowledgement id stable across a lost response, then retire the
 * banner optimistically only when it still describes the acknowledged hold.
 */
export function useConfirmUiStable() {
	const queryClient = useQueryClient()
	const workflowClientId = useApp(s => s.workflowClientId)
	const finishWorkflowAttempt = useApp(s => s.finishWorkflowAttempt)

	return useCallback(
		async (quarantine: UiQuarantineWire) => {
			const key = 'confirm-ui-stable'
			const fingerprint = uiQuarantineFingerprint(quarantine)
			const clientId = workflowClientId(key, fingerprint)
			const response = await client.confirmUiStable({
				clientId,
				confirmStable: true,
				createdAt: quarantine.createdAt,
				...(quarantine.actionId ? { actionId: quarantine.actionId } : {}),
				...(quarantine.effectId ? { effectId: quarantine.effectId } : {})
			})
			finishWorkflowAttempt(key, clientId)
			queryClient.setQueryData<StateResponse>(['state'], current => {
				if (!current?.uiQuarantine || uiQuarantineFingerprint(current.uiQuarantine) !== fingerprint) return current
				return { ...current, uiQuarantine: undefined }
			})
			void queryClient.invalidateQueries({ queryKey: ['state'] })
			return response
		},
		[queryClient, workflowClientId, finishWorkflowAttempt]
	)
}
