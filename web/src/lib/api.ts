import type {
	AgentPatch,
	AgentResult,
	CreateWorkspaceResult,
	LogsResponse,
	MergeResult,
	MessagesResponse,
	ModelsResult,
	NewChatResult,
	PushConfig,
	PushSubscribeResult,
	PushTestResult,
	ReposResponse,
	SendResult,
	SessionsResponse,
	StateResponse,
	WorkspaceDiff
} from './types.ts'

const TOKEN_KEY = 'conductor-remote-token'

/** Pull a `#token=…` out of the URL on first load, persist it, and clean the hash. */
export function bootstrapToken(): string | null {
	const hash = new URLSearchParams(location.hash.slice(1))
	const fromHash = hash.get('token')
	if (fromHash) {
		localStorage.setItem(TOKEN_KEY, fromHash)
		history.replaceState(null, '', location.pathname + location.search)
	}
	return localStorage.getItem(TOKEN_KEY)
}

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY)
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY)
}

/** Persist a token that arrived outside the URL flow (e.g. pasted into the TokenGate). */
export function setStoredToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token)
}

/** Accept a bare token or anything containing `token=…` (a full `/#token=` URL, say); null if neither. */
export function parseTokenInput(raw: string): string | null {
	const s = raw.trim()
	if (!s) return null
	const m = s.match(/token=([^&\s]+)/)
	if (m) return decodeURIComponent(m[1])
	return /\s/.test(s) ? null : s
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message)
	}
}

// A sleeping Mac (relay + Tailscale suspended) answers nothing — no response, no
// reset — so a bare fetch hangs forever and the poll never errors, leaving the UI
// frozen on stale data with no offline banner. A timeout aborts the request so the
// poll surfaces an error and the banner shows. Polls stay short (flip to offline
// fast); mutating calls drive AppleScript + a delivery read-back on the relay, so
// they get a much longer budget.
const POLL_TIMEOUT_MS = 6000
const ACTION_TIMEOUT_MS = 25000

async function api<T>(path: string, opts: RequestInit = {}, timeoutMs = POLL_TIMEOUT_MS): Promise<T> {
	const token = getToken()
	let res: Response
	try {
		res = await fetch(path, {
			...opts,
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${token ?? ''}`,
				'content-type': 'application/json',
				...opts.headers
			}
		})
	} catch (err) {
		// AbortSignal.timeout rejects with a TimeoutError DOMException — normalise it
		// to an ApiError(status 0) so callers treat it as "offline", not a 401 logout.
		if (err instanceof DOMException && err.name === 'TimeoutError') throw new ApiError('Request timed out', 0)
		throw err
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string }
		throw new ApiError(body.error || `HTTP ${res.status}`, res.status)
	}
	return res.json() as Promise<T>
}

/**
 * Fetch an image endpoint with the auth header and hand back an object URL — keeps the token out of the
 * image `src` (a `?token=` query string can leak into proxy/Funnel access logs and browser history). One
 * fetch per key is shared and its object URL reused for the session (icons rarely change); a failed fetch
 * is evicted so it can be retried.
 */
const objectUrlCache = new Map<string, Promise<string>>()
async function fetchObjectUrl(path: string): Promise<string> {
	const token = getToken()
	const res = await fetch(path, {
		headers: { authorization: `Bearer ${token ?? ''}` },
		signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
	})
	if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
	return URL.createObjectURL(await res.blob())
}

export const client = {
	state: () => api<StateResponse>('/api/state'),
	/** A repo's icon as an object URL, fetched with the auth header (token never rides in the URL). Cached per repo. */
	repoIcon: (repoName: string): Promise<string> => {
		let p = objectUrlCache.get(repoName)
		if (!p) {
			p = fetchObjectUrl(`/api/repos/${encodeURIComponent(repoName)}/icon`)
			p.catch(() => objectUrlCache.delete(repoName))
			objectUrlCache.set(repoName, p)
		}
		return p
	},
	sessions: (workspaceId: string) =>
		api<SessionsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`),
	messages: (sessionId: string, after: number) =>
		api<MessagesResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?after=${after}`),
	diff: (workspaceId: string) => api<WorkspaceDiff>(`/api/workspaces/${encodeURIComponent(workspaceId)}/diff`),
	sendPrompt: (sessionId: string, text: string, workspaceId: string) =>
		api<SendResult>(
			`/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
			{ method: 'POST', body: JSON.stringify({ text, workspaceId }) },
			ACTION_TIMEOUT_MS
		),
	/** Open a new chat ("New chat, same files" / Cmd+T) in a workspace. */
	newChat: (workspaceId: string) =>
		api<NewChatResult>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
			{ method: 'POST' },
			ACTION_TIMEOUT_MS
		),
	/** Repos a new workspace can be created in. */
	repos: () => api<ReposResponse>('/api/repos'),
	/** Drop a first prompt the relay couldn't deliver, once the user has dealt with it. */
	dismissPrompt: (workspaceId: string) =>
		api<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/prompt`, { method: 'DELETE' }),
	/**
	 * Create a workspace from a first prompt via Conductor's deep link. Returns as
	 * soon as the row exists — the worktree may still be setting up, so the caller
	 * submits the prompt once the workspace is ready.
	 */
	createWorkspace: (repo: string, prompt: string) =>
		api<CreateWorkspaceResult>(
			'/api/workspaces',
			{ method: 'POST', body: JSON.stringify({ repo, prompt }) },
			ACTION_TIMEOUT_MS
		),
	/** Change a chat's model / effort / plan / fast via Conductor's own composer controls. */
	setAgent: (sessionId: string, patch: AgentPatch, workspaceId: string) =>
		api<AgentResult>(
			`/api/sessions/${encodeURIComponent(sessionId)}/agent`,
			{ method: 'POST', body: JSON.stringify({ ...patch, workspaceId }) },
			ACTION_TIMEOUT_MS
		),
	/** Model labels read off Conductor's live picker (it briefly opens the menu). */
	models: (sessionId: string, workspaceId: string) =>
		api<ModelsResult>(
			`/api/sessions/${encodeURIComponent(sessionId)}/models?workspaceId=${encodeURIComponent(workspaceId)}`,
			{},
			ACTION_TIMEOUT_MS
		),
	/**
	 * The relay's own log. No `file` = the running process's captured console; a file name tails
	 * the daemon's stdout/stderr on disk (where a crash before the current process still lives).
	 * The relay redacts the access token, so what comes back is safe to paste into a bug report.
	 */
	logs: (file: string | null, limit = 300) =>
		api<LogsResponse>(`/api/logs?limit=${limit}${file ? `&file=${encodeURIComponent(file)}` : ''}`),
	/** VAPID public key to subscribe with, plus the phones already subscribed. */
	push: () => api<PushConfig>('/api/push'),
	/** Register this device for push. Idempotent by endpoint — the app re-sends it on every load. */
	pushSubscribe: (subscription: unknown, label: string) =>
		api<PushSubscribeResult>('/api/push/subscribe', {
			method: 'POST',
			body: JSON.stringify({ subscription, label })
		}),
	pushUnsubscribe: (endpoint: string) =>
		api<PushSubscribeResult>('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
	/** Push one notification to this device — proves the relay → push service → phone path end to end. */
	pushTest: (id: string) =>
		api<PushTestResult>('/api/push/test', { method: 'POST', body: JSON.stringify({ id }) }, ACTION_TIMEOUT_MS),
	/** Merge the workspace's open PR — `gh pr merge`, like Conductor's Merge button. */
	merge: (workspaceId: string) =>
		api<MergeResult>(`/api/workspaces/${encodeURIComponent(workspaceId)}/merge`, { method: 'POST' }, ACTION_TIMEOUT_MS)
}
