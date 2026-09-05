import { Workflow } from 'lucide-react'
import { modelLabel } from '../../lib/format.ts'
import type {
	CachedModelGroup,
	DelegatedRole,
	PublicFrozenRole,
	RolesConfig,
	SessionRoleAssignment,
	WorkflowRoleName,
	Workspace
} from '../../lib/types.ts'
import { ProviderMark } from '../agents/AgentIcons.tsx'

type WorkspaceRun = Pick<Workspace, 'agent_type' | 'model' | 'workflow' | 'workflow_identity'> & {
	pending_prompt?: { sessionRole?: string } | null
	session_roles?: Record<string, Pick<SessionRoleAssignment, 'delegationId' | 'role'>>
}

type WorkflowRoleDisplay = Pick<DelegatedRole, 'model'> & Partial<Pick<PublicFrozenRole, 'agentType'>>
type WorkflowRoleDisplays = Partial<Record<WorkflowRoleName, WorkflowRoleDisplay>>

export const WORKFLOW_ROLE_ORDER = ['planning', 'exploration', 'implementation'] as const

/**
 * New runs carry an explicit coordinator projection. Before durable orchestration,
 * Workflow roots were persisted as an un-delegated planning assignment instead;
 * retain that narrow signature without mistaking an arbitrary delegated role for a
 * Workflow. The pending prompt covers the short creation window before either exists.
 */
export function workspaceHasWorkflow(workspace: WorkspaceRun): boolean {
	if (workspace.workflow || workspace.workflow_identity || workspace.pending_prompt?.sessionRole === 'planning')
		return true
	return Object.values(workspace.session_roles ?? {}).some(
		assignment => assignment.role === 'planning' && !assignment.delegationId
	)
}

const phaseLabel = (phase: NonNullable<WorkspaceRun['workflow']>['phase']): string => {
	if (phase === 'creating_workspace' || phase === 'binding_root' || phase === 'pending_root') return 'Accepted'
	return phase[0].toUpperCase() + phase.slice(1)
}

const roleLabel = (name: WorkflowRoleName): string =>
	name === 'planning' ? 'Planning' : name === 'exploration' ? 'Exploration' : 'Implementation'

function displayedWorkflowRoles(
	workspace: WorkspaceRun,
	configuredRoles: RolesConfig['roles'] | undefined
): Array<[WorkflowRoleName, WorkflowRoleDisplay]> {
	const roles: WorkflowRoleDisplays | undefined =
		workspace.workflow?.roles ?? workspace.workflow_identity?.roles ?? configuredRoles
	return WORKFLOW_ROLE_ORDER.flatMap(name => {
		const role = roles?.[name]
		return role ? [[name, role]] : []
	})
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
	modelGroups,
	configuredRoles
}: {
	workspace: WorkspaceRun
	modelGroups: CachedModelGroup[] | undefined
	configuredRoles?: RolesConfig['roles']
}) {
	if (workspaceHasWorkflow(workspace)) {
		const managedWorkflow = workspace.workflow ?? workspace.workflow_identity
		const phase = managedWorkflow ? phaseLabel(managedWorkflow.phase) : 'Workflow'
		const roles = displayedWorkflowRoles(workspace, configuredRoles)
		const description = [
			phase === 'Workflow' ? phase : `Workflow · ${phase}`,
			...roles.map(([name, role]) => `${roleLabel(name)}: ${role.model}`)
		].join(' · ')
		return (
			<span
				role="img"
				title={description}
				aria-label={description}
				className="isolate ml-auto flex shrink-0 -space-x-1"
			>
				<span
					data-workflow-icon
					className="relative z-40 flex size-[17px] shrink-0 items-center justify-center rounded-full bg-accent text-on-solid ring-1 ring-border"
				>
					<Workflow size={11} aria-hidden="true" />
				</span>
				{roles.map(([name, role], index) => (
					<span
						key={name}
						data-workflow-role={name}
						className="relative flex size-[17px] shrink-0 items-center justify-center rounded-full bg-surface text-text ring-1 ring-border"
						style={{ zIndex: WORKFLOW_ROLE_ORDER.length - index }}
					>
						<ProviderMark
							agentType={'agentType' in role ? (role.agentType ?? null) : null}
							model={role.model}
							className="size-2.5"
						/>
					</span>
				))}
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
