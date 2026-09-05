import { routes } from '../../routes.ts'
import { isToolResult, timestampMs, workspaceTitle } from '../../shared.ts'
import { chatCursor, parseChatCursor } from '../../transcript/cursor.ts'
import type { TranscriptEntry } from '../../transcript/parser.ts'
import type { MessagesResponse, SearchResponse, SessionsResponse } from '../../wire.ts'
import { need, num, str } from '../arguments.ts'
import { boundedTranscript, clip, unmark } from '../formatters.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createSearchChatsTool(call: RelayCall): Tool {
	return {
		name: 'search_chats',
		description:
			'Full-text search every Conductor chat on this Mac, archived workspaces included, and get back the workspaces that discussed it with the matching excerpts. Use this to answer "which workspace did I do X in" or "what did we decide about X". Searches the prompts the user typed, the agent replies and the agent\'s reasoning, not tool output. Each excerpt is tagged [user], [assistant] or [thinking] — a [thinking] hit is reasoning the agent never said out loud, so do not quote it back as its answer. Every excerpt carries its own session_id and cursor for a bounded nearby read_chat.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description:
						'Plain words, ranked by relevance; wrap a "phrase in quotes" to require it word for word. Other punctuation and operators are ignored, not parsed.'
				},
				limit: { type: 'number', description: 'Max workspaces to return (default 12, max 50).' },
				repo: {
					type: 'string',
					description:
						'Only workspaces in this repo, by the exact name list_repos prints. Ranking happens inside the repo, so a rare mention there is not buried by busier repos.'
				}
			},
			required: ['query']
		},
		run: async args => {
			const query = need(args, 'query')
			const limit = num(args.limit)
			const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : null
			const params = new URLSearchParams({ q: query })
			if (limit) params.set('limit', String(limit))
			if (repo) params.set('repo', repo)
			const data = await call<SearchResponse>(`${routes.search.path()}?${params}`)

			const lines: string[] = []
			if (data.index.error) lines.push(`! chat index unavailable (${data.index.error}) — names matched only`)
			else if (!data.index.ready)
				lines.push(`! still indexing (${Math.round(data.index.progress * 100)}%) — older chats not searchable yet`)
			const scope = repo ? ` in ${repo}` : ''
			if (!data.results.length)
				return [...lines, `no workspace or chat matches ${JSON.stringify(query)}${scope}`].join('\n')

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
	}
}

export function createReadChatTool(call: RelayCall): Tool {
	return {
		name: 'read_chat',
		description:
			'Read a bounded Conductor chat transcript by session_id, newest messages last. Pass a cursor from search_chats, a prior read_chat, or a delegation handoff as near; before and after expand either direction or both together. Set after to 0 when reading a completed delegation to keep later follow-ups out. For a [thinking] search hit, set include_thinking true to include the matching block. Without near, returns the trailing entries. Works for archived workspaces. Tool calls and failed tool output are summarised to one line each; prose is verbatim unless the output budget truncates it.',
		inputSchema: {
			type: 'object',
			properties: {
				session_id: { type: 'string', description: 'From search_chats, list_chats, or a delegation handoff.' },
				near: { type: 'string', description: 'A cursor from search_chats, read_chat, or a delegation handoff.' },
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
			if (near && anchor === null) throw new Error('near must be a chat cursor')
			const count = (value: unknown, fallback: number) => Math.min(100, Math.max(0, Math.floor(num(value) ?? fallback)))
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
	}
}

export function createListChatsTool(call: RelayCall): Tool {
	return {
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
					// A chat waiting on a background task reads `idle` in `status` and will resume
					// itself; an agent that reads only the status would call it done and send a
					// second prompt into the wait.
					const waiting = (s.background_tasks ?? []).map(
						t =>
							`\n    waiting for task: ${t.description} (${Math.max(0, Math.round((Date.now() - timestampMs(t.since)) / 60_000))}m so far)`
					)
					const glyph = s.status === 'working' ? '▶' : waiting.length ? '⧗' : '·'
					const role = data.session_roles?.[s.id]
					return `${glyph} ${s.title ?? '(untitled)'} — ${s.status ?? '?'} · ${s.model ?? '?'}${role ? ` · role ${role.role}` : ''}${ctx}\n    session_id: ${s.id}${waiting.join('')}`
				})
				.join('\n')
		}
	}
}
