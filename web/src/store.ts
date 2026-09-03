import { create } from 'zustand'
import { bootstrapToken, clearToken, setStoredToken } from './lib/api.ts'
import { offlineDelay } from './lib/online.ts'
import { loadPending, type PendingMessage, writePending } from './lib/pending.ts'
import {
	type LocalPrefsProjection,
	loadLocalPrefs,
	moveLocalDraft,
	setLocalAgent,
	setLocalAttachments,
	setLocalDraft,
	setLocalDraftContent,
	setLocalReadMark
} from './lib/prefs.ts'
import type { ReadMarks } from './lib/read.ts'
import type { AgentPatch, DraftAttachment, UpdateStatus } from './lib/types.ts'

let offlineTimer: ReturnType<typeof setTimeout> | null = null
const initialPrefs = loadLocalPrefs()
export const WORKING_HINT_MS = 15_000

/**
 * Sidebar view preferences — grouping and filtering mirror the desktop app's
 * popover, with phone-only row presentation kept here too. `recent` has no
 * desktop equivalent: day buckets (Today / Yesterday / …) for reaching the chat
 * you left a minute ago.
 */
export type GroupBy = 'status' | 'repo' | 'recent' | 'none'
export type SortBy = 'updated' | 'created' | 'name'
export interface ViewPrefs {
	groupBy: GroupBy
	/** Repo names to filter to. An empty list includes every repo. */
	repos: string[]
	sortBy: SortBy
	/** Show aggregate git additions/deletions on each workspace row. */
	showDiffs: boolean
	/**
	 * Drop workspaces whose PR has landed (see `isMerged`). Off by default — a
	 * filter that hides rows has to be asked for, never inherited.
	 */
	hideMerged: boolean
	/**
	 * Drop workspaces marked Done (see `isDone`). Separate from `hideMerged`: a
	 * branch that landed and a status somebody set are different claims, and the
	 * two disagree in both directions. Off by default, for the same reason.
	 */
	hideDone: boolean
	/** Collapsed group keys (e.g. 'status:done', 'repo:auk-store'). */
	collapsed: string[]
}

const VIEW_KEY = 'conductor-remote-view'
const LAST_NEW_WORKSPACE_REPO_KEY = 'conductor-remote-last-new-workspace-repo'
const defaultView: ViewPrefs = {
	groupBy: 'status',
	repos: [],
	sortBy: 'updated',
	showDiffs: true,
	hideMerged: false,
	hideDone: false,
	collapsed: []
}

/** Drop keys with no staged value, so "nothing staged" is `{}` and never `{ plan: undefined }`. */
function prunePatch(patch: AgentPatch): AgentPatch {
	const next: AgentPatch = {}
	if (patch.model !== undefined) next.model = patch.model
	if (patch.effort !== undefined) next.effort = patch.effort
	if (patch.plan !== undefined) next.plan = patch.plan
	if (patch.fast !== undefined) next.fast = patch.fast
	return next
}

function loadView(): ViewPrefs {
	try {
		const { repo: legacyRepo, ...saved } = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<ViewPrefs> & {
			repo?: unknown
		}
		const repos = Array.isArray(saved.repos)
			? saved.repos.filter((repo): repo is string => typeof repo === 'string')
			: typeof legacyRepo === 'string'
				? [legacyRepo]
				: []
		return { ...defaultView, ...saved, repos }
	} catch {
		return defaultView
	}
}

function loadLastNewWorkspaceRepo(): string {
	try {
		return localStorage.getItem(LAST_NEW_WORKSPACE_REPO_KEY) ?? ''
	} catch {
		return ''
	}
}

interface AppState {
	token: string | null
	/** Whether the relay is reachable — drives the offline banner. */
	online: boolean
	/** Epoch ms of the last successful relay call — the banner's "last synced". */
	lastSyncAt: number | null
	/**
	 * Last self-update snapshot the relay reported (src/autoupdate.ts). Held across the offline blip an
	 * auto-update restart causes — while it reads `mode:auto, available:true` the banner shows a calm
	 * "Updating…" instead of the alarming red "Offline". Null until the first successful state poll.
	 */
	update: UpdateStatus | null
	/**
	 * Per-session epoch ms of the last successful send — treats the session as
	 * working immediately, bridging the gap until the status poll catches up.
	 */
	workingHints: Record<string, number>
	/**
	 * Prompts awaiting confirmation, rendered as optimistic in-chat bubbles and
	 * mirrored to localStorage (see lib/pending.ts) — between the composer clearing
	 * its draft and the relay confirming, this is the only copy of the text.
	 */
	pending: PendingMessage[]
	/** Unsent composer text per chat, mirrored to localStorage (see lib/draft.ts). */
	drafts: Record<string, string>
	/** Ready host-side files carried atomically with each composer draft. */
	draftAttachments: Record<string, DraftAttachment[]>
	/**
	 * Agent settings chosen on the phone but not yet pushed into Conductor, per
	 * session id (mirrored to localStorage — see lib/agentDraft.ts). A model or
	 * effort change costs a slow, focus-stealing AppleScript round trip and only
	 * matters for the *next* prompt, so the phone holds it here and the send
	 * applies it (hooks.ts ▸ `useSendPrompt`) — exactly like the desktop composer,
	 * where the picker changes what the next message runs on.
	 */
	agentDrafts: Record<string, AgentPatch>
	/**
	 * Per-chat "seen up to here", mirrored to localStorage (see lib/read.ts). Conductor's
	 * own unread flag can only be cleared from the Mac, so this is what stops a chat read
	 * on the phone from staying unread forever.
	 */
	readMarks: ReadMarks
	/** Composer currently protected from a background sync overwrite. */
	focusedDraft: string | null
	/**
	 * This device's push subscription as the *relay* knows it. Reconciled once at the
	 * app shell (`usePushSync`) rather than by the Connect sheet, because the whole
	 * point is to repair a subscription the relay has lost — which has to happen on
	 * every load, not only when someone opens the sheet to look at it.
	 * `deviceId` is null when this device isn't subscribed; `devices` counts every
	 * phone the relay will notify.
	 */
	push: { deviceId: string | null; devices: number }
	/** Mobile workspace drawer. On md+ the sidebar is static and this is ignored. */
	sidebarOpen: boolean
	/** Repo most recently selected in the New workspace sheet on this device. */
	lastNewWorkspaceRepo: string
	view: ViewPrefs
	setToken: (token: string | null) => void
	setOnline: (online: boolean) => void
	setUpdate: (update: UpdateStatus | null) => void
	markWorking: (sessionId: string) => void
	/**
	 * Drop that hint. A confirmed stop has to clear it by hand, or the chat keeps
	 * claiming to work for the rest of the hint's 15s — a spinner running against a
	 * Stop button that has already done its job.
	 */
	clearWorking: (sessionId: string) => void
	/** Add (or reset, by id — used by Retry) the bubble and status-ring `sending` state. */
	addPending: (m: {
		id: string
		sessionId: string
		workspaceId: string
		text: string
		queue?: boolean
		workflow?: boolean
	}) => void
	failPending: (id: string, error: string) => void
	removePending: (id: string) => void
	setDraft: (chatId: string, text: string) => void
	addDraftAttachment: (chatId: string, attachment: DraftAttachment) => void
	removeDraftAttachment: (chatId: string, path: string) => void
	/** Clear sent text and files together while preserving agent choices still being applied. */
	clearDraftContent: (chatId: string) => void
	/** Move a legacy workspace-keyed draft to its first opened chat. */
	moveDraft: (fromId: string, toId: string) => void
	/** Stage an agent change for the next send. A key set to `undefined` unstages it. */
	stageAgent: (sessionId: string, patch: AgentPatch) => void
	/** Drop the staged keys a send just applied — anything staged since survives. */
	clearAgentDraft: (sessionId: string, applied: AgentPatch) => void
	/** Note a chat as seen up to `at` (its `updated_at`); older marks never overwrite newer ones. */
	markRead: (sessionId: string, at: string) => void
	/** Apply a host merge without recording it as a fresh local edit. */
	applySyncedPrefs: (prefs: LocalPrefsProjection) => void
	setFocusedDraft: (draftId: string | null) => void
	setPush: (push: { deviceId: string | null; devices: number }) => void
	setSidebarOpen: (open: boolean) => void
	setLastNewWorkspaceRepo: (repo: string) => void
	setView: (patch: Partial<ViewPrefs>) => void
	toggleGroup: (key: string) => void
}

export const useApp = create<AppState>((set, get) => {
	const saveView = (view: ViewPrefs) => {
		localStorage.setItem(VIEW_KEY, JSON.stringify(view))
		set({ view })
	}
	// Every change to the list goes through here: the composer clears its draft the
	// moment a send starts, so from then on this is the only copy of what was typed.
	const savePending = (pending: PendingMessage[]) => {
		writePending(pending)
		set({ pending })
	}
	return {
		token: bootstrapToken(),
		online: true,
		lastSyncAt: null,
		update: null,
		workingHints: {},
		pending: loadPending(),
		drafts: initialPrefs.drafts,
		draftAttachments: initialPrefs.draftAttachments,
		agentDrafts: initialPrefs.agentDrafts,
		readMarks: initialPrefs.readMarks,
		focusedDraft: null,
		push: { deviceId: null, devices: 0 },
		// Landing without a workspace in the URL → open the drawer so phones see the list first.
		sidebarOpen: !location.pathname.startsWith('/w/'),
		lastNewWorkspaceRepo: loadLastNewWorkspaceRepo(),
		view: loadView(),
		// Keep localStorage in sync so a paste survives reload and a 401 doesn't re-load a dead token.
		setToken: token => {
			if (token) setStoredToken(token)
			else clearToken()
			set({ token })
		},
		setOnline: online => {
			if (online) {
				if (offlineTimer) clearTimeout(offlineTimer)
				offlineTimer = null
				set({ online, lastSyncAt: Date.now() })
				return
			}

			if (!get().online || offlineTimer) return
			const delay = offlineDelay(get().lastSyncAt)
			if (delay === 0) {
				set({ online: false })
				return
			}
			offlineTimer = setTimeout(() => {
				offlineTimer = null
				set({ online: false })
			}, delay)
		},
		setUpdate: update => set({ update }),
		markWorking: sessionId => set({ workingHints: { ...get().workingHints, [sessionId]: Date.now() } }),
		clearWorking: sessionId => {
			const { [sessionId]: _gone, ...rest } = get().workingHints
			set({ workingHints: rest })
		},
		addPending: m =>
			savePending([
				...get().pending.filter(p => p.id !== m.id),
				{ ...m, status: 'sending', error: undefined, createdAt: Date.now() }
			]),
		failPending: (id, error) =>
			savePending(get().pending.map(p => (p.id === id ? { ...p, status: 'error', error } : p))),
		removePending: id => savePending(get().pending.filter(p => p.id !== id)),
		setDraft: (chatId, text) => {
			const saved = setLocalDraft(chatId, text, get().agentDrafts[chatId] ?? {})
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		addDraftAttachment: (chatId, attachment) => {
			const current = get().draftAttachments[chatId] ?? []
			if (current.some(candidate => candidate.path === attachment.path)) return
			const saved = setLocalAttachments(
				chatId,
				[...current, attachment],
				get().drafts[chatId] ?? '',
				get().agentDrafts[chatId] ?? {}
			)
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		removeDraftAttachment: (chatId, attachmentPath) => {
			const current = get().draftAttachments[chatId] ?? []
			const next = current.filter(attachment => attachment.path !== attachmentPath)
			if (next.length === current.length) return
			const saved = setLocalAttachments(chatId, next, get().drafts[chatId] ?? '', get().agentDrafts[chatId] ?? {})
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		clearDraftContent: chatId => {
			const saved = setLocalDraftContent(chatId, '', get().agentDrafts[chatId] ?? {}, [])
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		moveDraft: (fromId, toId) => {
			const drafts = get().drafts
			const text = drafts[fromId]
			const hasSource =
				text !== undefined || get().agentDrafts[fromId] !== undefined || get().draftAttachments[fromId] !== undefined
			const hasTarget =
				drafts[toId] !== undefined ||
				get().agentDrafts[toId] !== undefined ||
				get().draftAttachments[toId] !== undefined
			if (!hasSource || fromId === toId || hasTarget) return
			const saved = moveLocalDraft(fromId, toId)
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		markRead: (sessionId, at) => {
			// The session poll re-fires this every couple of seconds while a chat is open;
			// bail unless it actually moves the mark, or every tick re-renders the sidebar.
			if ((get().readMarks[sessionId] ?? '') >= at) return
			set({ readMarks: setLocalReadMark(sessionId, at).readMarks })
		},
		stageAgent: (sessionId, patch) => {
			const next = prunePatch({ ...get().agentDrafts[sessionId], ...patch })
			const saved = setLocalAgent(sessionId, next, get().drafts[sessionId] ?? '')
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		// Key by key rather than wholesale: a setting changed *while* the send was in
		// flight is staged for the next one, and clearing the whole entry would eat it.
		clearAgentDraft: (sessionId, applied) => {
			const current = get().agentDrafts[sessionId]
			if (!current) return
			const next = prunePatch({
				model: current.model === applied.model ? undefined : current.model,
				effort: current.effort === applied.effort ? undefined : current.effort,
				plan: current.plan === applied.plan ? undefined : current.plan,
				fast: current.fast === applied.fast ? undefined : current.fast
			})
			const saved = setLocalAgent(sessionId, next, get().drafts[sessionId] ?? '')
			set({ drafts: saved.drafts, agentDrafts: saved.agentDrafts, draftAttachments: saved.draftAttachments })
		},
		applySyncedPrefs: prefs =>
			set({
				drafts: prefs.drafts,
				agentDrafts: prefs.agentDrafts,
				draftAttachments: prefs.draftAttachments,
				readMarks: prefs.readMarks
			}),
		setFocusedDraft: focusedDraft => set({ focusedDraft }),
		setPush: push => set({ push }),
		setSidebarOpen: sidebarOpen => set({ sidebarOpen }),
		setLastNewWorkspaceRepo: repo => {
			try {
				localStorage.setItem(LAST_NEW_WORKSPACE_REPO_KEY, repo)
			} catch {}
			set({ lastNewWorkspaceRepo: repo })
		},
		setView: patch => saveView({ ...get().view, ...patch }),
		toggleGroup: key => {
			const { collapsed } = get().view
			saveView({
				...get().view,
				collapsed: collapsed.includes(key) ? collapsed.filter(k => k !== key) : [...collapsed, key]
			})
		}
	}
})
