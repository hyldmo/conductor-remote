import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { modelAgentType } from '../../../src/shared.ts'
import { useModelCatalog, useModelDefaults, useRepos, useRoles } from '../hooks.ts'
import { defaultEffortForModel, nextEffortOverride, supportsPlanMode } from '../lib/agent.ts'
import { client } from '../lib/api.ts'
import { cn } from '../lib/cn.ts'
import { NEW_WORKSPACE_DRAFT } from '../lib/draft.ts'
import { enterSubmits } from '../lib/keys.ts'
import { requestPrefsFlush } from '../lib/prefs.ts'
import type { AgentPatch, DraftAttachment } from '../lib/types.ts'
import { useApp } from '../store.ts'
import { AgentControls } from './AgentControls.tsx'
import { RepoAvatar } from './ui.tsx'
import { WorkflowModePill } from './WorkflowModePill.tsx'

/** The "Send immediately" choice, remembered for next time — a preference, not state. */
const SEND_NOW_KEY = 'conductor-remote-send-immediately'

type PendingAttachment = {
	id: string
	name: string
	status: 'uploading' | 'error'
	error?: string
}

type DisplayAttachment = (DraftAttachment & { id: string; status: 'ready'; error?: never }) | PendingAttachment

const NO_ATTACHMENTS: DraftAttachment[] = []

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
 * prompt itself (src/firstprompt.ts): a slow repo shows a real workspace filling in
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
	const { data } = useRepos()
	const modelCatalog = useModelCatalog()
	const modelDefaults = useModelDefaults()
	const roles = useRoles()
	const lastNewWorkspaceRepo = useApp(s => s.lastNewWorkspaceRepo)
	const setLastNewWorkspaceRepo = useApp(s => s.setLastNewWorkspaceRepo)
	const [repo, setRepo] = useState(lastNewWorkspaceRepo)
	// The prompt is a draft in the store, not state here: this sheet unmounts the
	// moment it is closed, and the text has to outlive that (see lib/draft.ts).
	const prompt = useApp(s => s.drafts[NEW_WORKSPACE_DRAFT] ?? '')
	const draftAttachments = useApp(s => s.draftAttachments[NEW_WORKSPACE_DRAFT] ?? NO_ATTACHMENTS)
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
	const setFocusedDraft = useApp(s => s.setFocusedDraft)
	const setPrompt = (text: string) => setDraft(NEW_WORKSPACE_DRAFT, text)
	const [agent, setAgent] = useState<AgentPatch>({})
	const [workflowMode, setWorkflowMode] = useState(false)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [sendNow, setSendNow] = useState(loadSendNow)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const fileInput = useRef<HTMLInputElement>(null)
	const cancelledUploads = useRef(new Set<string>())
	const dragDepth = useRef(0)
	const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
	const [draggingFiles, setDraggingFiles] = useState(false)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const online = useApp(s => s.online)

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

	const attachments: DisplayAttachment[] = [
		...readyAttachments.map(attachment => ({ ...attachment, id: attachment.path, status: 'ready' as const })),
		...pendingAttachments
	]
	const uploading = pendingAttachments.some(attachment => attachment.status === 'uploading')
	const attachmentError = pendingAttachments.some(attachment => attachment.status === 'error')
	const hasInitialPrompt = !!prompt.trim() || readyAttachments.length > 0
	const models = modelCatalog.data?.groups.flatMap(group => group.models) ?? []
	const defaultModel = modelCatalog.data?.defaultModel
	const planningRole = roles.data?.roles.planning
	const planningIssue = roles.data?.issues.find(issue => issue.role === 'planning')
	const workflowProblem = roles.isError
		? 'Could not load delegated roles.'
		: roles.data?.warning
			? roles.data.warning
			: roles.data && !planningRole
				? 'Workflow mode needs a configured planning role.'
				: planningIssue?.error.message
	const workflowReady = !!planningRole && !workflowProblem
	const ordinaryModel = agent.model ?? defaultModel ?? null
	const selectedModel = workflowMode ? (planningRole?.model ?? 'Planning role') : ordinaryModel
	const planAvailable = supportsPlanMode(null, ordinaryModel)
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
	// cannot apply.
	useEffect(() => {
		if (!planAvailable && agent.plan !== undefined) stageAgent({ plan: undefined })
	}, [planAvailable, agent.plan, stageAgent])

	const removeAttachment = (id: string) => {
		const attachment = readyAttachments.find(current => current.path === id)
		if (attachment) {
			removeDraftAttachment(NEW_WORKSPACE_DRAFT, attachment.path)
			// Keep the bytes through the sync window: another offline/focused device may
			// still hold this revision. The relay reclaims an unreferenced copy after a week.
			return
		}
		cancelledUploads.current.add(id)
		setPendingAttachments(current => current.filter(attachment => attachment.id !== id))
	}

	const addFiles = async (picked: FileList | File[]) => {
		if (!online) return
		for (const file of Array.from(picked)) {
			const id = crypto.randomUUID()
			setPendingAttachments(current => [...current, { id, name: file.name || 'attachment', status: 'uploading' }])
			try {
				const uploaded = await client.stageAttachment(file)
				if (cancelledUploads.current.delete(id)) {
					discardAttachment(uploaded.attachment.stageId)
					continue
				}
				addDraftAttachment(NEW_WORKSPACE_DRAFT, uploaded.attachment)
				setPendingAttachments(current => current.filter(attachment => attachment.id !== id))
			} catch (err) {
				if (cancelledUploads.current.delete(id)) continue
				setPendingAttachments(current =>
					current.map(attachment =>
						attachment.id === id
							? { ...attachment, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
							: attachment
					)
				)
			}
		}
	}

	const chooseFiles = (files: FileList | null) => {
		if (files?.length) void addFiles(files)
	}

	const isFileDrag = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes('Files')

	const dragEnter = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		dragDepth.current += 1
		setDraggingFiles(true)
	}

	const dragLeave = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		dragDepth.current -= 1
		if (dragDepth.current <= 0) {
			dragDepth.current = 0
			setDraggingFiles(false)
		}
	}

	const dragOver = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		event.dataTransfer.dropEffect = 'copy'
	}

	const drop = (event: React.DragEvent<HTMLElement>) => {
		if (!isFileDrag(event)) return
		event.preventDefault()
		dragDepth.current = 0
		setDraggingFiles(false)
		chooseFiles(event.dataTransfer.files)
	}

	// Ready files are part of the synced draft and survive this sheet. An upload still
	// in flight has no durable reference yet, so cancel it and discard its late result.
	const close = useCallback(() => {
		for (const attachment of pendingAttachments) {
			cancelledUploads.current.add(attachment.id)
		}
		onClose()
	}, [pendingAttachments, onClose])

	const create = async () => {
		const text = prompt.trim()
		if (
			!repo ||
			busy ||
			uploading ||
			attachmentError ||
			!online ||
			(workflowMode && (!hasInitialPrompt || !workflowReady))
		)
			return
		setBusy(true)
		setError(null)
		try {
			const r = await client.createWorkspace({
				repo,
				prompt: text,
				sendImmediately: sendNow,
				attachmentIds: readyAttachments.flatMap(attachment => (attachment.stageId ? [attachment.stageId] : [])),
				...(workflowMode ? { workflow: true } : agent)
			})
			if (!r.ok || !r.workspaceId) {
				setError(r.error ?? 'could not create the workspace')
				return
			}
			// ['state'] is the workspace-list query — an invalidate on any other key silently
			// does nothing and the new workspace only shows up on the next 2.5s poll.
			await queryClient.invalidateQueries({ queryKey: ['state'] })
			// The relay owns the prompt now (src/firstprompt.ts) and the new chat shows it,
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
					onDragEnter={dragEnter}
					onDragLeave={dragLeave}
					onDragOver={dragOver}
					onDrop={drop}
					className={cn(
						'relative m-0 min-w-0 rounded-2xl border border-border bg-surface p-2 has-[textarea:focus]:border-accent/60',
						draggingFiles && 'border-accent bg-accent-soft'
					)}
				>
					<input
						ref={fileInput}
						type="file"
						multiple
						className="hidden"
						onChange={event => {
							chooseFiles(event.target.files)
							event.target.value = ''
						}}
					/>
					{attachments.length ? (
						<div className="flex flex-wrap gap-1 px-2 pb-1">
							{attachments.map(attachment => (
								<div
									key={attachment.id}
									title={attachment.error ?? attachment.name}
									className="flex max-w-full items-center gap-1 rounded-lg bg-surface-2 py-1 pl-2 pr-1 text-xs text-muted"
								>
									{attachment.status === 'uploading' ? (
										<LoaderCircle size={12} className="shrink-0 animate-spin" />
									) : null}
									<span className="truncate">
										{attachment.status === 'error' ? `${attachment.name}: ${attachment.error}` : attachment.name}
									</span>
									<button
										type="button"
										onClick={() => removeAttachment(attachment.id)}
										aria-label={`Remove ${attachment.name}`}
										className="flex size-5 shrink-0 items-center justify-center rounded active:bg-surface"
									>
										<X size={13} />
									</button>
								</div>
							))}
						</div>
					) : null}
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
						onPaste={event => {
							const files = event.clipboardData.files
							if (!files.length) return
							event.preventDefault()
							chooseFiles(files)
						}}
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
							plan={workflowMode ? undefined : agent.plan}
							showEmptyEffort
							modelStaged={!workflowMode && agent.model !== undefined}
							fastStaged={!workflowMode && agent.fast !== undefined}
							effortStaged={!workflowMode && agent.effort !== undefined}
							planStaged={!workflowMode && agent.plan !== undefined}
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
							disabled={workflowMode}
							hidePlan={workflowMode}
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
										? 'Planning root · delegates configured roles into sibling chats'
										: roles.isLoading
											? 'Loading the planning role…'
											: undefined
									: anyAgentChoice
										? 'Applies when the workspace opens'
										: undefined
							}
						/>
						<button
							type="button"
							onClick={() => fileInput.current?.click()}
							disabled={!online}
							aria-label="Attach files"
							className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition active:bg-surface-2 active:text-text disabled:text-faint"
						>
							<Paperclip size={17} />
						</button>
					</div>
					{workflowMode && workflowProblem ? <div className="px-2 pb-1 text-xs text-del">{workflowProblem}</div> : null}
					{draggingFiles ? (
						<div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border border-dashed border-accent bg-accent-soft/90 text-sm font-medium text-accent">
							Drop files to attach
						</div>
					) : null}
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
				<button
					type="button"
					onClick={create}
					disabled={
						!repo ||
						busy ||
						uploading ||
						attachmentError ||
						!online ||
						(workflowMode && (!hasInitialPrompt || !workflowReady))
					}
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
