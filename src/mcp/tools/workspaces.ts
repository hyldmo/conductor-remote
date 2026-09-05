import { routes } from '../../routes.ts'
import { workspaceTitle } from '../../shared.ts'
import type {
	ArchiveResult,
	ContinueWorkspaceResult,
	CreateWorkspaceResult,
	DevServerResult,
	DevServerState,
	ReposResponse,
	StateResponse,
	StatusResult,
	WorkspaceDiff
} from '../../wire.ts'
import { need, rejectUnknown, str } from '../arguments.ts'
import { clip, formatDevServer, unmark } from '../formatters.ts'
import { WRITE_TIMEOUT_MS } from '../protocol.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createListWorkspacesTool(call: RelayCall): Tool {
	return {
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
					const assigned = w.active_session_id ? w.session_roles?.[w.active_session_id] : undefined
					const lines = [
						`${w.session_status === 'working' ? '▶' : '·'} ${workspaceTitle(w)}`,
						`    ${[w.repo_name, w.branch, w.model, assigned ? `role ${assigned.role}` : null, w.pr_number ? `PR #${w.pr_number} ${w.pr_status ?? ''}`.trim() : null].filter(Boolean).join(' · ')}`,
						`    workspace_id: ${w.id}${w.active_session_id ? `  session_id: ${w.active_session_id}` : ''}`
					]
					// An undelivered prompt is invisible from the DB — it lives in the relay's own
					// queues — so an agent reading only status would call a stalled workspace idle
					// and send a second copy of the prompt already waiting on it (dismiss_prompt).
					if (w.pending_prompt) {
						const p = w.pending_prompt
						lines.push(`    ! first prompt ${p.status}: ${clip(unmark(p.text), 120)}${p.error ? ` — ${p.error}` : ''}`)
					}
					for (const p of w.parked_prompts ?? []) {
						lines.push(
							`    ! prompt ${p.status} for session ${p.sessionId} (${p.reason}): ${clip(unmark(p.text), 120)}`
						)
					}
					for (const job of w.delegations ?? []) {
						lines.push(
							`    ${job.status === 'failed' ? '!' : '→'} delegation ${job.role}: ${job.status} (${job.id})${job.failure ? ` — ${job.failure.message}` : ''}`
						)
					}
					if (w.delegation_warning) lines.push(`    ! delegation state: ${w.delegation_warning}`)
					return lines.join('\n')
				})
				.join('\n')
		}
	}
}

export function createWorkspaceDiffTool(call: RelayCall): Tool {
	return {
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
	}
}

export function createListReposTool(call: RelayCall): Tool {
	return {
		name: 'list_repos',
		description:
			'The repos Conductor can create a workspace in. Use before create_workspace to get an exact repo name.',
		inputSchema: { type: 'object', properties: {} },
		run: async () => {
			const data = await call<ReposResponse>(routes.repos.path())
			return data.repos.map(r => `${r.name}  (${r.default_branch ?? '?'})  ${r.root_path ?? ''}`).join('\n')
		}
	}
}

export function createCreateWorkspaceTool(call: RelayCall): Tool {
	return {
		name: 'create_workspace',
		description:
			'Start an ordinary new Conductor workspace in a repo, optionally with a first prompt and agent settings. The workspace starts from a Conductor deep link, so creation itself needs no Accessibility. The relay applies requested model, effort, plan, and fast settings through Conductor’s UI after it creates the first chat and before it delivers the prompt. This utility cannot start or join a Workflow. Returns as soon as the workspace row exists (~2s), before the worktree is built.',
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
					enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
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
			required: ['repo'],
			additionalProperties: false
		},
		run: async args => {
			rejectUnknown(args, ['repo', 'prompt', 'model', 'effort', 'plan', 'fast', 'wait_for_send', 'send_immediately'])
			const repo = need(args, 'repo')
			const prompt = str(args.prompt)
			const model = str(args.model)
			const effort = str(args.effort)
			const plan = typeof args.plan === 'boolean' ? args.plan : undefined
			const fast = typeof args.fast === 'boolean' ? args.fast : undefined
			const explicitAgent = model !== undefined || effort !== undefined || plan !== undefined || fast !== undefined
			const configured = explicitAgent
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
	}
}

export function createSetWorkspaceStatusTool(call: RelayCall): Tool {
	return {
		name: 'set_workspace_status',
		description:
			'Set a workspace’s status in Conductor’s sidebar (backlog, in-progress, in-review, done, canceled). Drives the real UI through the sidebar row menu, but changes nothing on screen. A collapsed section hides its rows from Accessibility, so folded sections are opened, used, and folded back — which makes this run a few seconds longer.',
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
	}
}

export function createDevServerTool(call: RelayCall): Tool {
	return {
		name: 'dev_server',
		description:
			'Inspect, start or stop a workspace’s configured Conductor Run task and tailnet preview. Use this instead of launching a long-lived development server from a shell: Conductor supplies the workspace ports, enforces run-mode rules and owns process cleanup, while the relay avoids duplicate starts. Status is the default and touches no UI. Start and stop DRIVE THE REAL UI and can steal focus for a few seconds; confirm before controlling a workspace the user did not name. Starting requires Tailscale and, when status lists multiple Run configs, an exact run_config_id.',
		inputSchema: {
			type: 'object',
			properties: {
				workspace_id: { type: 'string', description: 'The live local workspace to control.' },
				action: {
					type: 'string',
					enum: ['status', 'start', 'stop'],
					description: 'Default status. Start and stop use Conductor’s managed Run task.'
				},
				run_config_id: {
					type: 'string',
					description: 'Exact ID printed by status. Only valid for start; required when more than one is listed.'
				}
			},
			required: ['workspace_id']
		},
		run: async args => {
			const id = need(args, 'workspace_id')
			const action = str(args.action) ?? 'status'
			if (action !== 'status' && action !== 'start' && action !== 'stop') throw new Error('action is invalid')
			const runConfigId = str(args.run_config_id)
			if (args.run_config_id !== undefined && !runConfigId) throw new Error('run_config_id must be a non-empty string')
			if (runConfigId && action !== 'start') throw new Error('run_config_id is only valid with action start')

			if (action === 'status') {
				const state = await call<DevServerState>(routes.devServer.path(id))
				return formatDevServer(state)
			}

			const route = action === 'start' ? routes.startDevServer : routes.stopDevServer
			const result = await call<DevServerResult>(route.path(id), {
				method: route.method,
				...(action === 'start' && runConfigId ? { body: { runConfigId } } : {}),
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!result.ok) throw new Error(result.error ?? `could not ${action} the dev server`)
			const headline =
				action === 'start'
					? result.changed === false
						? 'already running'
						: 'started'
					: result.changed === false
						? 'already stopped'
						: 'stopped'
			return formatDevServer(result, headline)
		}
	}
}

export function createContinueWorkspaceTool(call: RelayCall): Tool {
	return {
		name: 'continue_workspace',
		description:
			'Press Conductor’s own Continue action on a workspace whose PR merged — keeps the workspace id, worktree and chats, moves to a fresh branch and stages Branch continued.md in the selected chat. Drives the real UI: it focuses the workspace on the Mac first, so confirm with the user before continuing one they did not name. Only Conductor draws this action, after GitHub reports the PR merged; anything else is refused.',
		inputSchema: {
			type: 'object',
			properties: {
				workspace_id: { type: 'string' },
				session_id: {
					type: 'string',
					description: 'The chat to continue from. Defaults to the workspace’s active chat.'
				}
			},
			required: ['workspace_id']
		},
		run: async args => {
			const id = need(args, 'workspace_id')
			const data = await call<ContinueWorkspaceResult>(routes.continueWorkspace.path(id), {
				method: routes.continueWorkspace.method,
				body: { sessionId: str(args.session_id) },
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!data.ok) throw new Error(data.error ?? 'the continue did not land')
			const branch = data.workspace?.branch
			return branch ? `continued${data.previousBranch ? ` from ${data.previousBranch}` : ''} on ${branch}` : 'continued'
		}
	}
}

export function createArchiveWorkspaceTool(call: RelayCall): Tool {
	return {
		name: 'archive_workspace',
		description:
			'Archive a workspace — Conductor’s own ⌘⇧A, which deletes its worktree and takes any agent still working in it down with it. The chat survives archiving and stays readable through search_chats and read_chat. Drives the real UI: it focuses the workspace on the Mac first, so confirm with the user before archiving one they did not name. A workspace with an agent working is refused unless stop_agents is true.',
		inputSchema: {
			type: 'object',
			properties: {
				workspace_id: { type: 'string' },
				stop_agents: {
					type: 'boolean',
					description: 'Archive even though agents are still working here, ending their turns.'
				}
			},
			required: ['workspace_id']
		},
		run: async args => {
			const id = need(args, 'workspace_id')
			const data = await call<ArchiveResult>(routes.archiveWorkspace.path(id), {
				method: routes.archiveWorkspace.method,
				body: { stopAgents: args.stop_agents === true },
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!data.ok) throw new Error(data.error ?? 'the archive did not land')
			if (data.alreadyArchived) return 'already archived'
			return `archived ${data.workspace ? workspaceTitle(data.workspace) : id}`
		}
	}
}
