import { routes } from '../../routes.ts'
import type { LogsResponse, NoSleepResult, NoSleepStatus, PlanUsageResponse } from '../../wire.ts'
import { num, str } from '../arguments.ts'
import { clip, relative, stamp } from '../formatters.ts'
import type { RelayCall, Tool } from '../types.ts'

export function createPlanUsageTool(call: RelayCall): Tool {
	return {
		name: 'plan_usage',
		description:
			'Read rolling Claude Code and Codex subscription allowances from their local CLIs: percentage used and reset time. Sends no model prompt and touches no Conductor UI. Cursor Agent and OpenCode explain why no comparable plan quota is available.',
		inputSchema: { type: 'object', properties: {} },
		run: async () => {
			const data = await call<PlanUsageResponse>(routes.planUsage.path(), { timeoutMs: 15_000 })
			const sections = data.providers.map(provider => {
				const head = `## ${provider.label}${provider.plan ? ` · ${provider.plan}` : ''}`
				if (provider.status !== 'available') return `${head}\n${provider.message ?? 'unavailable'}`
				const lines = provider.buckets.flatMap(bucket =>
					bucket.windows.map(window => {
						const bucketName = provider.buckets.length > 1 ? `${bucket.label} — ` : ''
						const reset =
							window.resetsAt === null ? 'reset unavailable' : `resets ${new Date(window.resetsAt).toISOString()}`
						return `- ${bucketName}${window.label}: ${Math.round(window.usedPercent)}% used · ${reset}`
					})
				)
				return `${head}\n${lines.join('\n')}`
			})
			return `${sections.join('\n\n')}\n\nupdated ${new Date(data.fetchedAt).toISOString()}`
		}
	}
}

export function createDismissPromptTool(call: RelayCall): Tool {
	return {
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
	}
}

export function createKeepAwakeTool(call: RelayCall): Tool {
	return {
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
	}
}

export function createRelayLogsTool(call: RelayCall): Tool {
	return {
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
			const head = data.managed ? data.source : `${data.source} (written by the LaunchAgent, not the relay just called)`
			return [`— ${head}, ${kept.length} lines —`, ...lines].join('\n')
		}
	}
}
