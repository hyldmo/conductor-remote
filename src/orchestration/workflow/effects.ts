import { randomBytes } from 'node:crypto'
import { workflowCapabilityToken } from '../../shared.ts'
import { withUiDispatchHook, withUiPriority } from '../../writes/ui-lock.ts'
import {
	hashCapabilityToken,
	type WorkflowEffectRecord,
	type WorkflowJobRecord,
	type WorkflowRunRecord,
	WorkflowTransitionError
} from '../persistence/db.ts'
import { quarantineAndBlock } from './effect-recovery.ts'
import { WorkflowCompatibilityReadError, WorkflowCoordinatorError, WorkflowRoleVerificationError } from './errors.ts'
import { cleanUnknown, errorCode, errorMessage, preExecutionRetryClass, sameRelay } from './helpers.ts'
import { isTerminalWorkflowPhase } from './machine.ts'
import { assertCompatible, blockRun, effectReadCall, requireEffect, requireRun } from './state.ts'
import type {
	DurableEffectOptions,
	DurableEffectResult,
	WorkflowContext,
	WorkflowEffectDispatch,
	WorkflowEffectReconciliation
} from './types.ts'

export async function runDurableEffect<T>(
	context: WorkflowContext,
	options: DurableEffectOptions<T>
): Promise<DurableEffectResult> {
	let effect = requireEffect(context, options.run.id, options.effect.actionId)
	if (
		effect.state === 'committed' ||
		effect.state === 'failed' ||
		effect.state === 'ambiguous' ||
		effect.state === 'cancelled'
	) {
		return { effect, changed: false }
	}
	if (
		!effect.owner &&
		effect.state === 'prepared' &&
		(effect.kind === 'configure_root' || effect.kind === 'configure_child')
	) {
		const satisfaction = await context.deps.reconcileEffect?.(effectReadCall(options.run, effect, options.job))
		if (satisfaction?.status === 'committed') {
			const latest = requireEffect(context, options.run.id, effect.actionId)
			const latestRun = requireRun(context, options.run.id)
			if (
				!latest.owner &&
				latest.state === 'prepared' &&
				latestRun.phase !== 'blocked' &&
				!isTerminalWorkflowPhase(latestRun.phase)
			) {
				effect = context.db.markWorkflowEffectSatisfiedWithoutDispatch({
					runId: latestRun.id,
					actionId: latest.actionId,
					expectedCancellationGeneration: latestRun.cancellationGeneration,
					receipt: cleanUnknown(satisfaction.receipt),
					eventKey: `effect-satisfied:${latest.actionId}`
				})
				return { effect, changed: true }
			}
		}
	}
	if (effect.owner) {
		const reconciled = await reconcileClaimedEffect(context, options.run, effect, options.job)
		effect = reconciled.effect
		if (reconciled.changed || effect.owner || effect.state !== 'prepared') return reconciled
	}
	const currentRun = requireRun(context, options.run.id)
	if (currentRun.phase === 'blocked' || isTerminalWorkflowPhase(currentRun.phase)) return { effect, changed: false }
	const claim = context.db.claimPreparedWorkflowEffect({
		runId: options.run.id,
		actionId: effect.actionId,
		owner: context.relay,
		expectedCancellationGeneration: currentRun.cancellationGeneration
	})
	if (!claim) return { effect: requireEffect(context, options.run.id, effect.actionId), changed: false }
	const capabilityToken = options.capabilityGrant
		? workflowCapabilityToken(randomBytes(32).toString('base64url'))
		: undefined
	const launchNonce = capabilityToken ? hashCapabilityToken(capabilityToken) : randomBytes(32).toString('hex')
	const dispatchMode = context.deps.dispatchMode?.(claim.effect) ?? 'in_process'
	const dispatch: WorkflowEffectDispatch = {
		mode: dispatchMode,
		gatedProcessReady: async externalProcess => {
			if (dispatchMode !== 'gated_child') {
				throw new WorkflowCoordinatorError(
					'workflow_adapter_invalid',
					`Workflow adapter for ${effect.actionId} registered a gated process in in-process mode.`
				)
			}
			const latestRun = requireRun(context, options.run.id)
			if (
				latestRun.cancellationGeneration !== currentRun.cancellationGeneration ||
				latestRun.phase === 'blocked' ||
				isTerminalWorkflowPhase(latestRun.phase)
			) {
				throw new WorkflowTransitionError(`Workflow ${latestRun.id} changed before gated process release`)
			}
			await assertCompatible(context)
			context.db.markWorkflowEffectMayExecute({
				runId: latestRun.id,
				actionId: effect.actionId,
				owner: context.relay,
				attemptNumber: claim.attempt.attemptNumber,
				launchNonce,
				externalProcess
			})
		}
	}
	try {
		return await withUiPriority('background', () =>
			withUiDispatchHook(
				async () => {
					const latestRun = requireRun(context, options.run.id)
					if (
						latestRun.cancellationGeneration !== currentRun.cancellationGeneration ||
						latestRun.phase === 'blocked' ||
						isTerminalWorkflowPhase(latestRun.phase)
					) {
						throw new WorkflowTransitionError(`Workflow ${latestRun.id} changed before UI dispatch`)
					}
					await context.deps.validateBeforeDispatch?.(
						effectReadCall(latestRun, requireEffect(context, latestRun.id, effect.actionId), options.job)
					)
					await assertCompatible(context)
					context.db.markWorkflowEffectDispatched({
						runId: latestRun.id,
						actionId: effect.actionId,
						owner: context.relay,
						attemptNumber: claim.attempt.attemptNumber,
						launchNonce,
						mayExecute: dispatchMode === 'in_process'
					})
				},
				async () => {
					try {
						const result = await options.execute(capabilityToken, dispatch)
						effect = requireEffect(context, options.run.id, effect.actionId)
						if (effect.state !== 'dispatched') {
							throw new WorkflowCoordinatorError(
								'workflow_adapter_invalid',
								`Workflow adapter for ${effect.actionId} returned without entering uiTurn.`
							)
						}
						if (!effect.mayExecute) {
							throw new WorkflowCoordinatorError(
								'workflow_adapter_invalid',
								`Workflow adapter for ${effect.actionId} returned before releasing its gated process.`
							)
						}
						const receipt = cleanUnknown(options.validate(result))
						const completedRun = requireRun(context, options.run.id)
						if (completedRun.phase === 'cancelled') {
							effect = context.db.recordLateWorkflowEffect({
								runId: completedRun.id,
								actionId: effect.actionId,
								receipt,
								eventKey: `late-effect:${effect.actionId}:${claim.attempt.attemptNumber}`
							})
							return { effect, changed: true }
						}
						if (completedRun.phase === 'completed') return { effect, changed: false }
						effect = context.db.markWorkflowEffectCommitted({
							runId: options.run.id,
							actionId: effect.actionId,
							owner: context.relay,
							attemptNumber: claim.attempt.attemptNumber,
							receipt
						})
						if (requireRun(context, options.run.id).phase === 'cancelled') {
							effect = context.db.recordLateWorkflowEffect({
								runId: options.run.id,
								actionId: effect.actionId,
								receipt,
								eventKey: `late-effect:${effect.actionId}:${claim.attempt.attemptNumber}`
							})
						}
						return { effect, changed: true }
					} catch (error) {
						return failEffect(context, options.run, effect.actionId, claim.attempt.attemptNumber, error, options.job)
					}
				},
				claim.effect.id
			)
		)
	} catch (error) {
		return failEffect(context, options.run, effect.actionId, claim.attempt.attemptNumber, error, options.job)
	}
}

export async function reconcileClaimedEffect(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	effect: WorkflowEffectRecord,
	job?: WorkflowJobRecord
): Promise<DurableEffectResult> {
	const positive = await context.deps.reconcileEffect?.(effectReadCall(run, effect, job))
	if (positive?.status === 'committed') {
		const committed = context.db.markWorkflowEffectCommitted({
			runId: run.id,
			actionId: effect.actionId,
			receipt: cleanUnknown(positive.receipt),
			eventKey: `effect-reconciled:${effect.actionId}:${effect.attemptCount}`
		})
		return { effect: committed, changed: true }
	}
	const recovery = context.db.reconcileAbandonedWorkflowEffect({
		runId: run.id,
		actionId: effect.actionId,
		eventKey: `recover-effect:${effect.actionId}:${effect.attemptCount}`
	})
	if (recovery.status === 'safely_prepared') return { effect: recovery.effect, changed: true }
	if (recovery.status === 'ambiguous') {
		quarantineAndBlock(
			context,
			run,
			recovery.effect,
			positive?.status === 'ambiguous' ? positive.candidates : undefined
		)
		return { effect: recovery.effect, changed: true }
	}
	return { effect: recovery.effect, changed: false }
}

export async function failEffect(
	context: WorkflowContext,
	run: WorkflowRunRecord,
	actionId: string,
	attemptNumber: number,
	error: unknown,
	job?: WorkflowJobRecord
): Promise<DurableEffectResult> {
	let effect = requireEffect(context, run.id, actionId)
	const currentRun = requireRun(context, run.id)
	if (
		error instanceof WorkflowCompatibilityReadError &&
		!isTerminalWorkflowPhase(currentRun.phase) &&
		!effect.mayExecute
	) {
		// The read failed before any external command was released. Settle this
		// attempt, put the exact intent back, and let the wake budget decide when to pause.
		const failure = {
			runId: run.id,
			actionId,
			owner: context.relay,
			attemptNumber,
			errorCode: error.code,
			errorMessage: error.message
		}
		if (effect.state === 'prepared' && sameRelay(effect.owner, context.relay)) {
			context.db.markWorkflowEffectFailed(failure)
		} else if (effect.state === 'dispatched') {
			context.db.markWorkflowEffectFailedBeforeMayExecute(failure)
		}
		if (requireEffect(context, run.id, actionId).state === 'failed') {
			context.db.retryWorkflowEffect(run.id, actionId, `compatibility-retry:${actionId}:${attemptNumber}`)
		}
		throw error
	}
	if (
		error instanceof WorkflowRoleVerificationError &&
		effect.state === 'dispatched' &&
		effect.mayExecute &&
		(effect.kind === 'configure_root' || effect.kind === 'configure_child')
	) {
		effect = context.db.markWorkflowConfigurationRejected({
			runId: run.id,
			actionId,
			owner: context.relay,
			attemptNumber,
			errorCode: error.code,
			errorMessage: error.message,
			evidence: { applied: true, matched: false }
		})
		blockRun(context, currentRun, {
			actionId,
			errorCode: error.code,
			message: error.message,
			retryClass: 'deterministic'
		})
		return { effect, changed: true }
	}
	if (currentRun.phase === 'cancelled' || currentRun.phase === 'completed') {
		if (effect.state === 'dispatched') {
			if (!effect.mayExecute) {
				effect = context.db.markWorkflowEffectFailedBeforeMayExecute({
					runId: run.id,
					actionId,
					owner: context.relay,
					attemptNumber,
					errorCode: errorCode(error, 'workflow_effect_failed'),
					errorMessage: errorMessage(error),
					evidence: cleanUnknown(error)
				})
				return { effect, changed: true }
			}
			let positive: WorkflowEffectReconciliation | undefined
			try {
				positive = await context.deps.reconcileEffect?.(effectReadCall(currentRun, effect, job))
			} catch {
				// Failure to read a receipt is not negative evidence. Preserve ambiguity below.
			}
			if (positive?.status === 'committed') {
				const receipt = cleanUnknown(positive.receipt)
				effect =
					currentRun.phase === 'cancelled'
						? context.db.recordLateWorkflowEffect({
								runId: run.id,
								actionId,
								receipt,
								eventKey: `late-effect-error:${actionId}:${attemptNumber}`
							})
						: context.db.markWorkflowEffectCommitted({
								runId: run.id,
								actionId,
								owner: context.relay,
								attemptNumber,
								receipt
							})
				return { effect, changed: true }
			}
			effect = context.db.markWorkflowEffectAmbiguous({
				runId: run.id,
				actionId,
				owner: context.relay,
				attemptNumber,
				errorCode: errorCode(error, 'ambiguous_effect'),
				errorMessage: errorMessage(error),
				evidence: cleanUnknown(error)
			})
			context.db.activateUiQuarantine({
				actionId: effect.actionId,
				effectId: effect.id,
				reason: effect.errorMessage ?? 'A terminal Workflow has an unresolved UI effect.',
				owner: effect.owner,
				externalProcess: effect.externalProcess
			})
			return { effect, changed: true }
		}
		return { effect, changed: false }
	}
	if (effect.state === 'prepared' && sameRelay(effect.owner, context.relay)) {
		effect = context.db.markWorkflowEffectFailed({
			runId: run.id,
			actionId,
			owner: context.relay,
			attemptNumber,
			errorCode: errorCode(error, 'workflow_effect_failed'),
			errorMessage: errorMessage(error),
			evidence: cleanUnknown(error)
		})
		blockRun(context, currentRun, {
			actionId,
			errorCode: effect.errorCode ?? 'workflow_effect_failed',
			message: effect.errorMessage ?? 'Workflow UI action failed before dispatch.',
			retryClass: preExecutionRetryClass(error)
		})
		return { effect, changed: true }
	}
	if (effect.state === 'dispatched') {
		if (!effect.mayExecute) {
			effect = context.db.markWorkflowEffectFailedBeforeMayExecute({
				runId: run.id,
				actionId,
				owner: context.relay,
				attemptNumber,
				errorCode: errorCode(error, 'workflow_effect_failed'),
				errorMessage: errorMessage(error),
				evidence: cleanUnknown(error)
			})
			blockRun(context, currentRun, {
				actionId,
				errorCode: effect.errorCode ?? 'workflow_effect_failed',
				message: effect.errorMessage ?? 'Workflow external command failed before its private gate opened.',
				retryClass: preExecutionRetryClass(error)
			})
			return { effect, changed: true }
		}
		let positive: WorkflowEffectReconciliation | undefined
		try {
			positive = await context.deps.reconcileEffect?.(effectReadCall(currentRun, effect, job))
		} catch {
			// A failed receipt read cannot make an already-authorized external action safe to replay.
		}
		if (positive?.status === 'committed') {
			effect = context.db.markWorkflowEffectCommitted({
				runId: run.id,
				actionId,
				owner: context.relay,
				attemptNumber,
				receipt: cleanUnknown(positive.receipt),
				eventKey: `effect-positive-after-error:${actionId}:${attemptNumber}`
			})
			return { effect, changed: true }
		}
		effect = context.db.markWorkflowEffectAmbiguous({
			runId: run.id,
			actionId,
			owner: context.relay,
			attemptNumber,
			errorCode: errorCode(error, 'ambiguous_effect'),
			errorMessage: errorMessage(error),
			evidence: cleanUnknown(error)
		})
		quarantineAndBlock(context, currentRun, effect, positive?.status === 'ambiguous' ? positive.candidates : undefined)
		return { effect, changed: true }
	}
	return { effect, changed: false }
}
