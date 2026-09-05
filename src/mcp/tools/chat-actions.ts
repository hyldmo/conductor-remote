import { routes } from '../../routes.ts'
import { parseChatCursor } from '../../transcript/cursor.ts'
import type { CloseChatResult, SendResult, SplitChatResult, StopResult } from '../../wire.ts'
import { need, rejectUnknown, str } from '../arguments.ts'
import { plural } from '../formatters.ts'
import { WRITE_TIMEOUT_MS } from '../protocol.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createSendPromptTool(call: RelayCall): Tool {
	return {
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
			required: ['session_id', 'text'],
			additionalProperties: false
		},
		run: async args => {
			rejectUnknown(args, ['session_id', 'workspace_id', 'text'])
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
	}
}

export function createSplitChatTool(call: RelayCall): Tool {
	return {
		name: 'split_chat',
		description:
			'Move a tangent out of a chat: copy that chat as a Conductor attachment and ask the new agent your question there. By default it opens a fresh tab beside the source (same files); new_workspace creates a separate Conductor workspace and carries the source worktree’s current tracked and untracked-not-ignored files into it. The transcript copy carries prose and reasoning, not tool calls, and runs to the end unless through names an earlier message. A tab fork DRIVES THE REAL UI twice (new tab, then send); a workspace fork creates through a deep link, then drives the UI for the send. Both steal focus. To split the chat you are in, find its session_id with list_chats on your own workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				session_id: { type: 'string', description: 'The chat to copy (list_chats / search_chats).' },
				prompt: { type: 'string', description: 'What to ask in the new destination.' },
				workspace_id: { type: 'string', description: 'Its workspace. Resolved from the chat when omitted.' },
				include_thinking: {
					type: 'boolean',
					description: 'Carry the agent’s reasoning across (default true — it is usually the useful half).'
				},
				include_tools: {
					type: 'boolean',
					description: 'Carry tool calls across as one line each (default false — mostly noise, and most of the bytes).'
				},
				new_workspace: {
					type: 'boolean',
					description:
						'Create a separate workspace carrying the source’s current code (default false: a new tab with the same files).'
				},
				through: {
					type: 'string',
					description:
						'Stop the copy at this message, it included — a cursor from read_chat or search_chats. Default: the whole chat.'
				}
			},
			required: ['session_id', 'prompt']
		},
		run: async args => {
			const sessionId = need(args, 'session_id')
			const prompt = need(args, 'prompt')
			const through = str(args.through)
			const destination = args.new_workspace === true ? 'workspace' : 'chat'
			const throughRowid = through ? parseChatCursor(through) : null
			if (through && throughRowid === null) {
				throw new Error('through must be a cursor returned by read_chat or search_chats')
			}
			const split = await call<SplitChatResult>(routes.splitChat.path(sessionId), {
				method: routes.splitChat.method,
				body: {
					prompt,
					workspaceId: str(args.workspace_id),
					includeThinking: args.include_thinking !== false,
					includeTools: args.include_tools === true,
					throughRowid: throughRowid ?? undefined,
					destination
				},
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!split.ok) throw new Error(split.error ?? 'the split did not open its destination')
			const { attachment: file } = split
			// Name the cut. A transcript that quietly dropped half the chat reads exactly
			// like a complete one to whoever gets it next.
			const cut = [
				file.elided.tools ? plural(file.elided.tools, 'tool call') : '',
				file.elided.thinking ? plural(file.elided.thinking, 'thinking block') : '',
				file.elided.earlier ? plural(file.elided.earlier, 'entry before the cut', 'entries before the cut') : '',
				file.elided.later ? plural(file.elided.later, 'entry after the cut', 'entries after the cut') : ''
			].filter(Boolean)
			const lines = [
				`copied ${plural(file.kept, 'entry', 'entries')} (${Math.round(file.bytes / 1024)}kB) to ${file.path}${
					cut.length ? `, without ${cut.join(' or ')}` : ''
				}`,
				...(destination === 'workspace' ? [`workspace_id: ${split.workspaceId} (current code carried across)`] : [])
			]
			// The destination exists either way, so every path below leaves the caller somewhere to
			// go rather than reporting a bare failure over work that half-happened.
			if (!split.sessionId) {
				lines.push(`the new ${destination} is open, but the relay could not read its chat id back`)
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
					`! the ${destination} and transcript are ready, but the prompt did not land (${sent.error ?? 'unknown'}) — retry it with send_prompt`
				)
			else lines.push(sent.warning ? `sent (${sent.warning})` : 'sent')
			return lines.join('\n')
		}
	}
}

export function createStopTurnTool(call: RelayCall): Tool {
	return {
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
	}
}

export function createCloseChatTool(call: RelayCall): Tool {
	return {
		name: 'close_chat',
		description:
			'Close one visible Conductor chat tab. This hides the tab but keeps its transcript; it can be reopened in Conductor with ⌘⇧T. DRIVES THE REAL UI and steals focus for a few seconds. A running chat is refused unless close_running is true, matching Conductor’s own “Close anyway” confirmation — only set it after the user confirms.',
		inputSchema: {
			type: 'object',
			properties: {
				session_id: { type: 'string', description: 'The visible chat tab to close.' },
				workspace_id: {
					type: 'string',
					description: 'Workspace holding the chat. The relay verifies it when provided.'
				},
				close_running: {
					type: 'boolean',
					description: 'Close even though its agent is still working. Requires explicit user confirmation.'
				}
			},
			required: ['session_id']
		},
		run: async args => {
			const sessionId = need(args, 'session_id')
			const data = await call<CloseChatResult>(routes.closeChat.path(sessionId), {
				method: routes.closeChat.method,
				body: {
					workspaceId: str(args.workspace_id),
					closeRunning: args.close_running === true
				},
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!data.ok) throw new Error(data.error ?? 'the chat tab did not close')
			if (data.alreadyClosed) return 'already closed'
			return data.activeSessionId ? `closed; active session_id: ${data.activeSessionId}` : 'closed; no tabs remain'
		}
	}
}
