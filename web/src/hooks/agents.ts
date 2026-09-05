import { useQuery, useQueryClient } from '@tanstack/react-query'
import { client } from '../lib/api.ts'
import type {
	AgentsResponse,
	ContextBreakdownResponse,
	ModelCatalogResponse,
	ModelDefaultsResponse,
	RolesResponse,
	RoutingConfigResponse,
	Session,
	ToolUsageRange,
	WorkflowRoleName
} from '../lib/types.ts'

/**
 * Picker labels already read from Conductor, kept by the relay rather than this
 * browser. A new workspace has no session to inspect, so it reads this catalog.
 */
export function useModelCatalog() {
	return useQuery<ModelCatalogResponse>({
		queryKey: ['model-catalog'],
		queryFn: client.modelCatalog,
		staleTime: 60_000,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}

export function useAutoModelConfig() {
	return useQuery({ queryKey: ['auto-model-config'], queryFn: client.autoModelConfig, staleTime: 60_000, retry: false })
}

/** Canonical agent definitions and routing globals, read without opening the Mac UI. */
export function useAgents() {
	return useQuery<AgentsResponse>({ queryKey: ['agents'], queryFn: client.agents, staleTime: 30_000, retry: false })
}

export function useRouting() {
	return useQuery<RoutingConfigResponse>({
		queryKey: ['routing'],
		queryFn: client.routing,
		staleTime: 30_000,
		retry: false
	})
}

/** Provider-specific defaults shown by both the Models sheet and the new-chat composer. */
export function useModelDefaults() {
	return useQuery<ModelDefaultsResponse>({
		queryKey: ['model-defaults'],
		queryFn: client.modelDefaults,
		// Preserve the last read for an instant first paint, but check the user settings
		// again whenever either surface opens because Conductor may edit them itself.
		staleTime: 0,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}

/** Provider plan limits are fetched only while their sheet is open, never on the workspace poll. */
export function usePlanUsage(enabled: boolean) {
	return useQuery({
		queryKey: ['plan-usage'],
		queryFn: () => client.planUsage(),
		enabled,
		staleTime: 60_000,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}

/** Recent tool traffic is scanned only while Models is open. */
export function useToolUsage(range: ToolUsageRange) {
	return useQuery({
		queryKey: ['tool-usage', range],
		queryFn: () => client.toolUsage(range),
		staleTime: 60_000,
		retry: false
	})
}

/** Full-history sizing is fetched only for the visible chat or while its context sheet is open. */
export function useContextBreakdown(sessionId: string, enabled = true, revision?: string | null) {
	return useQuery<ContextBreakdownResponse>({
		queryKey: ['context-breakdown', sessionId, revision ?? null],
		queryFn: () => client.contextBreakdown(sessionId),
		enabled: enabled && !!sessionId,
		// Reopening after another turn should re-read Conductor's newly persisted total.
		staleTime: 0,
		retry: false
	})
}

/** Relay-owned cross-provider roles. They change only through the Roles sheet/MCP. */
export function useRoles(enabled = true) {
	return useQuery<RolesResponse>({
		queryKey: ['roles'],
		queryFn: client.roles,
		enabled,
		staleTime: 30_000,
		retry: false
	})
}

const REQUIRED_WORKFLOW_ROLES = [
	'planning',
	'exploration',
	'implementation'
] as const satisfies readonly WorkflowRoleName[]

export function useWorkflowRoleReadiness(enabled = true) {
	const roles = useRoles(enabled)
	const missing = roles.data ? REQUIRED_WORKFLOW_ROLES.find(name => !roles.data.roles[name]) : undefined
	const issue = roles.data?.issues.find(candidate => REQUIRED_WORKFLOW_ROLES.some(name => name === candidate.role))
	const problem = roles.isError
		? 'Could not load delegated roles.'
		: (roles.data?.warning ?? (missing ? `Workflow needs a configured ${missing} role.` : issue?.error.message))
	return {
		roles,
		planningRole: roles.data?.roles.planning,
		problem,
		ready: REQUIRED_WORKFLOW_ROLES.every(name => !!roles.data?.roles[name]) && !problem
	}
}

/**
 * Conductor's live model list, stale-while-revalidate through the relay cache.
 *
 * Reading it live opens the real picker on the Mac (AppleScript, seconds, stolen
 * focus), so this only runs while the picker is open. A successful read updates
 * the persisted relay cache, which serves the next browser and new workspace.
 */
export function useModels(session: Session | undefined, workspaceId: string, enabled: boolean) {
	const agentType = session?.agent_type ?? 'claude'
	const queryClient = useQueryClient()
	return useQuery({
		queryKey: ['models', agentType],
		queryFn: async () => {
			const r = await client.models((session as Session).id, workspaceId)
			if (!r.ok || !r.models?.length) throw new Error(r.error ?? 'could not read the model list')
			await queryClient.invalidateQueries({ queryKey: ['model-catalog'] })
			return r
		},
		enabled: enabled && !!session,
		staleTime: 0,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}
