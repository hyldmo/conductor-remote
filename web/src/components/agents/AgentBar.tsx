import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { modelAgentType } from '../../../../src/shared.ts'
import { useModelCatalog, useModels } from '../../hooks/agents.ts'
import { nextEffort, supportsEffortControl, supportsFastMode, supportsPlanMode } from '../../lib/agent.ts'
import { client } from '../../lib/api.ts'
import { modelLabel } from '../../lib/format.ts'
import { isLockedError } from '../../lib/lock.ts'
import type { AgentPatch, DelegatedRole, PublicFrozenRole, Session, WorkflowRoleName } from '../../lib/types.ts'
import { useApp } from '../../store.ts'
import { WorkflowModePill } from '../orchestration/WorkflowModePill.tsx'
import { UnlockLink } from '../ui.tsx'
import { AgentControls } from './AgentControls.tsx'

/**
 * Conductor's own composer controls, mirrored for the phone — and rendered
 * *inside* the composer card (web/src/components/session/Composer.tsx) so the whole thing has one left edge
 * and one border, like the desktop app.
 *
 * Values are read from the DB (durable, like every other read). Changes are
 * **staged, not sent**: pushing one costs a slow, focus-stealing AppleScript trip
 * and only decides what the *next* prompt runs on, so a tap is instant and local,
 * and the send applies it (hooks/send.ts ▸ `useSendPrompt`) before the prompt goes.
 * A staged control uses the accent colour, and flipping a value back to what
 * Conductor already has drops the staged one rather than queuing a no-op trip.
 */
/** Keep the relay cache useful without leaving a Conductor menu stale all day. */
const MODEL_CATALOG_STALE_MS = 10 * 60 * 1000

/** Nothing staged — a stable identity so the selector can't loop. */
const NOTHING: AgentPatch = {}

/** A staged value only exists while it differs from Conductor's; flipping back clears it. */
function change<T>(next: T, current: unknown): T | undefined {
	return next === current ? undefined : next
}

export interface WorkflowAgentBar {
	active: boolean
	role?: DelegatedRole
	loading: boolean
	problem?: string
	onChange: (active: boolean) => void
}

export interface FrozenWorkflowAgentBar {
	name: WorkflowRoleName
	role: PublicFrozenRole
}

export function AgentBar({
	session,
	workspaceId,
	workflow,
	frozenWorkflow
}: {
	session: Session
	workspaceId: string
	/** Optional start switch on a pristine, unowned chat. */
	workflow?: WorkflowAgentBar
	/** Explicit role ownership from WorkflowRunWire + this session's assignment. */
	frozenWorkflow?: FrozenWorkflowAgentBar
}) {
	const [picking, setPicking] = useState(false)
	const [settingDefault, setSettingDefault] = useState<string>()
	const [defaultError, setDefaultError] = useState<string>()
	const staged = useApp(s => s.agentDrafts[session.id]) ?? NOTHING
	const stageAgent = useApp(s => s.stageAgent)
	const queryClient = useQueryClient()
	// A send in flight is what pushes the staged settings. The controls stay live
	// through it — anything changed mid-send simply stages for the next one, which
	// the store's key-wise `clearAgentDraft` is what makes safe.
	const sending = useApp(s => s.pending.some(p => p.sessionId === session.id && p.status === 'sending'))
	const modelCatalog = useModelCatalog()
	const cachedGroup = modelCatalog.data?.groups.find(group => group.agentType === (session.agent_type ?? 'unknown'))
	// Caches written before default-model support have labels but no starred row;
	// refresh those once instead of drawing a picker full of unstarred choices.
	const cacheFresh = !!cachedGroup?.defaultModel && Date.now() - cachedGroup.updatedAt < MODEL_CATALOG_STALE_MS
	const workflowRole = frozenWorkflow?.role ?? (workflow?.active ? workflow.role : undefined)
	const roleFrozen = !!workflowRole
	const workflowAgentType =
		frozenWorkflow?.role.agentType ?? (workflowRole ? modelAgentType(workflowRole.model) : undefined)
	const liveModels = useModels(session, workspaceId, picking && !roleFrozen && !cacheFresh)
	const models = liveModels.data?.models ?? cachedGroup?.models ?? []
	const defaultModel = liveModels.data?.defaultModel ?? modelCatalog.data?.defaultModel ?? cachedGroup?.defaultModel

	const stage = (patch: AgentPatch) => stageAgent(session.id, patch)

	const dbEffort = session.claude_effort_level ?? undefined
	const dbPlan = session.permission_mode === 'plan'
	const dbFast = Boolean(session.fast_mode)
	const effort = staged.effort ?? dbEffort
	const planOn = staged.plan ?? dbPlan
	const fastOn = staged.fast ?? dbFast
	const anyStaged = Object.keys(staged).length > 0
	// Named off the picker's own labels when they're loaded: the id says `opus-5-1m`
	// where Conductor's menu says "Opus 5", and a pill that disagrees with the menu
	// also leaves the open picker with no row checked.
	const displayedModel = staged.model ?? (modelLabel(session.model, models) || 'Model')
	const providerModel = staged.model ?? session.model
	const planAvailable = supportsPlanMode(session.agent_type, providerModel)
	const effortAvailable = supportsEffortControl(session.agent_type, providerModel)
	const fastAvailable = supportsFastMode(session.agent_type, providerModel)
	const workflowModel = workflowRole?.model ?? 'Planning role'

	// Ownership can arrive from another phone while this picker is open. Closing it
	// makes the frozen tuple effective immediately instead of leaving selectable rows
	// behind a newly disabled trigger.
	useEffect(() => {
		if (roleFrozen) setPicking(false)
	}, [roleFrozen])

	// A Plan choice can survive in synced/local drafts after switching away from
	// Claude. Drop it as soon as the effective model no longer has Conductor's
	// control, or the invisible patch would make the next send fail in AppleScript.
	useEffect(() => {
		if (roleFrozen) return
		if (!planAvailable && staged.plan !== undefined) stageAgent(session.id, { plan: undefined })
	}, [roleFrozen, planAvailable, session.id, staged.plan, stageAgent])

	// Provider switches can leave an invisible staged setting behind. Cursor and
	// OpenCode have no matching controls, so never carry those settings into send.
	useEffect(() => {
		if (roleFrozen) return
		if (!effortAvailable && staged.effort !== undefined) stageAgent(session.id, { effort: undefined })
		if (!fastAvailable && staged.fast !== undefined) stageAgent(session.id, { fast: undefined })
	}, [roleFrozen, effortAvailable, fastAvailable, session.id, staged.effort, staged.fast, stageAgent])

	// Once the coordinator owns this session, stale phone choices cannot ride a
	// later prompt and fight the frozen role. Plan is intentionally independent.
	useEffect(() => {
		if (!frozenWorkflow) return
		if (staged.model !== undefined) stageAgent(session.id, { model: undefined })
		if (staged.effort !== undefined) stageAgent(session.id, { effort: undefined })
		if (staged.fast !== undefined) stageAgent(session.id, { fast: undefined })
	}, [frozenWorkflow, session.id, staged.model, staged.effort, staged.fast, stageAgent])

	const makeDefault = async (model: string) => {
		if (settingDefault) return
		setSettingDefault(model)
		setDefaultError(undefined)
		try {
			const result = await client.setDefaultModel(session.id, model, workspaceId)
			if (!result.ok) throw new Error(result.error ?? 'could not set the default model')
			// Conductor's star is "set default and select", so it supersedes any model
			// staged before the star was tapped. Preserve the other staged controls.
			stageAgent(session.id, { model: undefined })
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ['model-catalog'] }),
				queryClient.invalidateQueries({ queryKey: ['sessions', workspaceId] }),
				queryClient.invalidateQueries({ queryKey: ['state'] })
			])
		} catch (error) {
			setDefaultError(error instanceof Error ? error.message : 'could not set the default model')
		} finally {
			setSettingDefault(undefined)
		}
	}

	return (
		<AgentControls
			model={roleFrozen ? workflowModel : displayedModel}
			providerModel={roleFrozen ? (workflowRole?.model ?? null) : providerModel}
			agentType={roleFrozen ? (workflowAgentType ?? null) : session.agent_type}
			models={models}
			modelPickerOpen={picking}
			onModelPickerOpenChange={setPicking}
			modelsFetching={liveModels.isFetching || modelCatalog.isFetching}
			modelsError={liveModels.isError}
			defaultModel={defaultModel}
			onSetDefaultModel={model => void makeDefault(model)}
			settingDefaultModel={settingDefault}
			fast={roleFrozen ? workflowRole?.fast : fastOn}
			effort={roleFrozen ? workflowRole?.effort : effort}
			plan={planOn}
			planAvailable={planAvailable}
			showEmptyEffort={roleFrozen}
			modelStaged={!roleFrozen && staged.model !== undefined}
			fastStaged={!roleFrozen && staged.fast !== undefined}
			effortStaged={!roleFrozen && staged.effort !== undefined}
			planStaged={staged.plan !== undefined}
			onModelChange={model => stage({ model: change(model, staged.model) })}
			onFastChange={() => stage({ fast: change(!fastOn, dbFast) })}
			onEffortChange={() => stage({ effort: change(nextEffort(effort), dbEffort) })}
			onPlanChange={() => stage({ plan: change(!planOn, dbPlan) })}
			freezeAgent={roleFrozen}
			beforeModel={
				workflow ? (
					<WorkflowModePill
						active={workflow.active}
						onChange={active => {
							setPicking(false)
							workflow.onChange(active)
						}}
					/>
				) : undefined
			}
			status={
				frozenWorkflow ? (
					`${frozenWorkflow.name} role frozen by Workflow`
				) : workflow?.active ? (
					workflow.problem ? (
						<span className="text-del">{workflow.problem}</span>
					) : workflow.loading ? (
						'Loading Workflow roles…'
					) : (
						'Planning root · one explorer is guaranteed after acceptance'
					)
				) : defaultError ? (
					<span className="text-del">
						{defaultError}
						{isLockedError(defaultError) ? <UnlockLink className="ml-1" /> : null}
					</span>
				) : settingDefault ? (
					'Setting default and selecting…'
				) : anyStaged ? (
					sending ? (
						'Applying…'
					) : (
						'Applies when you send'
					)
				) : undefined
			}
		/>
	)
}
