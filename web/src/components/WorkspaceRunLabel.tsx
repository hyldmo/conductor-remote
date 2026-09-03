import { Workflow } from 'lucide-react'
import { modelLabel } from '../lib/format.ts'
import type { CachedModelGroup, Workspace } from '../lib/types.ts'
import { ProviderMark } from './AgentIcons.tsx'

type WorkspaceRun = Pick<Workspace, 'agent_type' | 'delegations' | 'model' | 'pending_prompt' | 'session_roles'>

/**
 * A workflow belongs to the whole workspace, not whichever chat happens to be active.
 * Role identity survives successful jobs; the other two sources cover active work and
 * the creation window before the planning role can be written into the worktree.
 */
export function workspaceHasWorkflow(workspace: WorkspaceRun): boolean {
	return Boolean(
		workspace.pending_prompt?.sessionRole ||
			workspace.delegations?.length ||
			Object.keys(workspace.session_roles ?? {}).length
	)
}

/**
 * The picker labels to name this workspace's model with. Its own agent's list when
 * that picker has been read, and otherwise everything the relay has ever seen — an
 * id that several of those labels could name resolves to none of them
 * (`format.ts` ▸ `modelLabel`), so the wider list can't produce a wrong name.
 */
function catalogFor(groups: CachedModelGroup[] | undefined, agentType: string | null): string[] {
	if (!groups?.length) return []
	const own = groups.find(group => group.agentType === (agentType ?? 'unknown'))
	return own?.models ?? [...new Set(groups.flatMap(group => group.models))]
}

/** A workflow spans provider-backed chats, so no single active model can name it. */
export function WorkspaceRunLabel({
	workspace,
	modelGroups
}: {
	workspace: WorkspaceRun
	modelGroups: CachedModelGroup[] | undefined
}) {
	if (workspaceHasWorkflow(workspace)) {
		return (
			<span title="Delegated workflow" className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-accent">
				<Workflow size={13} aria-hidden="true" />
				<span className="truncate">Workflow</span>
			</span>
		)
	}

	const model = modelLabel(workspace.model, catalogFor(modelGroups, workspace.agent_type))
	if (!model) return null
	return (
		<span className="ml-auto flex min-w-0 items-center gap-1 text-[11px]">
			<ProviderMark agentType={workspace.agent_type} model={workspace.model} className="size-3" />
			<span className="truncate">{model}</span>
		</span>
	)
}
