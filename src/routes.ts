/**
 * Every `/api` path, declared once, for the three callers that must agree on it.
 *
 * The relay matches these, the phone builds them (`web/src/lib/api.ts`) and the MCP
 * tools build them too (`src/mcp-tools.ts`). Before this each path was spelled three
 * times: a regex here, a template literal there, another template literal in the third
 * place. `src/wire.ts` had already made the *shapes* impossible to disagree about, and
 * this is the other half — a renamed path used to typecheck cleanly in all three files
 * and surface as a 404 on someone's phone.
 *
 * One pattern gives both directions. `param()` splits `/api/sessions/:id/stop` at the
 * placeholder, so the same string builds `path(id)` for a client and the regex the relay
 * matches with. They cannot drift because there is only one of them.
 *
 * **This module stays stdlib-free — no `node:` imports, ever.** It is one of the two
 * files under `src/` the web app may import a *value* from (the other is
 * `src/shared.ts`), and `scripts/check-imports.ts` walks both to enforce it. Anything
 * needing Node belongs in the handler, not in the table.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** A path with no parameters. */
export interface Route0 {
	method: Method
	pattern: string
	path: () => string
}

/** A path with exactly one `:param`. Nothing here needs two, and arity is worth keeping. */
export interface Route1 {
	method: Method
	pattern: string
	/** The parameter is URL-encoded here, so no caller has to remember to. */
	path: (param: string) => string
	/** Matches the whole pathname, capturing the parameter still encoded. */
	re: RegExp
}

/** Escape a literal for use inside a RegExp — the paths are fixed strings, but `.` is real syntax. */
function literal(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function flat(method: Method, pattern: string): Route0 {
	return { method, pattern, path: () => pattern }
}

function param(method: Method, pattern: string): Route1 {
	const [head, tail] = pattern.split(/:[a-zA-Z]+/)
	if (tail === undefined) throw new Error(`route ${pattern} declares no :param`)
	return {
		method,
		pattern,
		path: value => `${head}${encodeURIComponent(value)}${tail}`,
		re: new RegExp(`^${literal(head)}([^/]+)${literal(tail)}$`)
	}
}

/**
 * The table. Names read as what the caller wants, not as the verb plus the noun, because
 * the method is right there in the value.
 */
export const routes = {
	// ── the relay itself ──
	state: flat('GET', '/api/state'),
	search: flat('GET', '/api/search'),
	repos: flat('GET', '/api/repos'),
	/** Picker labels the relay has previously read from Conductor, grouped by harness. */
	modelCatalog: flat('GET', '/api/models'),
	repoIcon: param('GET', '/api/repos/:repo/icon'),
	/** A temporary image emitted in a chat message, fetched with the phone's auth header. */
	localImage: param('GET', '/api/local-images/:path'),
	/** A source-file preview linked from agent Markdown. */
	filePreview: param('GET', '/api/files/:reference'),
	/**
	 * One image a tool returned, addressed `<message rowid>.<image number in that row>`.
	 * It is a route rather than a field because the bytes are ~100 kB of base64 each and a
	 * transcript's first fetch carries a whole chat: the phone asks only for the ones it opens.
	 */
	toolImage: param('GET', '/api/tool-images/:reference'),
	/** Temporarily hold a file while the phone creates the workspace it will belong to. */
	stageAttachment: flat('POST', '/api/attachments'),
	/** Drop a staged file the user removed before creating its workspace. */
	discardStagedAttachment: param('DELETE', '/api/attachments/:attachmentId'),
	logs: flat('GET', '/api/logs'),
	settings: flat('GET', '/api/settings'),
	updateSettings: flat('PATCH', '/api/settings'),
	nosleep: flat('GET', '/api/nosleep'),
	armNoSleep: flat('POST', '/api/nosleep'),
	disarmNoSleep: flat('DELETE', '/api/nosleep'),
	push: flat('GET', '/api/push'),
	pushSubscribe: flat('POST', '/api/push/subscribe'),
	pushUnsubscribe: flat('POST', '/api/push/unsubscribe'),
	pushTest: flat('POST', '/api/push/test'),

	// ── workspaces ──
	createWorkspace: flat('POST', '/api/workspaces'),
	/** One workspace by id, archived included — what `/api/state` deliberately leaves out. */
	workspace: param('GET', '/api/workspaces/:workspaceId'),
	sessions: param('GET', '/api/workspaces/:workspaceId/sessions'),
	newChat: param('POST', '/api/workspaces/:workspaceId/sessions'),
	diff: param('GET', '/api/workspaces/:workspaceId/diff'),
	merge: param('POST', '/api/workspaces/:workspaceId/merge'),
	workspaceStatus: param('POST', '/api/workspaces/:workspaceId/status'),
	/** Dismiss a first prompt the relay never managed to deliver (src/firstprompt.ts). */
	dismissFirstPrompt: param('DELETE', '/api/workspaces/:workspaceId/prompt'),

	// ── chats ──
	messages: param('GET', '/api/sessions/:sessionId/messages'),
	models: param('GET', '/api/sessions/:sessionId/models'),
	agent: param('POST', '/api/sessions/:sessionId/agent'),
	stop: param('POST', '/api/sessions/:sessionId/stop'),
	sendPrompt: param('POST', '/api/sessions/:sessionId/prompt'),
	/** Write a phone-selected file into Conductor's attachment layout for this chat's workspace. */
	uploadAttachment: param('POST', '/api/sessions/:sessionId/attachments'),
	/** Copy a chat into a fresh tab beside it, as a Conductor attachment (src/attachments.ts). */
	splitChat: param('POST', '/api/sessions/:sessionId/split'),
	/** Dismiss a prompt parked behind the lock screen (src/parked.ts). */
	dismissParkedPrompt: param('DELETE', '/api/sessions/:sessionId/prompt')
} as const

// ── matching, for the relay ─────────────────────────────────────────────────────
// The client half of a route is a function call; the server half needs these two.

/** Whether this request is that parameterless route. */
export function isRoute(route: Route0, method: string | undefined, pathname: string): boolean {
	return method === route.method && pathname === route.pattern
}

/**
 * The decoded parameter when this request is that route, else null.
 *
 * Decoding here rather than at each call site is the point: a workspace id is safe
 * either way, but a repo name is not, and one handler forgetting `decodeURIComponent`
 * is exactly the bug this table exists to make unwritable.
 */
export function routeParam(route: Route1, method: string | undefined, pathname: string): string | null {
	if (method !== route.method) return null
	const m = pathname.match(route.re)
	return m ? decodeURIComponent(m[1]) : null
}
