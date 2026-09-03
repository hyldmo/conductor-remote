import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useModelCatalog, useModels } from '../hooks.ts'
import { nextEffort } from '../lib/agent.ts'
import { client } from '../lib/api.ts'
import { modelLabel } from '../lib/format.ts'
import { isLockedError } from '../lib/lock.ts'
import type { AgentPatch, Session } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { AgentControls } from './AgentControls.tsx'
import { UnlockLink } from './ui.tsx'

/**
 * Conductor's own composer controls, mirrored for the phone — and rendered
 * *inside* the composer card (Composer.tsx) so the whole thing has one left edge
 * and one border, like the desktop app.
 *
 * Values are read from the DB (durable, like every other read). Changes are
 * **staged, not sent**: pushing one costs a slow, focus-stealing AppleScript trip
 * and only decides what the *next* prompt runs on, so a tap is instant and local,
 * and the send applies it (hooks.ts ▸ `useSendPrompt`) before the prompt goes.
 * A staged control uses the accent colour, and flipping a value back to what
 * Conductor already has drops the staged one rather than queuing a no-op trip.
 */
/** Keep the relay cache useful without leaving a Conductor menu stale all day. */
const MODEL_CATALOG_STALE_MS = 10 * 60 * 1000

/** Nothing staged — a stable identity so the selector can't loop. */
const NOTHING: AgentPatch = {}

/** A staged value only exists while it differs from Conductor's; flipping back clears it. */
function change<T>(next: T, current: T): T | undefined {
	return next === current ? undefined : next
}

export function AgentBar({ session, workspaceId }: { session: Session; workspaceId: string }) {
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
	const liveModels = useModels(session, workspaceId, picking && !cacheFresh)
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
			model={displayedModel}
			providerModel={providerModel}
			agentType={session.agent_type}
			models={models}
			modelPickerOpen={picking}
			onModelPickerOpenChange={setPicking}
			modelsFetching={liveModels.isFetching || modelCatalog.isFetching}
			modelsError={liveModels.isError}
			defaultModel={defaultModel}
			onSetDefaultModel={model => void makeDefault(model)}
			settingDefaultModel={settingDefault}
			fast={fastOn}
			effort={effort}
			plan={planOn}
			modelStaged={staged.model !== undefined}
			fastStaged={staged.fast !== undefined}
			effortStaged={staged.effort !== undefined}
			planStaged={staged.plan !== undefined}
			onModelChange={model => stage({ model: change(model, staged.model) })}
			onFastChange={() => stage({ fast: change(!fastOn, dbFast) })}
			onEffortChange={() => stage({ effort: change(nextEffort(effort), dbEffort) })}
			onPlanChange={() => stage({ plan: change(!planOn, dbPlan) })}
			status={
				defaultError ? (
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
