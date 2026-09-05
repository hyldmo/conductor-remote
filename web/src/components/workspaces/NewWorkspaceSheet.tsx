import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { modelAgentType } from '../../../../src/shared.ts'
import { useModelCatalog, useModelDefaults, useWorkflowRoleReadiness } from '../../hooks/agents.ts'
import { useStartWorkflow } from '../../hooks/workflows.ts'
import { useRepos } from '../../hooks/workspaces.ts'
import {
	defaultEffortForModel,
	nextEffortOverride,
	supportsEffortControl,
	supportsFastMode,
	supportsPlanMode
} from '../../lib/agent.ts'
import { client } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { enterSubmits } from '../../lib/keys.ts'
import { requestPrefsFlush } from '../../lib/prefs.ts'
import { NEW_WORKSPACE_DRAFT } from '../../lib/prompts/draft.ts'
import { type NewWorkspaceRepoStatus, newWorkspaceDisabledReason } from '../../lib/prompts/new-workspace.ts'
import { workflowStartFingerprint } from '../../lib/prompts/pending.ts'
import type { AgentPatch, DraftAttachment } from '../../lib/types.ts'
import { useApp } from '../../store.ts'
import { AgentControls } from '../agents/AgentControls.tsx'
import { WorkflowModePill } from '../orchestration/WorkflowModePill.tsx'
import {
	AttachmentPickerButton,
	AttachmentTray,
	EMPTY_ATTACHMENTS,
	useAttachmentUploads
} from '../session/AttachmentUploads.tsx'
import { RepoAvatar } from '../ui.tsx'

/** The "Send immediately" choice, remembered for next time — a preference, not state. */
const SEND_NOW_KEY = 'conductor-remote-send-immediately'

function loadSendNow(): boolean {
	try {
		// Absent means on: it is the default, and the old behaviour is what you opt into.
		return localStorage.getItem(SEND_NOW_KEY) !== 'off'
	} catch {
		return true
	}
}

function saveSendNow(on: boolean): void {
	try {
		localStorage.setItem(SEND_NOW_KEY, on ? 'on' : 'off')
	} catch {}
}

function discardAttachment(stageId: string | undefined): void {
	if (stageId) void client.discardStagedAttachment(stageId).catch(() => undefined)
}

/**
 * Start new work from the phone — the one action that previously needed the Mac.
 *
 * Conductor's deep-link scheme creates the workspace (no Accessibility, no
 * keystrokes) but only *pre-fills* the composer, and the worktree then takes
 * however long it takes — measured at 30s+ on a real repo, past the phone's own
 * request budget. So the relay returns as soon as the row exists and delivers the
 * prompt itself (src/delivery/firstprompt.ts): a slow repo shows a real workspace filling in
 * rather than a spinner, and the prompt still goes if the phone is locked, closed,
 * or off the network by then. This screen's job ends at the response; the chat shows
 * the prompt until it lands.
 *
 * **Send immediately** is that delivery's one dial, and it is on because Conductor
 * is: its own New workspace box starts the agent 4-9s after the row exists, with the
 * setup script still running. An attached prompt waits only until there is a worktree
 * to hold its files. Turning it off holds every prompt until the worktree is built,
 * which is worth it only where the agent's first move needs what setup installs. Kept
 * in localStorage rather than on the relay — it is this phone's habit, and it has to
 * survive the relay updating itself underneath the app.
 */
export function NewWorkspaceSheet({ onClose }: { onClose: () => void }) {
	const reposQuery = useRepos()
	const { data } = reposQuery
	const modelCatalog = useModelCatalog()
	const modelDefaults = useModelDefaults()
	const { roles, planningRole, problem: workflowProblem, ready: workflowReady } = useWorkflowRoleReadiness()
	const lastNewWorkspaceRepo = useApp(s => s.lastNewWorkspaceRepo)
	const setLastNewWorkspaceRepo = useApp(s => s.setLastNewWorkspaceRepo)
	const [repo, setRepo] = useState(lastNewWorkspaceRepo)
	// The prompt is a draft in the store, not state here: this sheet unmounts the
	// moment it is closed, and the text has to outlive that (see lib/prompts/draft.ts).
	const prompt = useApp(s => s.drafts[NEW_WORKSPACE_DRAFT] ?? '')
	const draftAttachments = useApp(s => s.draftAttachments[NEW_WORKSPACE_DRAFT] ?? EMPTY_ATTACHMENTS)
	// Only pre-workspace uploads can seed a new worktree. Ignore a malformed or
	// legacy descriptor without its staging id rather than drawing a pill we cannot send.
	const readyAttachments = useMemo(
		() =>
			draftAttachments.filter(
				(attachment): attachment is DraftAttachment & { stageId: string } => !!attachment.stageId
			),
		[draftAttachments]
	)
	const setDraft = useApp(s => s.setDraft)
	const addDraftAttachment = useApp(s => s.addDraftAttachment)
	const removeDraftAttachment = useApp(s => s.removeDraftAttachment)
	const clearDraftContent = useApp(s => s.clearDraftContent)
	const workflowClientId = useApp(s => s.workflowClientId)
	const finishWorkflowAttempt = useApp(s => s.finishWorkflowAttempt)
	const setFocusedDraft = useApp(s => s.setFocusedDraft)
	const setPrompt = (text: string) => setDraft(NEW_WORKSPACE_DRAFT, text)
	const [agent, setAgent] = useState<AgentPatch>({})
	const [workflowMode, setWorkflowMode] = useState(false)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [sendNow, setSendNow] = useState(loadSendNow)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const startWorkflow = useStartWorkflow()
	const online = useApp(s => s.online)
	const attachmentUploads = useAttachmentUploads({
		draftKey: NEW_WORKSPACE_DRAFT,
		ready: readyAttachments,
		enabled: online,
		upload: async (_draftKey, file) => (await client.stageAttachment(file)).attachment,
		accept: addDraftAttachment,
		removeReady: removeDraftAttachment,
		discard: attachment => discardAttachment(attachment.stageId)
	})
	const cancelPendingUploads = attachmentUploads.cancelPending

	useEffect(
		() => () => {
			if (useApp.getState().focusedDraft === NEW_WORKSPACE_DRAFT) setFocusedDraft(null)
			requestPrefsFlush()
		},
		[setFocusedDraft]
	)

	const repos = data?.repos ?? []
	const selected = repos.find(r => r.name === repo)
	// Use the last choice when it still exists. Otherwise pick the first repo so
	// "path" is always explicit — an unmatched or missing path silently lands the
	// workspace in whichever repo Conductor lists first.
	useEffect(() => {
		if (repos.length && !repos.some(r => r.name === repo)) setRepo(repos[0].name)
	}, [repo, repos])

	const uploading = attachmentUploads.uploading
	const attachmentError = attachmentUploads.hasError
	const hasInitialPrompt = !!prompt.trim() || readyAttachments.length > 0
	const models = modelCatalog.data?.groups.flatMap(group => group.models) ?? []
	const defaultModel = modelCatalog.data?.defaultModel
	const repoStatus: NewWorkspaceRepoStatus = selected
		? 'selected'
		: reposQuery.isLoading
			? 'loading'
			: reposQuery.isError
				? 'error'
				: repos.length === 0
					? 'empty'
					: 'required'
	const disabledReason = newWorkspaceDisabledReason({
		online,
		repoStatus,
		uploading,
		attachmentError,
		workflowMode,
		hasInitialPrompt,
		workflowReady,
		workflowLoading: roles.isLoading,
		workflowProblem
	})
	const createDisabled = busy || disabledReason !== null
	const ordinaryModel = agent.model ?? defaultModel ?? null
	const selectedModel = workflowMode ? (planningRole?.model ?? 'Planning role') : ordinaryModel
	const planAvailable = supportsPlanMode(null, ordinaryModel)
	const effortAvailable = supportsEffortControl(null, ordinaryModel)
	const fastAvailable = supportsFastMode(null, ordinaryModel)
	// Draw the value this model will inherit without putting it in `agent`: an empty
	// patch is what lets Conductor own the default when the workspace is created.
	const inheritedEffort = defaultEffortForModel(ordinaryModel, modelDefaults.data?.defaultEfforts)
	const displayedEffort = workflowMode ? planningRole?.effort : (agent.effort ?? inheritedEffort)
	const anyAgentChoice = Object.keys(agent).length > 0
	const stageAgent = useCallback(
		(patch: AgentPatch) =>
			setAgent(current => {
				const next = { ...current, ...patch }
				return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as AgentPatch
			}),
		[]
	)

	// A user can enable Plan on Claude and then pick another provider. Remove the
	// now-hidden choice so workspace creation never carries an option Conductor
	// cannot apply. Workflow leaves that ordinary composer choice staged and
	// independent while its own frozen planning tuple is on screen.
	useEffect(() => {
		if (workflowMode) return
		if (!planAvailable && agent.plan !== undefined) stageAgent({ plan: undefined })
	}, [workflowMode, planAvailable, agent.plan, stageAgent])

	useEffect(() => {
		if (!effortAvailable && agent.effort !== undefined) stageAgent({ effort: undefined })
		if (!fastAvailable && agent.fast !== undefined) stageAgent({ fast: undefined })
	}, [agent.effort, agent.fast, effortAvailable, fastAvailable, stageAgent])

	// Ready files are part of the synced draft and survive this sheet. An upload still
	// in flight has no durable reference yet, so cancel it and discard its late result.
	const close = useCallback(() => {
		cancelPendingUploads()
		onClose()
	}, [cancelPendingUploads, onClose])

	const create = async () => {
		const text = prompt.trim()
		if (createDisabled) return
		setBusy(true)
		setError(null)
		try {
			if (workflowMode) {
				const objective = [...readyAttachments.map(attachment => attachment.token), text].filter(Boolean).join('\n')
				const target = { kind: 'new_workspace' as const, repo, sendImmediately: sendNow }
				const attemptKey = 'workflow:new-workspace'
				const clientId = workflowClientId(attemptKey, workflowStartFingerprint(objective, target))
				const response = await startWorkflow({ clientId, objective, target })
				// A 202 means the relay durably owns the objective and staged attachment
				// references. Until then this synced draft remains the only safe copy.
				clearDraftContent(NEW_WORKSPACE_DRAFT)
				finishWorkflowAttempt(attemptKey, clientId)
				onClose()
				if (response.workflow.workspaceId) navigate(`/w/${response.workflow.workspaceId}`)
				return
			}
			const r = await client.createWorkspace({
				repo,
				prompt: text,
				sendImmediately: sendNow,
				attachmentIds: readyAttachments.flatMap(attachment => (attachment.stageId ? [attachment.stageId] : [])),
				...agent
			})
			if (!r.ok || !r.workspaceId) {
				setError(r.error ?? 'could not create the workspace')
				return
			}
			// ['state'] is the workspace-list query — an invalidate on any other key silently
			// does nothing and the new workspace only shows up on the next 2.5s poll.
			await queryClient.invalidateQueries({ queryKey: ['state'] })
			// The relay owns the prompt now (src/delivery/firstprompt.ts) and the new chat shows it,
			// so this is the one exit that drops the draft. Closing keeps it.
			clearDraftContent(NEW_WORKSPACE_DRAFT)
			onClose()
			navigate(`/w/${r.workspaceId}`)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'could not create the workspace')
		} finally {
			setBusy(false)
		}
	}

	// Escape is the desktop way out, and the repo picker eats it first: one press
	// should never both close the picker and throw away the typed prompt. Bound to the
	// window rather than to the sheet, since focus can sit on a button or on nothing.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			if (pickerOpen) setPickerOpen(false)
			else close()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [close, pickerOpen])

	// Portalled to <body> for the same reason as ConnectSheet/LogsSheet: the drawer <aside> it's
	// opened from has a `transform`, which would make `fixed inset-0` mean "the drawer", not "the screen".
	return createPortal(
		<div className="fixed inset-0 z-50 flex flex-col bg-bg">
			<header className="pt-safe flex items-center gap-2 border-b border-border-soft px-3 pb-2.5">
				<span className="flex-1 text-[15px] font-semibold">New workspace</span>
				<button
					type="button"
					onClick={close}
					aria-label="Close"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
				<div className="relative">
					<button
						type="button"
						onClick={() => setPickerOpen(o => !o)}
						aria-haspopup="menu"
						aria-expanded={pickerOpen}
						className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 text-left transition active:bg-surface-2"
					>
						{selected ? <RepoAvatar icon={selected.icon} name={selected.name} artwork="inset" /> : null}
						<span className="min-w-0 flex-1 truncate text-[15px] font-medium">{selected?.name ?? 'Choose a repo'}</span>
						<ChevronDown size={18} className={cn('shrink-0 text-muted transition', pickerOpen && 'rotate-180')} />
					</button>
					{pickerOpen ? (
						<ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-2xl border border-border bg-surface py-1 shadow-xl">
							{repos.map(r => (
								<li key={r.name}>
									<button
										type="button"
										onClick={() => {
											setRepo(r.name)
											setLastNewWorkspaceRepo(r.name)
											setPickerOpen(false)
										}}
										className="flex w-full items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
									>
										<RepoAvatar icon={r.icon} name={r.name} artwork="inset" />
										<span className="min-w-0 flex-1 truncate text-[15px]">{r.name}</span>
										{r.name === repo ? <Check size={16} className="shrink-0 text-accent" /> : null}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
				<fieldset
					aria-label="First message"
					{...attachmentUploads.dropTargetProps}
					className={cn(
						'relative m-0 min-w-0 rounded-2xl border border-border bg-surface p-2 has-[textarea:focus]:border-accent/60',
						attachmentUploads.dragging && 'border-accent bg-accent-soft'
					)}
				>
					<AttachmentTray uploads={attachmentUploads} />
					<textarea
						value={prompt}
						onChange={e => setPrompt(e.target.value)}
						onFocus={() => setFocusedDraft(NEW_WORKSPACE_DRAFT)}
						onBlur={() => {
							if (useApp.getState().focusedDraft === NEW_WORKSPACE_DRAFT) setFocusedDraft(null)
							requestPrefsFlush()
						}}
						placeholder={workflowMode ? 'What should the workflow accomplish?' : 'What should the agent do? (optional)'}
						rows={6}
						// biome-ignore lint/a11y/noAutofocus: the sheet exists only to type this
						autoFocus
						// text-base or iOS auto-zooms on focus and won't zoom back out (see Composer).
						className="block w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-faint"
						onPaste={attachmentUploads.onPaste}
						// The same rule as the chat composer (lib/keys.ts): Enter creates on a
						// hardware keyboard, breaks the line on a touch one, and an IME's own
						// Enter (picking a candidate) never creates the workspace.
						onKeyDown={e => {
							if (enterSubmits(e)) {
								e.preventDefault()
								void create()
							}
						}}
					/>
					<div className="mt-1 flex items-start gap-1 px-1">
						<AgentControls
							model={selectedModel ?? 'Model'}
							providerModel={workflowMode ? (planningRole?.model ?? null) : selectedModel}
							agentType={workflowMode && planningRole ? (modelAgentType(planningRole.model) ?? null) : null}
							models={models}
							modelsFetching={modelCatalog.isFetching}
							modelsError={modelCatalog.isError}
							defaultModel={defaultModel}
							fast={workflowMode ? planningRole?.fast : agent.fast}
							effort={displayedEffort}
							plan={agent.plan}
							planAvailable={planAvailable}
							showEmptyEffort
							modelStaged={!workflowMode && agent.model !== undefined}
							fastStaged={!workflowMode && agent.fast !== undefined}
							effortStaged={!workflowMode && agent.effort !== undefined}
							planStaged={agent.plan !== undefined}
							onModelChange={model =>
								stageAgent({ model: model === (agent.model ?? defaultModel) ? undefined : model })
							}
							onFastChange={() =>
								stageAgent({ fast: agent.fast === undefined ? true : agent.fast ? false : undefined })
							}
							onEffortChange={() => stageAgent({ effort: nextEffortOverride(displayedEffort, inheritedEffort) })}
							onPlanChange={() =>
								stageAgent({ plan: agent.plan === undefined ? true : agent.plan ? false : undefined })
							}
							freezeAgent={workflowMode}
							beforeModel={
								<WorkflowModePill
									active={workflowMode}
									onChange={active => {
										setWorkflowMode(active)
										setError(null)
									}}
								/>
							}
							status={
								workflowMode
									? workflowReady
										? 'Planning role frozen for this Workflow'
										: roles.isLoading
											? 'Loading Workflow roles…'
											: undefined
									: anyAgentChoice
										? 'Applies when the workspace opens'
										: undefined
							}
						/>
						<AttachmentPickerButton uploads={attachmentUploads} disabled={!online} />
					</div>
					{workflowMode && workflowProblem ? <div className="px-2 pb-1 text-xs text-del">{workflowProblem}</div> : null}
				</fieldset>
				{/* A real checkbox behind a drawn one: the whole row is the tap target, and the
				    box keeps its keyboard and VoiceOver behaviour. Disabled with no first message
				    rather than hidden, or it would reflow the sheet under your thumb as you type. */}
				<label
					className={cn(
						'flex items-start gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 transition active:bg-surface-2',
						!hasInitialPrompt && 'opacity-40'
					)}
				>
					<input
						type="checkbox"
						checked={sendNow}
						disabled={!hasInitialPrompt}
						onChange={e => {
							setSendNow(e.target.checked)
							saveSendNow(e.target.checked)
						}}
						className="sr-only"
					/>
					<span
						className={cn(
							'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-md border transition',
							sendNow ? 'border-accent bg-accent text-bg' : 'border-border'
						)}
					>
						{sendNow ? <Check size={13} strokeWidth={3} /> : null}
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-[15px] font-medium">Send immediately</span>
						<span className="block text-xs text-muted">
							{sendNow
								? 'The prompt goes as soon as the chat and attached files are ready, without waiting for setup.'
								: 'The prompt waits until the worktree has finished setting up.'}
						</span>
					</span>
				</label>
				{error ? <div className="text-xs text-del">{error}</div> : null}
			</div>

			<div className="pb-safe border-t border-border-soft p-3">
				<div className="mb-2 min-h-4 text-center text-xs leading-4 text-muted" aria-live="polite">
					{disabledReason ? <span id="new-workspace-create-reason">{disabledReason}</span> : null}
				</div>
				<button
					type="button"
					onClick={create}
					disabled={createDisabled}
					aria-describedby={disabledReason ? 'new-workspace-create-reason' : undefined}
					className="w-full rounded-2xl bg-accent px-4 py-3 text-[15px] font-semibold text-bg transition active:scale-[0.985] disabled:opacity-40"
				>
					{busy
						? workflowMode
							? 'Starting workflow…'
							: 'Creating…'
						: workflowMode
							? 'Start workflow'
							: hasInitialPrompt
								? 'Create & start'
								: 'Create empty workspace'}
				</button>
			</div>
		</div>,
		document.body
	)
}
