import { routes } from '../../routes.ts'
import type { AgentResult, DefaultModelResult, ModelCatalogResponse, ModelsResult } from '../../wire.ts'
import { need, str } from '../arguments.ts'
import { WRITE_TIMEOUT_MS } from '../protocol.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createListModelsTool(call: RelayCall): Tool {
	return {
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
					.map(
						group =>
							`## ${group.agentType}\n${group.models.map(model => `- ${model}${model === data.defaultModel ? ' ★ default' : ''}`).join('\n')}`
					)
					.join('\n\n')
			}
			const workspaceId = need(args, 'workspace_id')
			const data = await call<ModelsResult>(
				`${routes.models.path(sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
				{ timeoutMs: WRITE_TIMEOUT_MS }
			)
			if (!data.ok) throw new Error(data.error ?? 'could not read the model menu')
			return data.models?.length
				? data.models.map(model => `${model}${model === data.defaultModel ? ' ★ default' : ''}`).join('\n')
				: 'the menu listed no models'
		}
	}
}

export function createSetDefaultModelTool(call: RelayCall): Tool {
	return {
		name: 'set_default_model',
		description:
			'Star a model as Conductor’s user-wide default. This mirrors the desktop picker’s combined “set as default and select” action, so it also switches the target chat to that model for its next turn. DRIVES THE REAL UI and changes a global preference — ask the user first.',
		inputSchema: {
			type: 'object',
			properties: {
				session_id: { type: 'string', description: 'Chat whose live model picker should be used.' },
				workspace_id: {
					type: 'string',
					description: 'Required in practice — the relay asserts the pane against it before pressing.'
				},
				model: { type: 'string', description: 'A label from list_models. An unambiguous prefix is enough.' }
			},
			required: ['session_id', 'workspace_id', 'model']
		},
		run: async args => {
			const sessionId = need(args, 'session_id')
			const workspaceId = need(args, 'workspace_id')
			const model = need(args, 'model')
			const data = await call<DefaultModelResult>(routes.defaultModel.path(sessionId), {
				method: routes.defaultModel.method,
				body: { workspaceId, model },
				timeoutMs: WRITE_TIMEOUT_MS
			})
			if (!data.ok) throw new Error(data.error ?? 'the default model did not change')
			return `${data.defaultModel ?? model} is now the default and selected for this chat`
		}
	}
}

export function createSetAgentOptionsTool(call: RelayCall): Tool {
	return {
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
				effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
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
	}
}
