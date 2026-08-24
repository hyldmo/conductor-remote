import { create } from 'zustand'
import { loadAgentDrafts, writeAgentDraft } from './lib/agentDraft.ts'
import { bootstrapToken, clearToken, setStoredToken } from './lib/api.ts'
import { loadDrafts, writeDraft } from './lib/draft.ts'
import { loadReadMarks, type ReadMarks, writeReadMarks } from './lib/read.ts'
import type { AgentPatch, UpdateStatus } from './lib/types.ts'

/**
 * Sidebar view preferences — mirrors the desktop app's Group by / Repo / Sort by
 * popover, plus `recent`, which the desktop has no equivalent of: day buckets
 * (Today / Yesterday / …) for reaching the chat you left a minute ago.
 */
export type GroupBy = 'status' | 'repo' | 'recent' | 'none'
export type SortBy = 'updated' | 'created' | 'name'
export interface ViewPrefs {
	groupBy: GroupBy
	/** Repo name to filter to, or null for all repos. */
	repo: string | null
	sortBy: SortBy
	/**
	 * Drop workspaces whose PR has landed (see `isMerged`). Off by default — a
	 * filter that hides rows has to be asked for, never inherited.
	 */
	hideMerged: boolean
	/** Collapsed group keys (e.g. 'status:done', 'repo:auk-store'). */
	collapsed: string[]
}

const VIEW_KEY = 'conductor-remote-view'
const defaultView: ViewPrefs = { groupBy: 'status', repo: null, sortBy: 'updated', hideMerged: false, collapsed: [] }

/**
 * A prompt shown optimistically in the transcript before the relay confirms it.
 * `sending` until the POST resolves; `error` if it failed (the relay's read-back
 * found no matching row, or the request never reached it). Carries workspaceId so
 * the in-chat Retry can re-send without the Composer.
 */
export interface PendingMessage {
	id: string
	sessionId: string
	workspaceId: string
	text: string
	status: 'sending' | 'error'
	error?: string
	createdAt: number
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
		return { ...defaultView, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') }
	} catch {
		return defaultView
	}
}

interface AppState {
	token: string | null
	/** Whether the last relay call succeeded — drives the offline banner. */
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
	/** Prompts awaiting confirmation, rendered as optimistic in-chat bubbles. */
	pending: PendingMessage[]
	/** Unsent composer text per workspace, mirrored to localStorage (see lib/draft.ts). */
	drafts: Record<string, string>
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
	/** Add (or reset, by id — used by Retry) an optimistic prompt in the `sending` state. */
	addPending: (m: { id: string; sessionId: string; workspaceId: string; text: string }) => void
	failPending: (id: string, error: string) => void
	removePending: (id: string) => void
	setDraft: (workspaceId: string, text: string) => void
	/** Stage an agent change for the next send. A key set to `undefined` unstages it. */
	stageAgent: (sessionId: string, patch: AgentPatch) => void
	/** Drop the staged keys a send just applied — anything staged since survives. */
	clearAgentDraft: (sessionId: string, applied: AgentPatch) => void
	/** Note a chat as seen up to `at` (its `updated_at`); older marks never overwrite newer ones. */
	markRead: (sessionId: string, at: string) => void
	setPush: (push: { deviceId: string | null; devices: number }) => void
	setSidebarOpen: (open: boolean) => void
	setView: (patch: Partial<ViewPrefs>) => void
	toggleGroup: (key: string) => void
}

export const useApp = create<AppState>((set, get) => {
	const saveView = (view: ViewPrefs) => {
		localStorage.setItem(VIEW_KEY, JSON.stringify(view))
		set({ view })
	}
	return {
		token: bootstrapToken(),
		online: true,
		lastSyncAt: null,
		update: null,
		workingHints: {},
		pending: [],
		drafts: loadDrafts(),
		agentDrafts: loadAgentDrafts(),
		readMarks: loadReadMarks(),
		push: { deviceId: null, devices: 0 },
		// Landing without a workspace in the URL → open the drawer so phones see the list first.
		sidebarOpen: !location.pathname.startsWith('/w/'),
		view: loadView(),
		// Keep localStorage in sync so a paste survives reload and a 401 doesn't re-load a dead token.
		setToken: token => {
			if (token) setStoredToken(token)
			else clearToken()
			set({ token })
		},
		setOnline: online => set(online ? { online, lastSyncAt: Date.now() } : { online }),
		setUpdate: update => set({ update }),
		markWorking: sessionId => set({ workingHints: { ...get().workingHints, [sessionId]: Date.now() } }),
		clearWorking: sessionId => {
			const { [sessionId]: _gone, ...rest } = get().workingHints
			set({ workingHints: rest })
		},
		addPending: m =>
			set({
				pending: [
					...get().pending.filter(p => p.id !== m.id),
					{ ...m, status: 'sending', error: undefined, createdAt: Date.now() }
				]
			}),
		failPending: (id, error) =>
			set({ pending: get().pending.map(p => (p.id === id ? { ...p, status: 'error', error } : p)) }),
		removePending: id => set({ pending: get().pending.filter(p => p.id !== id) }),
		setDraft: (workspaceId, text) => {
			writeDraft(workspaceId, text)
			set({ drafts: { ...get().drafts, [workspaceId]: text } })
		},
		markRead: (sessionId, at) => {
			// The session poll re-fires this every couple of seconds while a chat is open;
			// bail unless it actually moves the mark, or every tick re-renders the sidebar.
			if ((get().readMarks[sessionId] ?? '') >= at) return
			set({ readMarks: writeReadMarks({ ...get().readMarks, [sessionId]: at }) })
		},
		stageAgent: (sessionId, patch) => {
			const next = prunePatch({ ...get().agentDrafts[sessionId], ...patch })
			writeAgentDraft(sessionId, next)
			set({ agentDrafts: { ...get().agentDrafts, [sessionId]: next } })
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
			writeAgentDraft(sessionId, next)
			set({ agentDrafts: { ...get().agentDrafts, [sessionId]: next } })
		},
		setPush: push => set({ push }),
		setSidebarOpen: sidebarOpen => set({ sidebarOpen }),
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
