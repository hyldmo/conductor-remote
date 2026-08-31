/**
 * The MCP tools, and the JSON-RPC dispatcher that serves them.
 *
 * Shared by both transports, which is the only reason they can't drift: `src/mcp.ts`
 * runs this over stdio as a separate process, and `src/server.ts` mounts the same
 * dispatcher at `POST /mcp` for clients that can only reach a URL.
 *
 * The tool set tracks `/api`, minus the routes that only exist to back a button on the
 * phone. An agent needs no `merge` (it holds `gh`, and `send_prompt` can ask the agent
 * that owns the branch), no push subscription, and no settings editor. What it does need
 * is everything it cannot reach any other way: the model/effort/plan/fast controls, which
 * live in Conductor's UI and nowhere else, the prompts the relay is holding on its behalf,
 * the sleep window that keeps this Mac reachable at all, and the relay's own log.
 *
 * Every tool is an HTTP call to the relay, injected as `call`, and that is the
 * load-bearing decision rather than a convenience. Conductor has one shared window,
 * so the only thing that makes writes safe is `writes.ts` ▸ `uiTurn`, and that lock is
 * *process-local*. A tool that drove AppleScript itself would sit outside it, and two
 * agents focusing different workspaces would land each other's prompts — the exact
 * failure every fail-closed assertion cannot catch. Routed through the relay, the
 * phone, both delivery queues and every agent share one lock.
 *
 * The in-relay transport calls the relay's own API over loopback rather than reaching
 * into `reads`/`writes` directly. That is a sub-millisecond hop against a 1000-line
 * router it would otherwise have to be carved out of, and it keeps *one* code path:
 * a tool cannot behave differently over HTTP than it does over stdio.
 */

import { chatCursor, parseChatCursor } from './chat-cursor.ts'
import { routes } from './routes.ts'
import { HIT_CLOSE, HIT_OPEN, isToolResult, workspaceTitle } from './shared.ts'
import type { TranscriptEntry } from './transcript.ts'
import type {
	AgentResult,
	CreateWorkspaceResult,
	LogsResponse,
	MessagesResponse,
	ModelCatalogResponse,
	ModelsResult,
	NoSleepResult,
	NoSleepStatus,
	ReposResponse,
	SearchResponse,
	SendResult,
	SessionsResponse,
	SplitChatResult,
	StateResponse,
	StatusResult,
	StopResult,
	WorkspaceDiff
} from './wire.ts'

/** How a tool reaches the relay. Injected so both transports share one tool definition. */
export interface CallOptions {
	method?: string
	body?: unknown
	timeoutMs?: number
}
export type RelayCall = <T>(route: string, opts?: CallOptions) => Promise<T>

/** Versions we know how to speak. The client's choice wins when we know it. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const SERVER_INFO = { name: 'conductor-remote', version: '1' }

export const INSTRUCTIONS =
	'Drives local Conductor agents through the conductor-remote relay. search_chats and read_chat reach archived workspaces, which is where most finished work lives. create_workspace opens its workspace link without direct UI control; requested agent settings and the first prompt are applied later through Conductor’s UI. dismiss_prompt, keep_awake and relay_logs touch no UI. send_prompt, split_chat, stop_turn, set_agent_options, a live list_models call and set_workspace_status drive the real Mac UI and steal focus for a few seconds — confirm with the user before using them on a chat they did not name.'

/** Reads are quick; a UI write is measured in tens of seconds (writes.ts ▸ SEND_ATTEMPT_MS). */
export const READ_TIMEOUT_MS = 10_000
export const WRITE_TIMEOUT_MS = 75_000

// ── formatting ──────────────────────────────────────────────────────────────────
// Tool results are text an agent reads, so they are formatted rather than dumped as
// JSON: half the tokens, and every id an agent needs to chain the next call stays
// visible instead of buried in a nested object.

function unmark(text: string): string {
	return text.replaceAll(HIT_OPEN, '«').replaceAll(HIT_CLOSE, '»').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text
}

/** A true output bound: unlike `clip`, the truncation marker is inside `max`. */
function clipExact(text: string, max: number): string {
	if (text.length <= max) return text
	const suffix = '… [truncated]'
	if (max <= suffix.length) return text.slice(0, max)
	return `${text.slice(0, max - suffix.length)}${suffix}`
}

/**
 * Fit a transcript inside one MCP result without dropping either side of a nearby
 * read. Short entries keep their full text; the longest entries share what remains.
 */
function boundedTranscript(header: string[], entries: string[], maxChars: number): string {
	const prefix = header.length ? `${header.join('\n')}\n\n` : ''
	if (!entries.length) return clipExact(prefix.trim(), maxChars)
	const separators = Math.max(0, entries.length - 1) * 2
	const available = Math.max(1, maxChars - prefix.length - separators)
	const fullLength = entries.reduce((sum, entry) => sum + entry.length, 0)
	if (fullLength <= available) return `${prefix}${entries.join('\n\n')}`

	// Find the largest per-entry ceiling whose clipped rows fit. Entries shorter than
	// it return their unused share to the longer ones, unlike a fixed equal split.
	let low = 1
	let high = Math.max(...entries.map(entry => entry.length))
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		const used = entries.reduce((sum, entry) => sum + Math.min(entry.length, mid), 0)
		if (used <= available) low = mid
		else high = mid - 1
	}
	return clipExact(`${prefix}${entries.map(entry => clipExact(entry, low)).join('\n\n')}`, maxChars)
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`
}

/** Wall-clock stamp for a log line. Null on continuation lines the file parser couldn't date. */
function stamp(t: number | null): string {
	if (t === null) return '        '
	const d = new Date(t)
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "in 42m" / "38m ago" — an absolute epoch is unreadable, and an agent's clock may differ. */
function relative(at: number): string {
	const mins = Math.round((at - Date.now()) / 60_000)
	if (mins > 0) return `in ${mins}m`
	return mins < 0 ? `${-mins}m ago` : 'now'
}

// ── tools ───────────────────────────────────────────────────────────────────────

export interface Tool {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	run: (args: Record<string, unknown>) => Promise<string>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function need(args: Record<string, unknown>, key: string): string {
	const v = str(args[key])
	if (!v) throw new Error(`${key} is required`)
	return v
}

/** Build the tool set against a given relay transport. */
export function createTools(call: RelayCall): Tool[] {
	return [
		{
			name: 'search_chats',
			description:
				'Full-text search every Conductor chat on this Mac, archived workspaces included, and get back the workspaces that discussed it with the matching excerpts. Use this to answer "which workspace did I do X in" or "what did we decide about X". Searches the prompts the user typed, the agent replies and the agent\'s reasoning, not tool output. Each excerpt is tagged [user], [assistant] or [thinking] — a [thinking] hit is reasoning the agent never said out loud, so do not quote it back as its answer. Every excerpt carries its own session_id and cursor for a bounded nearby read_chat.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Plain words. Punctuation and operators are ignored, not parsed.' },
					limit: { type: 'number', description: 'Max workspaces to return (default 12, max 50).' }
				},
				required: ['query']
			},
			run: async args => {
				const query = need(args, 'query')
				const limit = num(args.limit)
				const data = await call<SearchResponse>(
					`${routes.search.path()}?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`
				)

				const lines: string[] = []
				if (data.index.error) lines.push(`! chat index unavailable (${data.index.error}) — names matched only`)
				else if (!data.index.ready)
					lines.push(`! still indexing (${Math.round(data.index.progress * 100)}%) — older chats not searchable yet`)
				if (!data.results.length) return [...lines, `no workspace or chat matches ${JSON.stringify(query)}`].join('\n')

				for (const r of data.results) {
					const w = r.workspace
					const tags = [w.repo_name, w.branch, w.archived ? 'ARCHIVED' : w.state].filter(Boolean).join(' · ')
					lines.push('')
					lines.push(`## ${workspaceTitle(w)}`)
					lines.push(`${tags}${r.byName ? ' · name match' : ''}`)
					lines.push(`workspace_id: ${w.id}${r.sessionId ? `  session_id: ${r.sessionId}` : ''}`)
					if (r.hits) lines.push(`${r.hits} matching message${r.hits === 1 ? '' : 's'}:`)
					for (const s of r.snippets) {
						lines.push(`  [${s.role}] ${clip(unmark(s.text), 400)}`)
						lines.push(`    session_id: ${s.sessionId}  cursor: ${s.cursor}`)
					}
				}
				return lines.join('\n').trim()
			}
		},
		{
			name: 'read_chat',
			description:
				'Read a bounded Conductor chat transcript by session_id, newest messages last. Pass a cursor from search_chats or a prior read_chat as near; before and after expand either direction or both together. For a [thinking] search hit, set include_thinking true to include the matching block. Without near, returns the trailing entries. Works for archived workspaces. Tool calls and failed tool output are summarised to one line each; prose is verbatim unless the output budget truncates it.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string', description: 'From search_chats or list_chats.' },
					near: { type: 'string', description: 'A cursor from search_chats or a prior read_chat.' },
					before: { type: 'number', description: 'Entries before near to return (default 6, max 100).' },
					after: { type: 'number', description: 'Entries after near to return (default 6, max 100).' },
					limit: {
						type: 'number',
						description: 'Trailing entries when near is omitted (default 12, max 400).'
					},
					max_chars: {
						type: 'number',
						description: 'Hard result-size budget (default 12000, min 1000, max 40000).'
					},
					include_thinking: { type: 'boolean', description: 'Include the agent’s reasoning (default false).' },
					include_tools: {
						type: 'boolean',
						description: 'Include tool calls and failed tool output (default false).'
					}
				},
				required: ['session_id']
			},
			run: async args => {
				const sessionId = need(args, 'session_id')
				const near = str(args.near)
				const anchor = near ? parseChatCursor(near) : null
				if (near && anchor === null) throw new Error('near must be a cursor returned by search_chats')
				const count = (value: unknown, fallback: number) =>
					Math.min(100, Math.max(0, Math.floor(num(value) ?? fallback)))
				const before = count(args.before, 6)
				const after = count(args.after, 6)
				const limit = Math.min(400, Math.max(1, Math.floor(num(args.limit) ?? 12)))
				const maxChars = Math.min(40_000, Math.max(1_000, Math.floor(num(args.max_chars) ?? 12_000)))
				// One flag each, because they answer different questions: tools are what the agent
				// *did*, thinking is why it did it. Reading both off `include_tools` meant the only
				// way to see the reasoning was to take the tool churn along with it.
				const includeTools = args.include_tools === true
				const includeThinking = args.include_thinking === true
				const data = await call<MessagesResponse>(`${routes.messages.path(sessionId)}?after=0`, {
					timeoutMs: 30_000
				})
				if (anchor !== null && !data.entries.some(entry => entry.rowid === anchor)) {
					throw new Error('near cursor is not in that session')
				}
				const wanted = data.entries.filter(e => {
					if (e.role === 'thinking') return includeThinking
					// A successful result carries the call's output, which is the churn `include_tools`
					// exists to keep out of a context window — the call above it already says what ran.
					// A failed one stays: one line, and it is why the turn changed course.
					if (isToolResult(e) && !e.error) return false
					if (e.role === 'tool') return includeTools
					return true
				})
				if (!wanted.length) return `no messages in session ${sessionId}`

				let selected: TranscriptEntry[]
				const head: string[] = []
				if (anchor === null) {
					selected = wanted.slice(-limit)
					if (selected.length < wanted.length) {
						head.push(
							`(last ${selected.length} of ${wanted.length} entries · older_cursor: ${chatCursor(selected[0].rowid)})`
						)
					}
				} else {
					const older = wanted.filter(entry => entry.rowid < anchor)
					const at = wanted.filter(entry => entry.rowid === anchor)
					const newer = wanted.filter(entry => entry.rowid > anchor)
					selected = [...(before ? older.slice(-before) : []), ...at, ...newer.slice(0, after)]
					const parts = [
						`near ${near}`,
						`${Math.min(before, older.length)} before`,
						`${at.length} at`,
						`${Math.min(after, newer.length)} after`
					]
					if (older.length > before && selected[0]) parts.push(`older_cursor: ${chatCursor(selected[0].rowid)}`)
					if (newer.length > after && selected.at(-1)) {
						parts.push(`newer_cursor: ${chatCursor(selected.at(-1)!.rowid)}`)
					}
					head.push(`(${parts.join(' · ')})`)
				}

				if (!selected.length) {
					return boundedTranscript(head, ['(the matching entry is excluded by the current role filters)'], maxChars)
				}
				const rendered = selected.map(entry => {
					if (entry.role === 'tool')
						return `[tool ${entry.tool ?? ''}] ${clip(entry.text, 200)}${entry.detail ? ` — ${entry.detail}` : ''}`
					return `[${entry.role}] ${entry.text}`
				})
				return boundedTranscript(head, rendered, maxChars)
			}
		},
		{
			name: 'list_workspaces',
			description:
				'List the live (non-archived) Conductor workspaces with what each one is doing right now: agent status, model, branch, PR state, and any prompt the relay is still holding for it. Use this to see what is running before starting or steering anything.',
			inputSchema: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						description: 'Filter by live agent status: working | idle | error. Omit for all.'
					}
				}
			},
			run: async args => {
				const status = str(args.status)
				const data = await call<StateResponse>(routes.state.path())
				const shown = status ? data.workspaces.filter(w => w.session_status === status) : data.workspaces
				if (!shown.length) return status ? `no workspace is ${status}` : 'no live workspaces'
				return shown
					.map(w => {
						const lines = [
							`${w.session_status === 'working' ? '▶' : '·'} ${workspaceTitle(w)}`,
							`    ${[w.repo_name, w.branch, w.model, w.pr_number ? `PR #${w.pr_number} ${w.pr_status ?? ''}`.trim() : null].filter(Boolean).join(' · ')}`,
							`    workspace_id: ${w.id}${w.active_session_id ? `  session_id: ${w.active_session_id}` : ''}`
						]
						// An undelivered prompt is invisible from the DB — it lives in the relay's own
						// queues — so an agent reading only status would call a stalled workspace idle
						// and send a second copy of the prompt already waiting on it (dismiss_prompt).
						if (w.pending_prompt) {
							const p = w.pending_prompt
							lines.push(
								`    ! first prompt ${p.status}: ${clip(unmark(p.text), 120)}${p.error ? ` — ${p.error}` : ''}`
							)
						}
						for (const p of w.parked_prompts ?? []) {
							lines.push(
								`    ! prompt ${p.status} for session ${p.sessionId} (${p.reason}): ${clip(unmark(p.text), 120)}`
							)
						}
						return lines.join('\n')
					})
					.join('\n')
			}
		},
		{
			name: 'list_chats',
			description:
				'List the chat tabs in a workspace with each one’s status, model and how full its context window is. A workspace can hold several conversations, each with its own context; send_prompt and read_chat address one of them.',
			inputSchema: {
				type: 'object',
				properties: { workspace_id: { type: 'string' } },
				required: ['workspace_id']
			},
			run: async args => {
				const id = need(args, 'workspace_id')
				const data = await call<SessionsResponse>(routes.sessions.path(id))
				if (!data.sessions.length) return `no chats in workspace ${id}`
				// Context is per chat and only per chat — the same workspace can hold a tab at 85%
				// beside one at 28% — so it is printed on every row rather than summarised above.
				return data.sessions
					.map(s => {
						const ctx =
							typeof s.context_used_percent === 'number' && s.context_used_percent > 0
								? ` · ${Math.round(s.context_used_percent)}% context`
								: ''
						return `${s.status === 'working' ? '▶' : '·'} ${s.title ?? '(untitled)'} — ${s.status ?? '?'} · ${s.model ?? '?'}${ctx}\n    session_id: ${s.id}`
					})
					.join('\n')
			}
		},
		{
			name: 'workspace_diff',
			description: 'The git diff of a live workspace against its target branch, untracked files included.',
			inputSchema: {
				type: 'object',
				properties: { workspace_id: { type: 'string' } },
				required: ['workspace_id']
			},
			run: async args => {
				const id = need(args, 'workspace_id')
				const data = await call<WorkspaceDiff>(routes.diff.path(id), {
					timeoutMs: 30_000
				})
				if (!data.files.length) return 'no changes against the target branch'
				return data.files.map(f => `${f.path}  +${f.added} -${f.removed}`).join('\n')
			}
		},
		{
			name: 'list_repos',
			description:
				'The repos Conductor can create a workspace in. Use before create_workspace to get an exact repo name.',
			inputSchema: { type: 'object', properties: {} },
			run: async () => {
				const data = await call<ReposResponse>(routes.repos.path())
				return data.repos.map(r => `${r.name}  (${r.default_branch ?? '?'})  ${r.root_path ?? ''}`).join('\n')
			}
		},
		{
			name: 'create_workspace',
			description:
				'Start a new Conductor workspace in a repo, optionally with a first prompt and agent settings. The workspace starts from a Conductor deep link, so creation itself needs no Accessibility. The relay applies requested model, effort, plan, and fast settings through Conductor’s UI after it creates the first chat and before it delivers the prompt. Returns as soon as the workspace row exists (~2s), before the worktree is built.',
			inputSchema: {
				type: 'object',
				properties: {
					repo: { type: 'string', description: 'Exact name from list_repos.' },
					prompt: { type: 'string', description: 'First prompt for the new agent. Omit to open an empty workspace.' },
					model: {
						type: 'string',
						description:
							'Picker label from list_models with no session_id. The relay applies it before the first prompt, or configures an empty workspace once its chat exists.'
					},
					effort: {
						type: 'string',
						enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
						description: 'Reasoning effort applied before the first prompt.'
					},
					plan: { type: 'boolean', description: 'Start the first chat in Conductor’s Plan mode.' },
					fast: { type: 'boolean', description: 'Set Fast mode before the first prompt.' },
					wait_for_send: {
						type: 'boolean',
						description:
							'Block until the first prompt is actually delivered (tens of seconds, and longer behind other queued sends). Default false.'
					},
					send_immediately: {
						type: 'boolean',
						description:
							"Send the first prompt without waiting for the worktree to finish building, which is how Conductor's own New workspace box behaves. Default true. Pass false only when the agent's first move needs what the repo's setup script installs."
					}
				},
				required: ['repo']
			},
			run: async args => {
				const repo = need(args, 'repo')
				const prompt = str(args.prompt)
				const model = str(args.model)
				const effort = str(args.effort)
				const plan = typeof args.plan === 'boolean' ? args.plan : undefined
				const fast = typeof args.fast === 'boolean' ? args.fast : undefined
				const configured = model !== undefined || effort !== undefined || plan !== undefined || fast !== undefined
				const send = args.wait_for_send === true
				// Default on, matching the relay: an omitted flag must never mean "wait".
				const sendImmediately = args.send_immediately !== false
				const data = await call<CreateWorkspaceResult>(routes.createWorkspace.path(), {
					method: routes.createWorkspace.method,
					body: { repo, prompt, model, effort, plan, fast, send, sendImmediately },
					timeoutMs: send ? WRITE_TIMEOUT_MS : 30_000
				})
				const lines = [
					`created ${data.workspace ? workspaceTitle(data.workspace) : data.workspaceId}`,
					`workspace_id: ${data.workspaceId}`
				]
				if (data.warning) lines.push(`! ${data.warning}`)
				else if (data.pendingPrompt && !data.sent)
					lines.push('the first prompt is queued — the relay delivers it, so do not send it again')
				else if (data.sent) lines.push('the first prompt was delivered')
				if (configured) lines.push(data.configured ? 'agent settings applied' : 'agent settings queued')
				return lines.join('\n')
			}
		},
		{
			name: 'send_prompt',
			description:
				'Send a prompt into an existing Conductor chat, exactly as typing it on the Mac would. This DRIVES THE REAL UI: it focuses the workspace, selects the chat tab and presses Enter, so it steals focus for a few seconds. If that chat is already working, the message STEERS the running agent rather than starting a new turn — do not use it to poll or test. Ask the user before sending into a chat they did not name.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string', description: 'The chat to send to (list_chats / search_chats).' },
					workspace_id: {
						type: 'string',
						description: 'Its workspace. Strongly recommended: it is what the relay asserts against before typing.'
					},
					text: { type: 'string' }
				},
				required: ['session_id', 'text']
			},
			run: async args => {
				const sessionId = need(args, 'session_id')
				const text = need(args, 'text')
				const data = await call<SendResult>(routes.sendPrompt.path(sessionId), {
					method: routes.sendPrompt.method,
					body: { text, workspaceId: str(args.workspace_id) },
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (data.parked) return 'the Mac is locked — the prompt is parked and will be sent on unlock'
				if (!data.ok) throw new Error(data.error ?? 'the send did not land')
				return data.warning ? `sent (${data.warning})` : 'sent'
			}
		},
		{
			name: 'split_chat',
			description:
				'Move a tangent out of a chat: copy that chat into a fresh tab beside it, as a Conductor attachment, and ask the new agent your question there. Use it when a conversation has grown a second topic — a running agent steered mid-turn ends up holding three threads at once, which reads badly for everyone afterwards. The copy carries the prose and the reasoning, not the tool calls, so the new agent knows what was said and decided but not every file that was read. This DRIVES THE REAL UI twice (a new tab, then the send) and steals focus for a few seconds. To split the chat you are in, find its session_id with list_chats on your own workspace.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string', description: 'The chat to copy (list_chats / search_chats).' },
					prompt: { type: 'string', description: 'What to ask in the new tab.' },
					workspace_id: { type: 'string', description: 'Its workspace. Resolved from the chat when omitted.' },
					include_thinking: {
						type: 'boolean',
						description: 'Carry the agent’s reasoning across (default true — it is usually the useful half).'
					},
					include_tools: {
						type: 'boolean',
						description:
							'Carry tool calls across as one line each (default false — mostly noise, and most of the bytes).'
					}
				},
				required: ['session_id', 'prompt']
			},
			run: async args => {
				const sessionId = need(args, 'session_id')
				const prompt = need(args, 'prompt')
				const split = await call<SplitChatResult>(routes.splitChat.path(sessionId), {
					method: routes.splitChat.method,
					body: {
						prompt,
						workspaceId: str(args.workspace_id),
						includeThinking: args.include_thinking !== false,
						includeTools: args.include_tools === true
					},
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (!split.ok) throw new Error(split.error ?? 'the split did not open a tab')
				const { attachment: file } = split
				// Name the cut. A transcript that quietly dropped half the chat reads exactly
				// like a complete one to whoever gets it next.
				const cut = [
					file.elided.tools ? plural(file.elided.tools, 'tool call') : '',
					file.elided.thinking ? plural(file.elided.thinking, 'thinking block') : ''
				].filter(Boolean)
				const lines = [
					`copied ${plural(file.kept, 'entry', 'entries')} (${Math.round(file.bytes / 1024)}kB) to ${file.path}${
						cut.length ? `, without ${cut.join(' or ')}` : ''
					}`
				]
				// The tab exists either way, so every path below leaves the caller somewhere to
				// go rather than reporting a bare failure over work that half-happened.
				if (!split.sessionId) {
					lines.push('the new tab is open, but the relay could not read its id back')
					lines.push('find it with list_chats, then send_prompt the question yourself')
					return lines.join('\n')
				}
				lines.push(`session_id: ${split.sessionId}`)
				const sent = await call<SendResult>(routes.sendPrompt.path(split.sessionId), {
					method: routes.sendPrompt.method,
					body: { text: split.text, workspaceId: split.workspaceId },
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (sent.parked) lines.push('the Mac is locked — the prompt is parked and lands on unlock')
				else if (!sent.ok)
					lines.push(
						`! the tab and the transcript are ready, but the prompt did not land (${sent.error ?? 'unknown'}) — retry it with send_prompt`
					)
				else lines.push(sent.warning ? `sent (${sent.warning})` : 'sent')
				return lines.join('\n')
			}
		},
		{
			name: 'stop_turn',
			description:
				'Cancel the answer a chat is currently streaming — Conductor’s own "Cancel agent". Drives the real UI. A chat that already finished answers alreadyIdle, which is a success. This destroys the in-flight work of another agent, so ask the user first.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string' },
					workspace_id: {
						type: 'string',
						description: 'Required in practice — the relay asserts the pane against it before pressing.'
					}
				},
				required: ['session_id']
			},
			run: async args => {
				const sessionId = need(args, 'session_id')
				const data = await call<StopResult>(routes.stop.path(sessionId), {
					method: routes.stop.method,
					body: { workspaceId: str(args.workspace_id) },
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (data.alreadyIdle) return 'that chat had already finished — nothing to stop'
				if (!data.ok) throw new Error(data.error ?? 'the stop did not land')
				return 'stopped'
			}
		},
		{
			name: 'list_models',
			description:
				'The model labels the relay knows. With no session_id this returns its stored picker labels, grouped by harness; use it before create_workspace. With a session_id it reads that chat’s live Conductor picker and refreshes the stored labels. A live read DRIVES THE REAL UI — it focuses the workspace and opens the menu — so it costs a few seconds of stolen focus.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: {
						type: 'string',
						description: 'The chat whose live picker to read. Omit to use the relay cache.'
					},
					workspace_id: {
						type: 'string',
						description: 'Workspace holding session_id. Required when session_id is set.'
					}
				}
			},
			run: async args => {
				const sessionId = str(args.session_id)
				if (!sessionId) {
					const data = await call<ModelCatalogResponse>(routes.modelCatalog.path())
					if (!data.groups.length)
						return 'no models are cached yet — read a chat’s live picker with session_id and workspace_id'
					return data.groups
						.map(group => `## ${group.agentType}\n${group.models.map(model => `- ${model}`).join('\n')}`)
						.join('\n\n')
				}
				const workspaceId = need(args, 'workspace_id')
				const data = await call<ModelsResult>(
					`${routes.models.path(sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
					{ timeoutMs: WRITE_TIMEOUT_MS }
				)
				if (!data.ok) throw new Error(data.error ?? 'could not read the model menu')
				return data.models?.length ? data.models.join('\n') : 'the menu listed no models'
			}
		},
		{
			name: 'set_agent_options',
			description:
				'Change how a chat’s agent runs: model, reasoning effort, plan mode, fast mode. Conductor keeps these in its composer and nowhere else, so this is the only way to reach them — a prompt cannot. DRIVES THE REAL UI and steals focus for a few seconds. The change is confirmed against Conductor’s database before this answers. Applies to the NEXT turn, so set it before send_prompt, not during one. Ask the user before re-pointing a chat they did not name at a different model.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string' },
					workspace_id: {
						type: 'string',
						description: 'Strongly recommended: it is what the relay asserts against before pressing anything.'
					},
					model: { type: 'string', description: 'A label from list_models. An unambiguous prefix is enough.' },
					effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
					plan: { type: 'boolean', description: 'Conductor’s Plan checkbox.' },
					fast: {
						type: 'boolean',
						description: 'Fast mode. Only some models offer it; a missing button is reported, not ignored.'
					}
				},
				required: ['session_id']
			},
			run: async args => {
				const sessionId = need(args, 'session_id')
				const patch = {
					model: str(args.model),
					effort: str(args.effort),
					plan: typeof args.plan === 'boolean' ? args.plan : undefined,
					fast: typeof args.fast === 'boolean' ? args.fast : undefined,
					workspaceId: str(args.workspace_id)
				}
				if (
					patch.model === undefined &&
					patch.effort === undefined &&
					patch.plan === undefined &&
					patch.fast === undefined
				)
					throw new Error('nothing to change — pass at least one of model, effort, plan, fast')
				const data = await call<AgentResult>(routes.agent.path(sessionId), {
					method: routes.agent.method,
					body: patch,
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (!data.ok) throw new Error(data.error ?? 'the change did not land')
				// The re-read row is the receipt, so report *it* rather than what was asked for.
				const s = data.session
				return s
					? `now: ${[s.model, s.claude_effort_level, s.permission_mode, s.fast_mode ? 'fast' : null].filter(Boolean).join(' · ')}`
					: 'applied'
			}
		},
		{
			name: 'set_workspace_status',
			description:
				'Set a workspace’s status in Conductor’s sidebar (backlog, in-progress, in-review, done, canceled). Drives the real UI through the sidebar row menu, but changes nothing on screen. Fails if the sidebar section holding that row is collapsed, because a collapsed row is invisible to Accessibility and there is no fallback.',
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: { type: 'string' },
					status: { type: 'string', enum: ['backlog', 'in-progress', 'in-review', 'done', 'canceled'] }
				},
				required: ['workspace_id', 'status']
			},
			run: async args => {
				const id = need(args, 'workspace_id')
				const status = need(args, 'status')
				const data = await call<StatusResult>(routes.workspaceStatus.path(id), {
					method: routes.workspaceStatus.method,
					body: { status },
					timeoutMs: WRITE_TIMEOUT_MS
				})
				if (!data.ok) throw new Error(data.error ?? 'the status change did not land')
				return `status set to ${status}`
			}
		},
		{
			name: 'dismiss_prompt',
			description:
				'Throw away a prompt the relay is still holding — a new workspace’s first prompt waiting on setup, or one parked behind a locked Mac. Touches no UI. list_workspaces shows these; a failed one stays visible until it is dismissed, on purpose. Pass session_id for a parked prompt, workspace_id for a first prompt.',
			inputSchema: {
				type: 'object',
				properties: {
					session_id: { type: 'string', description: 'Dismiss the prompt parked for this chat.' },
					workspace_id: { type: 'string', description: 'Dismiss this workspace’s undelivered first prompt.' }
				}
			},
			run: async args => {
				const sessionId = str(args.session_id)
				const workspaceId = str(args.workspace_id)
				// Both would be two deletes wearing one name, and the caller could not tell which
				// half failed — so it is one or the other, never both.
				if (!sessionId && !workspaceId) throw new Error('pass session_id or workspace_id')
				if (sessionId && workspaceId) throw new Error('pass session_id or workspace_id, not both')
				const route = sessionId ? routes.dismissParkedPrompt : routes.dismissFirstPrompt
				await call<{ ok: boolean }>(route.path((sessionId ?? workspaceId) as string), { method: route.method })
				return 'dismissed'
			}
		},
		{
			name: 'keep_awake',
			description:
				'Read or set the window that holds this Mac awake with the lid shut. Touches no UI. This is what keeps the relay reachable at all, so a long unattended run wants it: without it a closed lid sleeps the Mac and every agent on it stops. Needs `conductor-remote nosleep setup` to have been run once; without that the status says so and holding fails. Releasing a window while the lid is shut sleeps the Mac straight away.',
			inputSchema: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: ['status', 'hold', 'release'],
						description: 'Default status.'
					},
					seconds: { type: 'number', description: 'How long to hold it awake. Required for hold.' }
				}
			},
			run: async args => {
				const action = str(args.action) ?? 'status'
				if (action === 'status') {
					const s = await call<NoSleepStatus>(routes.nosleep.path())
					if (!s.available) return 'unavailable — run `conductor-remote nosleep setup` on the Mac first'
					if (!s.armed) return `sleeping normally; a window can be up to ${s.maxSeconds}s`
					return `awake${s.until ? `, expires ${relative(s.until)}` : ' until stopped'} (pid ${s.pid})`
				}
				if (action === 'release') {
					const r = await call<NoSleepResult>(routes.disarmNoSleep.path(), { method: routes.disarmNoSleep.method })
					if (!r.ok) throw new Error(r.error ?? 'could not release the window')
					return r.willSleep ? 'released — the lid is shut, so the Mac is going to sleep now' : 'released'
				}
				if (action !== 'hold') throw new Error(`unknown action ${action}`)
				const seconds = num(args.seconds)
				if (seconds === undefined) throw new Error('seconds is required for hold')
				const r = await call<NoSleepResult>(routes.armNoSleep.path(), {
					method: routes.armNoSleep.method,
					body: { seconds }
				})
				if (!r.ok) throw new Error(r.error ?? 'could not hold the Mac awake')
				return `awake${r.state.until ? `, expires ${relative(r.state.until)}` : ''}`
			}
		},
		{
			name: 'relay_logs',
			description:
				'The relay’s own log — why a send failed, whether Conductor refused Accessibility, what the network did. Touches no UI. Default is the running relay’s captured console; `file` tails the daemon’s log on disk, which is the only place a *previous* process’s crash survives. Secrets are redacted before it leaves the relay.',
			inputSchema: {
				type: 'object',
				properties: {
					file: {
						type: 'string',
						enum: ['relay.log', 'relay.err.log'],
						description: 'Omit for this process’s live log.'
					},
					limit: { type: 'number', description: 'Most recent N lines. Default 200, max 2000.' },
					contains: {
						type: 'string',
						description: 'Keep only lines containing this (case-insensitive). Filtered here, not by the relay.'
					}
				}
			},
			run: async args => {
				const file = str(args.file)
				const limit = Math.min(2000, Math.max(1, Math.trunc(num(args.limit) ?? 200)))
				const q = new URLSearchParams({ limit: String(limit) })
				if (file) q.set('file', file)
				const data = await call<LogsResponse>(`${routes.logs.path()}?${q}`)
				const needle = str(args.contains)?.toLowerCase()
				const kept = needle ? data.entries.filter(e => e.text.toLowerCase().includes(needle)) : data.entries
				if (!kept.length) return needle ? `no line in ${data.source} matches ${needle}` : `${data.source} is empty`
				const lines = kept.map(
					e => `${stamp(e.t)} ${e.level === 'info' ? '' : `${e.level.toUpperCase()} `}${clip(e.text, 2000)}`
				)
				// Whose log this is decides what it proves: an unmanaged relay's files belong to a
				// *different* process, so a clean tail there says nothing about the one just called.
				const head = data.managed
					? data.source
					: `${data.source} (written by the LaunchAgent, not the relay just called)`
				return [`— ${head}, ${kept.length} lines —`, ...lines].join('\n')
			}
		}
	]
}

// ── JSON-RPC 2.0, transport-agnostic ───────────────────────────────────

export interface RpcRequest {
	jsonrpc: '2.0'
	id?: string | number | null
	method: string
	params?: Record<string, unknown>
}

export interface RpcResponse {
	jsonrpc: '2.0'
	id: string | number | null
	result?: unknown
	error?: { code: number; message: string }
}

const ok = (id: RpcRequest['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result })
const err = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({
	jsonrpc: '2.0',
	id: id ?? null,
	error: { code, message }
})

/**
 * Handle one JSON-RPC message. Returns null for a notification, which by spec takes
 * no reply at all — stdio writes nothing and HTTP answers 202.
 */
export async function handleRpc(tools: Tool[], req: RpcRequest): Promise<RpcResponse | null> {
	const notification = req.id === undefined || req.id === null
	switch (req.method) {
		case 'initialize': {
			const asked = str(req.params?.protocolVersion)
			return ok(req.id, {
				// Echo the client's version when we know it, else name our newest. A client
				// that can't live with the answer disconnects, which is the spec's own path.
				protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
				instructions: INSTRUCTIONS
			})
		}
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return null
		case 'ping':
			return notification ? null : ok(req.id, {})
		case 'tools/list':
			return ok(req.id, {
				tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
			})
		case 'tools/call': {
			const name = str(req.params?.name)
			const tool = tools.find(t => t.name === name)
			if (!tool) return err(req.id, -32602, `unknown tool: ${name}`)
			const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {}
			try {
				const text = await tool.run(args)
				return ok(req.id, { content: [{ type: 'text', text: text || '(no output)' }] })
			} catch (e) {
				// A tool failure is a result the model should see and can act on, not a
				// protocol error that would hide the reason behind a transport code.
				const message = e instanceof Error ? e.message : String(e)
				return ok(req.id, { content: [{ type: 'text', text: message }], isError: true })
			}
		}
		default:
			return notification ? null : err(req.id, -32601, `method not found: ${req.method}`)
	}
}
