import { Workflow } from 'lucide-react'
import { modelLabel } from '../lib/format.ts'
import type { CachedModelGroup, Workspace } from '../lib/types.ts'
import { ProviderMark } from './AgentIcons.tsx'

type WorkspaceRun = Pick<Workspace, 'agent_type' | 'model' | 'workflow'>

/**
 * A Workflow belongs to the whole workspace and is identified only by the
 * coordinator's explicit projection. Legacy delegation jobs and role chips do not
 * silently turn an ordinary workspace into a Workflow.
 */
export function workspaceHasWorkflow(workspace: WorkspaceRun): boolean {
	return !!workspace.workflow
}

const phaseLabel = (phase: NonNullable<WorkspaceRun['workflow']>['phase']): string => {
	if (phase === 'creating_workspace' || phase === 'binding_root' || phase === 'pending_root') return 'Accepted'
	return phase[0].toUpperCase() + phase.slice(1)
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
		const phase = workspace.workflow ? phaseLabel(workspace.workflow.phase) : 'Workflow'
		return (
			<span
				title={`Managed Workflow · ${phase}`}
				className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-accent"
			>
				<Workflow size={13} aria-hidden="true" />
				<span className="truncate">Workflow · {phase}</span>
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
