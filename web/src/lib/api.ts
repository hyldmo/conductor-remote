// A value import, and one of exactly two the web app may make into `src/` (the other is
// `src/shared.ts`). `routes.ts` is stdlib-free for precisely this reason, and
// `scripts/check-imports.ts` keeps it that way.
import { routes } from '../../../src/routes.ts'
import { VIEWING_HEADER } from '../../../src/shared.ts'
import type {
	AgentPatch,
	AgentResult,
	ArchiveResult,
	CreateWorkspaceResult,
	DevServerResult,
	DevServerState,
	FilePreviewResponse,
	LogsResponse,
	MergeResult,
	MessagesResponse,
	ModelCatalogResponse,
	ModelsResult,
	NewChatResult,
	NoSleepResult,
	Prefs,
	PrefsResponse,
	PushConfig,
	PushSubscribeResult,
	PushTestResult,
	RelaySettings,
	ReposResponse,
	SearchResponse,
	SendResult,
	SessionsResponse,
	SettingsResponse,
	SplitChatResult,
	StageAttachmentResult,
	StateResponse,
	StatusResult,
	StopResult,
	UploadAttachmentResult,
	WorkspaceDiff,
	WorkspaceFilesResponse,
	WorkspaceResponse
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
// poll surfaces an error. The store waits ten seconds since the last successful
// relay call before it shows the offline banner. Mutating calls drive AppleScript +
// a delivery read-back on the relay, so they get a much longer budget.
//
// **These must exceed the relay's own budget for the same call**, or the phone gives
// up on work that is still running and shows a failure for something that then
// lands — and the user can't tell the two apart. They didn't: an agent change is
// 28s of AppleScript + 3s of confirming against the DB, and a workspace creation
// polls for the new row for 20s, both past the old flat 25s. A send is the long one
// because the relay retries inside the request (`SEND_BUDGET_MS`, 55s, in
// src/server.ts) — waiting is cheap here, since the prompt sits in the chat as a
// "Sending…" bubble rather than blocking the UI.
const POLL_TIMEOUT_MS = 6000
const ACTION_TIMEOUT_MS = 45000
const SEND_TIMEOUT_MS = 75000
// A cold Run action can spend 28s in Accessibility, 15s waiting for the
// workspace port, then configure Tailscale Serve. Keep the phone alive through
// the relay's complete answer so it never reports failure for a late success.
const DEV_SERVER_TIMEOUT_MS = 75000

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
				// How long this request will be waited on. The relay caps its own retrying at
				// this, so the two budgets can't drift apart across versions: the relay
				// updates itself (src/autoupdate.ts) while this app sits in a service-worker
				// cache, so pairing the numbers by hand would eventually have the phone
				// abandoning a send the relay was still retrying — a failure shown for a
				// prompt that then lands, the one outcome worse than a plain failure.
				'x-client-timeout-ms': String(timeoutMs),
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

/** Uploads use raw bytes so an image does not grow by a third through JSON/base64. */
async function upload<T>(path: string, file: File): Promise<T> {
	const token = getToken()
	let res: Response
	try {
		res = await fetch(path, {
			method: 'POST',
			body: file,
			signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
			headers: {
				authorization: `Bearer ${token ?? ''}`,
				'content-type': file.type || 'application/octet-stream',
				'x-attachment-name': encodeURIComponent(file.name),
				'x-client-timeout-ms': String(ACTION_TIMEOUT_MS)
			}
		})
	} catch (err) {
		if (err instanceof DOMException && err.name === 'TimeoutError') throw new ApiError('Upload timed out', 0)
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

function cachedObjectUrl(path: string): Promise<string> {
	let result = objectUrlCache.get(path)
	if (!result) {
		result = fetchObjectUrl(path)
		result.catch(() => objectUrlCache.delete(path))
		objectUrlCache.set(path, result)
	}
	return result
}

export const client = {
	state: () => api<StateResponse>(routes.state.path()),
	/** A repo's icon as an object URL, fetched with the auth header (token never rides in the URL). Cached per repo. */
	repoIcon: (repoName: string): Promise<string> => cachedObjectUrl(routes.repoIcon.path(repoName)),
	/** A local temporary image from chat Markdown. The relay validates the path before it reads it. */
	localImage: (filePath: string): Promise<string> => cachedObjectUrl(routes.localImage.path(filePath)),
	/** One image a tool returned, as an object URL. Asked for only when its step is opened. */
	toolImage: (reference: string): Promise<string> => cachedObjectUrl(routes.toolImage.path(reference)),
	/** A bounded source preview for an absolute `path:line` link in chat Markdown. */
	filePreview: (reference: string) => api<FilePreviewResponse>(routes.filePreview.path(reference)),
	/** Keep a file on the relay until the workspace it belongs to exists. */
	stageAttachment: (file: File) => upload<StageAttachmentResult>(routes.stageAttachment.path(), file),
	/** Remove a staged file when it is taken off the new-workspace prompt. */
	discardStagedAttachment: (stageId: string) =>
		api<{ ok: boolean }>(routes.discardStagedAttachment.path(stageId), {
			method: routes.discardStagedAttachment.method
		}),
	/** One workspace by id, archived included — how an archived chat is opened for reading. */
	workspace: (workspaceId: string) => api<WorkspaceResponse>(routes.workspace.path(workspaceId)),
	sessions: (workspaceId: string) => api<SessionsResponse>(routes.sessions.path(workspaceId)),
	/**
	 * `readingAs` is this device's push id, sent only while the chat is actually on
	 * screen. It makes the poll double as a heartbeat, so the relay can leave this
	 * device out of the notification for a turn ending in front of it (src/notify.ts).
	 */
	messages: (sessionId: string, after: number, readingAs?: string | null) =>
		api<MessagesResponse>(`${routes.messages.path(sessionId)}?after=${after}`, {
			headers: readingAs ? { [VIEWING_HEADER]: readingAs } : {}
		}),
	/** Stage one phone file in the selected workspace, then add its returned token to a prompt. */
	uploadAttachment: (sessionId: string, workspaceId: string, file: File) =>
		upload<UploadAttachmentResult>(
			`${routes.uploadAttachment.path(sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
			file
		),
	diff: (workspaceId: string) => api<WorkspaceDiff>(routes.diff.path(workspaceId)),
	/** The worktree's file list, which is what turns a file an agent named into a link. */
	workspaceFiles: (workspaceId: string) => api<WorkspaceFilesResponse>(routes.workspaceFiles.path(workspaceId)),
	/**
	 * The relay retries a failed send itself (and confirms each try against the
	 * transcript), hence the long budget. `agent` is the staged settings patch,
	 * riding in the same request so the relay applies it first and the prompt only
	 * goes if it stuck — and so a locked Mac parks the two together.
	 */
	/**
	 * `clientId` is the pending bubble's own id, and it is what stops Retry doubling a
	 * prompt: the relay answers a repeat of the same id with the first send's outcome
	 * instead of typing again (src/sendonce.ts). Retry reuses the bubble's id, a fresh
	 * send makes a fresh one, so saying the same thing twice on purpose still does.
	 */
	sendPrompt: (
		sessionId: string,
		text: string,
		workspaceId: string,
		agent?: AgentPatch,
		clientId?: string,
		queue?: boolean
	) =>
		api<SendResult>(
			routes.sendPrompt.path(sessionId),
			{ method: routes.sendPrompt.method, body: JSON.stringify({ text, workspaceId, agent, clientId, queue }) },
			SEND_TIMEOUT_MS
		),
	/**
	 * Stop the answer this chat is streaming — Conductor's own "Cancel agent".
	 * The relay focuses the chat, presses it, then waits for `sessions.status` to
	 * leave `working` before answering, so it gets the action budget rather than a
	 * poll's.
	 */
	stop: (sessionId: string, workspaceId: string) =>
		api<StopResult>(
			routes.stop.path(sessionId),
			{ method: routes.stop.method, body: JSON.stringify({ workspaceId }) },
			ACTION_TIMEOUT_MS
		),
	/** Open a new chat ("New chat, same files" / Cmd+T) in a workspace. */
	newChat: (workspaceId: string) =>
		api<NewChatResult>(routes.newChat.path(workspaceId), { method: routes.newChat.method }, ACTION_TIMEOUT_MS),
	/**
	 * Open a new tab with this chat's transcript staged as an attachment. The caller
	 * puts `text` into that tab's composer, then the user can add the new direction.
	 * `throughRowid` stops the copy at one response, which is how a fork offered beside
	 * an older turn carries the conversation as it stood there.
	 */
	splitChat: (
		sessionId: string,
		workspaceId: string,
		includeThinking: boolean,
		includeTools: boolean,
		throughRowid?: number
	) =>
		api<SplitChatResult>(
			routes.splitChat.path(sessionId),
			{
				method: routes.splitChat.method,
				body: JSON.stringify({ workspaceId, includeThinking, includeTools, throughRowid })
			},
			ACTION_TIMEOUT_MS
		),
	/** Repos a new workspace can be created in. */
	repos: () => api<ReposResponse>(routes.repos.path()),
	/** Model-picker labels the relay has already read from Conductor. This never opens the desktop UI. */
	modelCatalog: () => api<ModelCatalogResponse>(routes.modelCatalog.path()),
	/**
	 * Find a workspace by name or by what was said in its chats, archived included.
	 * The relay answers from a local index, so this is a poll-budget call even though
	 * it searches every conversation on the Mac.
	 */
	search: (q: string) => api<SearchResponse>(`${routes.search.path()}?q=${encodeURIComponent(q)}`),
	/** Drop a first prompt the relay couldn't deliver, once the user has dealt with it. */
	dismissPrompt: (workspaceId: string) =>
		api<{ ok: boolean }>(routes.dismissFirstPrompt.path(workspaceId), { method: routes.dismissFirstPrompt.method }),
	/** Drop whatever the relay parked for this chat behind the lock screen. */
	dismissParked: (sessionId: string) =>
		api<{ ok: boolean }>(routes.dismissParkedPrompt.path(sessionId), { method: routes.dismissParkedPrompt.method }),
	/**
	 * Create a workspace from a first prompt via Conductor's deep link. Returns as
	 * soon as the row exists — the worktree may still be setting up, and the relay
	 * sends the prompt itself from there (src/firstprompt.ts). `sendImmediately: false`
	 * holds that send until the worktree is built instead.
	 */
	createWorkspace: (
		repo: string,
		prompt: string,
		sendImmediately = true,
		attachmentIds: string[] = [],
		agent: AgentPatch = {}
	) =>
		api<CreateWorkspaceResult>(
			routes.createWorkspace.path(),
			{
				method: routes.createWorkspace.method,
				body: JSON.stringify({ repo, prompt, sendImmediately, attachmentIds, ...agent })
			},
			ACTION_TIMEOUT_MS
		),
	/** Change a chat's model / effort / plan / fast via Conductor's own composer controls. */
	setAgent: (sessionId: string, patch: AgentPatch, workspaceId: string) =>
		api<AgentResult>(
			routes.agent.path(sessionId),
			{ method: routes.agent.method, body: JSON.stringify({ ...patch, workspaceId }) },
			ACTION_TIMEOUT_MS
		),
	/** Model labels read off Conductor's live picker (it briefly opens the menu). */
	models: (sessionId: string, workspaceId: string) =>
		api<ModelsResult>(
			`${routes.models.path(sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
			{},
			ACTION_TIMEOUT_MS
		),
	/**
	 * The relay's own log. No `file` = the running process's captured console; a file name tails
	 * the daemon's stdout/stderr on disk (where a crash before the current process still lives).
	 * The relay redacts the access token, so what comes back is safe to paste into a bug report.
	 */
	logs: (file: string | null, limit = 300) =>
		api<LogsResponse>(`${routes.logs.path()}?limit=${limit}${file ? `&file=${encodeURIComponent(file)}` : ''}`),
	/** VAPID public key to subscribe with, plus the phones already subscribed. */
	push: () => api<PushConfig>(routes.push.path()),
	/** Register this device for push. Idempotent by endpoint — the app re-sends it on every load. */
	pushSubscribe: (subscription: unknown, label: string) =>
		api<PushSubscribeResult>(routes.pushSubscribe.path(), {
			method: routes.pushSubscribe.method,
			body: JSON.stringify({ subscription, label })
		}),
	pushUnsubscribe: (endpoint: string) =>
		api<PushSubscribeResult>(routes.pushUnsubscribe.path(), {
			method: routes.pushUnsubscribe.method,
			body: JSON.stringify({ endpoint })
		}),
	/** Push one notification to this device — proves the relay → push service → phone path end to end. */
	pushTest: (id: string) =>
		api<PushTestResult>(
			routes.pushTest.path(),
			{ method: routes.pushTest.method, body: JSON.stringify({ id }) },
			ACTION_TIMEOUT_MS
		),
	/** Merge the workspace's open PR — `gh pr merge`, like Conductor's Merge button. */
	merge: (workspaceId: string) =>
		api<MergeResult>(routes.merge.path(workspaceId), { method: routes.merge.method }, ACTION_TIMEOUT_MS),

	/** Move the workspace between the sidebar's status groups (Conductor's "Set status"). */
	setStatus: (workspaceId: string, status: string) =>
		api<StatusResult>(
			routes.workspaceStatus.path(workspaceId),
			{ method: routes.workspaceStatus.method, body: JSON.stringify({ status }) },
			ACTION_TIMEOUT_MS
		),

	/**
	 * Put the workspace away (Conductor's ⌘⇧A). `stopAgents` is the second half of the
	 * question its own dialog asks — without it the relay refuses a workspace whose
	 * agents are still working rather than ending their turns.
	 */
	archive: (workspaceId: string, stopAgents = false) =>
		api<ArchiveResult>(
			routes.archiveWorkspace.path(workspaceId),
			{ method: routes.archiveWorkspace.method, body: JSON.stringify({ stopAgents }) },
			ACTION_TIMEOUT_MS
		),

	/** Observe a workspace's selected Run task without touching Conductor's UI. */
	devServer: (workspaceId: string) => api<DevServerState>(routes.devServer.path(workspaceId)),
	/** Press Run when needed, wait for CONDUCTOR_PORT, then expose it to this tailnet. */
	startDevServer: (workspaceId: string) =>
		api<DevServerResult>(
			routes.startDevServer.path(workspaceId),
			{ method: routes.startDevServer.method },
			DEV_SERVER_TIMEOUT_MS
		),
	/** Press Stop and remove only the Tailscale Serve mapping this relay created. */
	stopDevServer: (workspaceId: string) =>
		api<DevServerResult>(
			routes.stopDevServer.path(workspaceId),
			{ method: routes.stopDevServer.method },
			DEV_SERVER_TIMEOUT_MS
		),

	/** Relay preferences, plus the Wi-Fi networks the Mac already knows and the awake state. */
	settings: () => api<SettingsResponse>(routes.settings.path()),
	patchSettings: (patch: Partial<RelaySettings>) =>
		api<{ settings: RelaySettings }>(routes.updateSettings.path(), {
			method: routes.updateSettings.method,
			body: JSON.stringify(patch)
		}),
	/** The host's durable mirror of read marks and unsent composer intent. */
	prefs: () => api<PrefsResponse>(routes.prefs.path()),
	patchPrefs: (prefs: Prefs, keepalive = false) =>
		api<PrefsResponse>(routes.updatePrefs.path(), {
			method: routes.updatePrefs.method,
			body: JSON.stringify(prefs),
			keepalive
		}),
	/**
	 * Hold the Mac awake with the lid shut for `seconds`. The relay waits for the helper
	 * to confirm it actually applied before answering, and a takeover waits for the
	 * previous window to restore first, so this is slow by design — hence the action budget.
	 */
	armNoSleep: (seconds: number) =>
		api<NoSleepResult>(
			routes.armNoSleep.path(),
			{ method: routes.armNoSleep.method, body: JSON.stringify({ seconds }) },
			ACTION_TIMEOUT_MS
		),
	disarmNoSleep: () =>
		api<NoSleepResult>(routes.disarmNoSleep.path(), { method: routes.disarmNoSleep.method }, ACTION_TIMEOUT_MS)
}
