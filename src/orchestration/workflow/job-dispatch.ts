import { scrubWorkflowSecrets } from '../../shared.ts'
import {
	type WorkflowEffectRecord,
	type WorkflowJobRecord,
	type WorkflowRunRecord,
	WorkflowTransitionError
} from '../persistence/db.ts'
import { markReceiptLost } from './effect-recovery.ts'
import { runDurableEffect } from './effects.ts'
import {
	assertDeliveryReceipt,
	assertSessionReceipt,
	cleanUnknown,
	isDeliveryReceipt,
	messageReceipt,
	privateCorrelationBlock,
	sameRelay,
	workflowEffectCorrelationMarker
} from './helpers.ts'
import { driveJobBaton, driveJobOutcome } from './job-results.ts'
import { isTerminalWorkflowJobState } from './machine.ts'
import { effectCall, effectReadCall, requireEffect } from './state.ts'
import type { WorkflowContext } from './types.ts'

export async function driveNextJob(context: WorkflowContext, run: WorkflowRunRecord): Promise<boolean> {
	let jobs = context.db
		.listWorkflowJobs(run.id)
		.filter(
			job => job.cycle === run.cycle && job.role === (run.phase === 'exploring' ? 'exploration' : 'implementation')
		)
	const queued = jobs.find(job => job.state === 'queued')
	if (queued) return Boolean(context.db.claimNextWorkflowJob(context.relay, run.id))
	const owned = jobs.find(job => job.state === 'owned')
	if (owned) {
		if (!sameRelay(owned.owner, context.relay)) {
			const recovered = context.db.reconcileAbandonedWorkflowJobClaim({
				jobId: owned.id,
				eventKey: `recover-job-claim:${owned.id}:${owned.attemptCount}`
			})
			return recovered.status === 'requeued'
		}
		await beginJobAttempt(context, run, owned)
		return true
	}
	jobs = context.db.listWorkflowJobs(run.id).filter(job => job.cycle === run.cycle)
	for (const active of jobs.filter(job => !isTerminalWorkflowJobState(job.state) && job.state !== 'dormant')) {
		if (await driveJob(context, run, active)) return true
	}
	return false
}

export async function beginJobAttempt(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<void> {
	if (!run.workspaceId) throw new WorkflowTransitionError(`Workflow ${run.id} has no workspace for child creation`)
	const sessionBaseline = cleanUnknown(await context.deps.captureSessionBaseline(run.workspaceId))
	const latest = context.db.getWorkflowJob(job.id)
	if (latest?.state !== 'owned' || !sameRelay(latest.owner, context.relay)) return
	const attemptNumber = job.attemptCount + 1
	const openAction = `${job.id}:open:${attemptNumber}`
	const configureAction = `${job.id}:configure:${attemptNumber}`
	const taskAction = `${job.id}:task:${attemptNumber}`
	const batonAction = `${job.id}:baton:${attemptNumber}`
	context.db.idempotentMutation(
		'begin_workflow_job_attempt',
		`${run.id}:${job.id}:${attemptNumber}`,
		{ jobId: job.id, attemptNumber, openAction, sessionBaseline },
		() => {
			context.db.createWorkflowJobAttempt({
				jobId: job.id,
				owner: context.relay,
				state: 'opening',
				effectIds: {
					open: `${run.id}:${openAction}`,
					configure: `${run.id}:${configureAction}`,
					task: `${run.id}:${taskAction}`,
					baton: `${run.id}:${batonAction}`
				}
			})
			context.db.prepareWorkflowEffect({
				id: `${run.id}:${openAction}`,
				runId: run.id,
				actionId: openAction,
				kind: 'open_child',
				jobId: job.id,
				target: { workspaceId: run.workspaceId, rootSessionId: run.rootSessionId },
				inputs: { correlationMarker: workflowEffectCorrelationMarker(run.id, openAction) },
				baseline: sessionBaseline,
				expectedCancellationGeneration: run.cancellationGeneration,
				eventKey: `prepare:${openAction}`
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['owned'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'opening',
				eventKey: `job-opening:${job.id}:${attemptNumber}`,
				eventType: 'workflow_job_opening'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId: openAction }
	)
}

export async function driveJob(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	if (job.state === 'opening') return driveJobOpen(context, run, job)
	if (job.state === 'configuring') return driveJobConfigure(context, run, job)
	if (job.state === 'sending') return driveJobSend(context, run, job)
	if (job.state === 'running') return driveJobOutcome(context, run, job)
	if (job.state === 'returning') return driveJobBaton(context, run, job)
	return false
}

export async function driveJobOpen(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	const actionId = `${job.id}:open:${job.attemptCount}`
	const effect = requireEffect(context, run.id, actionId)
	const result = await runDurableEffect(context, {
		run,
		effect,
		job,
		execute: (_token, dispatch) => context.deps.openChild({ ...effectCall(run, effect, dispatch, job), job }),
		validate: assertSessionReceipt
	})
	const current = result.effect.state === 'committed' ? result.effect : requireEffect(context, run.id, actionId)
	if (current.state !== 'committed') return result.changed
	const receipt = assertSessionReceipt(current.receipt)
	const freshJob = context.db.getWorkflowJob(job.id)
	if (freshJob?.state !== 'opening') return true
	context.db.idempotentMutation(
		'workflow_job_opened',
		`${job.id}:${job.attemptCount}:${receipt.sessionId}`,
		receipt,
		() => {
			context.db.updateWorkflowJobAttempt({
				jobId: job.id,
				attemptNumber: job.attemptCount,
				expectedState: 'opening',
				state: 'configuring',
				childSessionId: receipt.sessionId,
				eventKey: `attempt-configuring:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_attempt_configuring'
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['opening'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'configuring',
				childSessionId: receipt.sessionId,
				eventKey: `job-configuring:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_configuring'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId }
	)
	return true
}

export async function driveJobConfigure(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	if (!job.childSessionId) throw new WorkflowTransitionError(`job ${job.id} is configuring without a child`)
	const actionId = `${job.id}:configure:${job.attemptCount}`
	let effect = context.db.getWorkflowEffect(run.id, actionId)
	if (!effect) {
		effect = context.db.prepareWorkflowEffect({
			id: `${run.id}:${actionId}`,
			runId: run.id,
			actionId,
			kind: 'configure_child',
			jobId: job.id,
			target: { sessionId: job.childSessionId },
			inputs: {
				role: job.resolvedRole,
				correlationMarker: workflowEffectCorrelationMarker(run.id, actionId)
			},
			expectedCancellationGeneration: run.cancellationGeneration,
			eventKey: `prepare:${actionId}`
		}).effect
	}
	const result = await runDurableEffect(context, {
		run,
		effect,
		job,
		execute: (_token, dispatch) =>
			context.deps.configureSession({
				...effectCall(run, effect as WorkflowEffectRecord, dispatch, job),
				sessionId: job.childSessionId as string,
				role: job.resolvedRole
			}),
		validate: value => cleanUnknown(value ?? { matched: true })
	})
	const current = result.effect.state === 'committed' ? result.effect : requireEffect(context, run.id, actionId)
	if (current.state !== 'committed') return result.changed
	const freshJob = context.db.getWorkflowJob(job.id)
	if (freshJob?.state !== 'configuring') return true
	const taskAction = `${job.id}:task:${job.attemptCount}`
	const existingTask = context.db.getWorkflowEffect(run.id, taskAction)
	if (existingTask) {
		if (existingTask.kind !== 'send_task' || existingTask.jobId !== job.id) {
			throw new WorkflowTransitionError(`task effect ${taskAction} does not match job ${job.id}`)
		}
		const prompt =
			existingTask.inputs &&
			typeof existingTask.inputs === 'object' &&
			typeof (existingTask.inputs as { prompt?: unknown }).prompt === 'string'
				? (existingTask.inputs as { prompt: string }).prompt
				: undefined
		if (!prompt) throw new WorkflowTransitionError(`task effect ${taskAction} has no frozen prompt`)
		finishJobConfiguration(context, run, job, taskAction, existingTask.cursor, prompt, false)
		return true
	}
	const cursor = await context.deps.captureDeliveryCursor(job.childSessionId)
	const handoff = scrubWorkflowSecrets((await context.deps.materializeHandoff?.({ run, job })) ?? '')
	const basePrompt = handoff ? `${job.prompt}\n\nOptional root context (read only if needed): ${handoff}` : job.prompt
	const prompt = `${basePrompt}\n\n${privateCorrelationBlock(run.id, taskAction)}`
	finishJobConfiguration(context, run, job, taskAction, cursor, prompt, true)
	return true
}

export function finishJobConfiguration(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord,
	taskAction: string,
	cursor: unknown,
	prompt: string,
	prepareTask: boolean
): void {
	context.db.idempotentMutation(
		'workflow_job_configured',
		`${job.id}:${job.attemptCount}`,
		{ cursor, prompt },
		() => {
			if (prepareTask) {
				context.db.prepareWorkflowEffect({
					id: `${run.id}:${taskAction}`,
					runId: run.id,
					actionId: taskAction,
					kind: 'send_task',
					jobId: job.id,
					target: { sessionId: job.childSessionId },
					inputs: {
						prompt,
						correlationMarker: workflowEffectCorrelationMarker(run.id, taskAction)
					},
					cursor,
					expectedCancellationGeneration: run.cancellationGeneration,
					eventKey: `prepare:${taskAction}`
				})
			}
			context.db.updateWorkflowJobAttempt({
				jobId: job.id,
				attemptNumber: job.attemptCount,
				expectedState: 'configuring',
				state: 'sending',
				eventKey: `attempt-sending:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_attempt_sending'
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['configuring'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'sending',
				eventKey: `job-sending:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_sending'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId: taskAction }
	)
}

export async function driveJobSend(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	job: WorkflowJobRecord
): Promise<boolean> {
	if (!job.childSessionId) throw new WorkflowTransitionError(`job ${job.id} is sending without a child`)
	const actionId = `${job.id}:task:${job.attemptCount}`
	const effect = requireEffect(context, run.id, actionId)
	let current = effect
	let changed = false
	if (effect.state !== 'committed') {
		const prompt =
			effect.inputs &&
			typeof effect.inputs === 'object' &&
			typeof (effect.inputs as { prompt?: unknown }).prompt === 'string'
				? ((effect.inputs as { prompt: string }).prompt as string)
				: job.prompt
		const result = await runDurableEffect(context, {
			run,
			effect,
			job,
			execute: (_token, dispatch) =>
				context.deps.sendPrompt({
					...effectCall(run, effect, dispatch, job),
					sessionId: job.childSessionId as string,
					text: prompt
				}),
			validate: assertDeliveryReceipt
		})
		current = result.effect
		changed = result.changed
	}
	if (current.state !== 'committed' || !isDeliveryReceipt(current.receipt)) return changed
	const latestJob = context.db.getWorkflowJob(job.id)
	if (latestJob?.state !== 'sending') return true
	const resolution = await context.deps.resolveDeliveryReceipt({
		...effectReadCall(run, current, job),
		sessionId: job.childSessionId,
		receipt: current.receipt
	})
	if (resolution.status === 'lost') {
		markReceiptLost(context, run, current, resolution.evidence)
		return true
	}
	const resolved = messageReceipt(resolution, current.receipt.id)
	if (!resolved) {
		if (!isDeliveryReceipt(latestJob.taskReceipt)) {
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['sending'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'sending',
				taskReceipt: current.receipt,
				eventKey: `task-accepted:${job.id}:${current.receipt.id}`,
				eventType: 'workflow_task_accepted'
			})
			return true
		}
		return changed
	}
	context.db.idempotentMutation(
		'workflow_task_delivered',
		`${job.id}:${resolved.id}`,
		resolved,
		() => {
			context.db.updateWorkflowJobAttempt({
				jobId: job.id,
				attemptNumber: job.attemptCount,
				expectedState: 'sending',
				state: 'running',
				eventKey: `attempt-running:${job.id}:${job.attemptCount}`,
				eventType: 'workflow_job_attempt_running'
			})
			context.db.updateWorkflowJob({
				jobId: job.id,
				expectedStates: ['sending'],
				expectedCancellationGeneration: run.cancellationGeneration,
				state: 'running',
				taskReceipt: resolved,
				eventKey: `task-delivered:${job.id}:${resolved.id}`,
				eventType: 'workflow_task_delivered'
			})
			return { runId: run.id, jobId: job.id }
		},
		{ runId: run.id, actionId }
	)
	return true
}
