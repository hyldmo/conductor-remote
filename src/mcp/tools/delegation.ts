import { routes } from '../../routes.ts'
import { parseChatCursor } from '../../transcript/cursor.ts'
import type {
	DelegateTaskRequest,
	DelegateTaskResult,
	DelegationsResponse,
	RolesResponse,
	WorkflowDelegateRequest,
	WorkflowDelegateResult
} from '../../wire.ts'
import { need, rejectUnknown, str } from '../arguments.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createListRolesTool(call: RelayCall): Tool {
	return {
		name: 'list_roles',
		description:
			'List configured models, effort, Fast mode, instructions, and validation issues before lightweight delegation. Choose a role whose current configuration fits the task. Invalid roles cannot start a child or new Workflow. Active Workflows use the frozen roles from their root envelope.',
		inputSchema: { type: 'object', properties: {} },
		run: async () => {
			const data = await call<RolesResponse>(routes.roles.path())
			const issueByRole = new Map(data.issues.map(issue => [issue.role, issue.error]))
			const lines = Object.entries(data.roles).map(([name, role]) => {
				const settings = [role.model, role.effort, role.fast === undefined ? null : role.fast ? 'fast on' : 'fast off']
					.filter(Boolean)
					.join(' · ')
				const issue = issueByRole.get(name)
				const instructions = role.preamble?.trim()
				return `${issue ? '!' : '·'} ${name}: ${settings}${issue ? ` — ${issue.code}: ${issue.message}` : ''}${instructions ? `\n    Instructions: ${instructions.replaceAll('\n', '\n    ')}` : ''}`
			})
			if (data.warning) lines.unshift(`! ${data.warning}`)
			return lines.join('\n') || 'no delegated roles are configured'
		}
	}
}

export function createDelegateTaskTool(call: RelayCall): Tool {
	return {
		name: 'delegate_task',
		description:
			'Spawn one lightweight tracked sibling chat in a subtab. From an ordinary chat, pass session_id, a valid role from list_roles, and a focused prompt. Choose a configured role whose instructions fit the task; repeat for independent questions so children can run concurrently. This does not start a Workflow or turn the parent into a planner. The role must use a different provider than the parent. The child follows the configured preamble and assignment, receives a transcript attachment, and returns its result. Queue mode delivers behind the current turn by default; use steer if the result is needed during this turn. Keep working and integrate the result. For an active Workflow, only its root may call with workflow_id and current phase_capability from the private envelope; its frozen settings, role restrictions, transcript boundary, and Baton routing apply. Returns immediately with a delegation id; list_delegations observes progress. The relay later opens/configures/sends the child through the Mac UI. This tool cannot start or recover a Workflow.',
		inputSchema: {
			type: 'object',
			properties: {
				workflow_id: { type: 'string', description: 'Active Workflow only: id from the private root envelope.' },
				phase_capability: {
					type: 'string',
					description: 'Opaque current-phase capability from that same envelope; never copy it elsewhere.'
				},
				session_id: { type: 'string', description: 'Parent chat id; an active Workflow requires its root session.' },
				role: { type: 'string', description: 'Configured role name. Workflows allow exploration or implementation.' },
				prompt: {
					type: 'string',
					description: 'The independent question or implementation brief, including file ownership for edits.'
				},
				return_mode: {
					type: 'string',
					enum: ['queue', 'steer'],
					description:
						'Ordinary chats only. Queue the Baton behind this turn (default), or steer it into a running turn.'
				},
				through: {
					type: 'string',
					description: 'Ordinary chats only. Optional read_chat cursor bounding the transcript handoff.'
				},
				include_thinking: {
					type: 'boolean',
					description: 'Ordinary chats only. Include parent reasoning in the handoff (default false).'
				}
			},
			required: ['session_id', 'role', 'prompt'],
			additionalProperties: false
		},
		run: async args => {
			if (!Object.hasOwn(args, 'workflow_id') && !Object.hasOwn(args, 'phase_capability')) {
				rejectUnknown(args, ['session_id', 'role', 'prompt', 'return_mode', 'through', 'include_thinking'])
				const sessionId = need(args, 'session_id')
				if (args.return_mode !== undefined && args.return_mode !== 'queue' && args.return_mode !== 'steer') {
					throw new Error('return_mode must be queue or steer')
				}
				if (args.include_thinking !== undefined && typeof args.include_thinking !== 'boolean') {
					throw new Error('include_thinking must be a boolean')
				}
				const through = args.through === undefined ? undefined : parseChatCursor(need(args, 'through'))
				if (through === null) throw new Error('through must be a read_chat cursor')
				const body = {
					role: need(args, 'role'),
					prompt: need(args, 'prompt'),
					...(args.return_mode === undefined ? {} : { returnMode: args.return_mode }),
					...(through === undefined ? {} : { throughRowid: through }),
					...(args.include_thinking === undefined ? {} : { includeThinking: args.include_thinking })
				} satisfies DelegateTaskRequest
				const result = await call<DelegateTaskResult>(routes.delegateTask.path(sessionId), {
					method: routes.delegateTask.method,
					body
				})
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
				return `delegation ${result.delegationId} queued · ${result.role} · ${result.model}`
			}
			rejectUnknown(args, ['workflow_id', 'phase_capability', 'session_id', 'role', 'prompt'])
			const workflowId = need(args, 'workflow_id')
			const sessionId = need(args, 'session_id')
			const role = need(args, 'role')
			if (role !== 'exploration' && role !== 'implementation') throw new Error('role is invalid')
			const body = {
				workflow_id: workflowId,
				phase_capability: need(args, 'phase_capability'),
				session_id: sessionId,
				role,
				prompt: need(args, 'prompt')
			} satisfies WorkflowDelegateRequest
			const result = await call<WorkflowDelegateResult>(routes.workflowDelegation.path(workflowId), {
				method: routes.workflowDelegation.method,
				body
			})
			if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
			return `delegation ${result.delegationId} queued · ${result.role} · ${result.model}`
		}
	}
}

export function createListDelegationsTool(call: RelayCall): Tool {
	return {
		name: 'list_delegations',
		description:
			'List active and failed delegated jobs. Successful jobs leave their chats and role chips, not a second history log.',
		inputSchema: {
			type: 'object',
			properties: { workspace_id: { type: 'string', description: 'Optional workspace filter.' } }
		},
		run: async args => {
			const workspaceId = str(args.workspace_id)
			const suffix = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
			const data = await call<DelegationsResponse>(`${routes.delegations.path()}${suffix}`)
			if (!data.delegations.length) return 'no active or failed delegations'
			return data.delegations
				.map(job => {
					const child = job.childSessionId ? ` · child ${job.childSessionId}` : ''
					const failure = job.failure ? ` · ${job.failure.code}: ${job.failure.message}` : ''
					return `${job.status} · ${job.role} · ${job.resolvedRole.model} · ${job.id}${child}${failure}`
				})
				.join('\n')
		}
	}
}
