import { create } from 'zustand'
import { bootstrapToken, clearToken, setStoredToken } from './lib/api.ts'

/** Sidebar view preferences — mirrors the desktop app's Group by / Repo / Sort by popover. */
export type GroupBy = 'status' | 'repo' | 'none'
export type SortBy = 'updated' | 'created' | 'name'
export interface ViewPrefs {
	groupBy: GroupBy
	/** Repo name to filter to, or null for all repos. */
	repo: string | null
	sortBy: SortBy
	/** Collapsed group keys (e.g. 'status:done', 'repo:auk-store'). */
	collapsed: string[]
}

const VIEW_KEY = 'conductor-remote-view'
const defaultView: ViewPrefs = { groupBy: 'status', repo: null, sortBy: 'updated', collapsed: [] }

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
	 * Per-session epoch ms of the last successful send — treats the session as
	 * working immediately, bridging the gap until the status poll catches up.
	 */
	workingHints: Record<string, number>
	/** Prompts awaiting confirmation, rendered as optimistic in-chat bubbles. */
	pending: PendingMessage[]
	/** Mobile workspace drawer. On md+ the sidebar is static and this is ignored. */
	sidebarOpen: boolean
	view: ViewPrefs
	setToken: (token: string | null) => void
	setOnline: (online: boolean) => void
	markWorking: (sessionId: string) => void
	/** Add (or reset, by id — used by Retry) an optimistic prompt in the `sending` state. */
	addPending: (m: { id: string; sessionId: string; workspaceId: string; text: string }) => void
	failPending: (id: string, error: string) => void
	removePending: (id: string) => void
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
		workingHints: {},
		pending: [],
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
		markWorking: sessionId => set({ workingHints: { ...get().workingHints, [sessionId]: Date.now() } }),
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
