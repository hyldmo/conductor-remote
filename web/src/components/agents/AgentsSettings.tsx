import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Plus, Save, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { currentModelCatalog } from '../../../../src/shared.ts'
import { useAgents, useModelCatalog, useRouting } from '../../hooks/agents.ts'
import { importAgentDefinitions, mergeImportedAgents } from '../../lib/agent-import.ts'
import {
	agentRoutingLock,
	copyAgents,
	isRoutableAgent,
	MAX_AGENTS,
	newAgentProblem,
	normalizeAgentName,
	routerModelProblem,
	routingDraftProblems,
	saveAgentsSettings
} from '../../lib/agents-settings.ts'
import { roleAgentType, roleDraftCanSave, roleModelProblem } from '../../lib/role-editor.ts'
import type {
	AgentDefinition,
	AgentsConfig,
	AgentsResponse,
	ImportAgentsRequest,
	RoutingConfig
} from '../../lib/types.ts'
import { BetaBadge } from '../BetaBadge.tsx'
import { Spinner } from '../ui.tsx'
import { AgentEditorCard } from './AgentEditorCard.tsx'
import { AgentsImport } from './AgentsImport.tsx'
import { RoutingSettingsSection } from './RoutingSettingsSection.tsx'

const errorClass = 'rounded-xl border border-del/40 bg-del/5 p-3 text-xs text-del'

/** One draft editor for the canonical roster and routing globals. Saving never drives the Mac UI. */
export function AgentsSettings({
	onClose,
	initial = 'agents'
}: {
	onClose: () => void
	initial?: 'agents' | 'routing'
}) {
	const queryClient = useQueryClient()
	const agentsQuery = useAgents()
	const routingQuery = useRouting()
	const modelCatalog = useModelCatalog()
	const [draft, setDraft] = useState<AgentsConfig>()
	const [routingDraft, setRoutingDraft] = useState<RoutingConfig>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [saveIssues, setSaveIssues] = useState<AgentsResponse['issues']>([])
	const [routingSaveIssues, setRoutingSaveIssues] = useState<string[]>([])
	const [newAgent, setNewAgent] = useState('')
	const routingSection = useRef<HTMLElement>(null)
	const scrolled = useRef(false)
	const saving = useRef(false)
	const config = draft ?? agentsQuery.data
	const routing = routingDraft ?? routingQuery.data?.config
	const agentsDirty =
		!!draft && JSON.stringify(draft) !== JSON.stringify(agentsQuery.data && copyAgents(agentsQuery.data))
	const routingDirty = !!routingDraft && JSON.stringify(routingDraft) !== JSON.stringify(routingQuery.data?.config)
	const ready = !!config && !!routing

	useEffect(() => {
		if (initial === 'routing' && ready && !scrolled.current && routingSection.current) {
			routingSection.current.scrollIntoView({ block: 'start' })
			scrolled.current = true
		}
	}, [initial, ready])

	const groups = modelCatalog.data?.groups
	const models = useMemo(() => currentModelCatalog(groups ?? []), [groups])
	const remoteIssues = new Map(agentsQuery.data?.issues.map(issue => [issue.agent, issue.error.message]) ?? [])
	const invalid = new Map(saveIssues.map(issue => [issue.agent, issue.error.message]))
	for (const agent of config?.agents ?? []) {
		const problem = groups ? roleModelProblem(agent, groups) : remoteIssues.get(agent.name)
		if (problem) invalid.set(agent.name, problem)
	}
	const routerProblem = routing && groups ? routerModelProblem(routing.router, groups) : null
	const routingProblems = config && routing ? routingDraftProblems(routing, config.agents) : []
	const rosterProblem =
		config && config.agents.length === 0
			? 'Add at least one agent.'
			: config && config.agents.length > MAX_AGENTS
				? `Keep at most ${MAX_AGENTS} agents.`
				: null
	const warning = agentsQuery.data?.warning
	const canSave =
		ready &&
		!warning &&
		!rosterProblem &&
		roleDraftCanSave(
			agentsDirty || routingDirty,
			busy,
			groups,
			invalid.size + routingProblems.length + Number(!!routerProblem)
		)
	const normalizedName = normalizeAgentName(newAgent)
	const addError = newAgentProblem(normalizedName, config?.agents ?? [])
	const savedFallback = routingQuery.data?.config.fallback ?? ''

	const changeAgent = (next: AgentDefinition) => {
		if (!config || !routing || saving.current) return
		const previous = config.agents.find(agent => agent.name === next.name)
		const lock = agentRoutingLock(next.name, routing.fallback, savedFallback)
		if (lock && previous && isRoutableAgent(previous) && !isRoutableAgent(next)) {
			setError(lock)
			return
		}
		setDraft({ version: 1, agents: config.agents.map(agent => (agent.name === next.name ? next : agent)) })
		setSaveIssues(issues => issues.filter(issue => issue.agent !== next.name))
		setError(undefined)
	}
	const removeAgent = (name: string) => {
		if (
			!config ||
			!routing ||
			saving.current ||
			config.agents.length <= 1 ||
			agentRoutingLock(name, routing.fallback, savedFallback)
		)
			return
		setDraft({ version: 1, agents: config.agents.filter(agent => agent.name !== name) })
		setSaveIssues(issues => issues.filter(issue => issue.agent !== name))
		setError(undefined)
	}
	const addAgent = () => {
		if (!config || saving.current || !normalizedName || addError) return
		setDraft({
			version: 1,
			agents: [
				...config.agents,
				{
					name: normalizedName,
					model: 'Choose a model',
					fast: false,
					preamble: `You are the ${normalizedName} agent for this workspace. End your final answer with a \`## Baton\` section: Decision, Evidence, Files changed, Risks, Suggested next role.`
				}
			]
		})
		setNewAgent('')
		setError(undefined)
	}
	const changeRouting = (next: RoutingConfig) => {
		if (saving.current) return
		setRoutingDraft(next)
		setRoutingSaveIssues([])
		setError(undefined)
	}
	const importAgents = async (request: ImportAgentsRequest) => {
		if (saving.current || !agentsQuery.data) throw new Error('Wait for the current save to finish.')
		const before = agentsQuery.data
		saving.current = true
		setBusy(true)
		try {
			const result = await importAgentDefinitions(queryClient, request)
			setDraft(current => (current ? mergeImportedAgents(current, before, result) : undefined))
			setSaveIssues([])
			return result
		} finally {
			saving.current = false
			setBusy(false)
		}
	}
	const save = async () => {
		if (!canSave || !config || !routing || saving.current) return
		saving.current = true
		setBusy(true)
		setError(undefined)
		try {
			const result = await saveAgentsSettings(
				queryClient,
				agentsDirty ? config : undefined,
				routingDirty ? routing : undefined
			)
			if (result.agents) setDraft(undefined)
			if (result.routing) setRoutingDraft(undefined)
			setSaveIssues(result.agentIssues ?? [])
			setRoutingSaveIssues(result.routingIssues ?? [])
			setError(result.error)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			saving.current = false
			setBusy(false)
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex flex-col bg-bg"
			role="dialog"
			aria-modal="true"
			aria-label="Agents settings"
		>
			<header className="pt-safe flex items-center gap-2 border-b border-border-soft px-3 pb-2.5">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<h2 className="text-[15px] font-semibold">Agents</h2>
						<BetaBadge />
					</div>
					<p className="text-[11px] text-faint">Delegated chats and Auto routing</p>
				</div>
				<button
					type="button"
					disabled={!canSave}
					onClick={() => void save()}
					className="flex h-9 items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-35"
				>
					{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}
					Save
				</button>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close agents settings"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<div className="pb-safe min-h-0 flex-1 overflow-y-auto p-3">
				<div className="mx-auto flex max-w-xl flex-col gap-2.5">
					{agentsQuery.isError || routingQuery.isError ? (
						<div className={errorClass}>
							{agentsQuery.isError ? <p>{agentsQuery.error.message || 'Could not load agents.'}</p> : null}
							{routingQuery.isError ? <p>{routingQuery.error.message || 'Could not load Auto routing.'}</p> : null}
							<button
								type="button"
								onClick={() => void Promise.all([agentsQuery.refetch(), routingQuery.refetch()])}
								className="mt-2 rounded-lg border border-del/40 px-2 py-1 font-semibold"
							>
								Retry
							</button>
						</div>
					) : null}
					{!ready && (agentsQuery.isLoading || routingQuery.isLoading) ? (
						<Spinner label="Loading agents and routing…" />
					) : null}
					{modelCatalog.isError ? (
						<div className={`${errorClass} flex items-center gap-2`}>
							<span className="min-w-0 flex-1">Could not load the saved Conductor model catalog.</span>
							<button
								type="button"
								onClick={() => void modelCatalog.refetch()}
								className="shrink-0 rounded-lg border border-del/40 px-2 py-1 font-semibold"
							>
								Retry
							</button>
						</div>
					) : null}
					{warning ? (
						<p className={`${errorClass} whitespace-pre-wrap`}>
							{warning} Repair the agent files before saving; unreadable files were preserved.
						</p>
					) : null}
					{config && routing ? (
						<fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
							{config.agents.map(agent => (
								<AgentEditorCard
									key={agent.name}
									agent={agent}
									models={models}
									agentType={groups ? roleAgentType(agent, groups) : null}
									invalid={invalid.get(agent.name)}
									routingLock={agentRoutingLock(agent.name, routing.fallback, savedFallback)}
									canRemove={config.agents.length > 1}
									onChange={changeAgent}
									onRemove={() => removeAgent(agent.name)}
								/>
							))}
							<div className="rounded-2xl border border-dashed border-border p-2.5">
								<div className="flex items-center gap-2">
									<input
										value={newAgent}
										onChange={event => setNewAgent(event.target.value)}
										onKeyDown={event => {
											if (event.key === 'Enter') addAgent()
										}}
										placeholder="Add an agent"
										aria-label="New agent name"
										className="min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-faint"
									/>
									<button
										type="button"
										disabled={!normalizedName || !!addError}
										onClick={addAgent}
										className="flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted active:bg-surface-2 disabled:opacity-35"
									>
										<Plus size={14} /> Add
									</button>
								</div>
								{addError ? <p className="mt-1.5 px-1 text-xs text-del">{addError}</p> : null}
								<AgentsImport onImport={importAgents} />
							</div>
							{rosterProblem ? <p className="text-xs text-del">{rosterProblem}</p> : null}
							{invalid.size ? <p className="text-xs text-del">Resolve the agent model errors before saving.</p> : null}
							<p className="px-1 text-[11px] leading-relaxed text-faint">
								Agents configure future delegated chats and Auto selections. Accepted jobs keep their frozen settings.
							</p>
							<section
								ref={routingSection}
								aria-label="Auto routing"
								className="mt-3 flex flex-col gap-3 border-t border-border-soft pt-4"
							>
								<h3 className="text-sm font-semibold">Auto routing</h3>
								<RoutingSettingsSection
									config={routing}
									agents={config.agents}
									models={models}
									invalid={routerProblem}
									onChange={changeRouting}
								/>
								{[...new Set([...routingProblems, ...routingSaveIssues, ...(routingQuery.data?.issues ?? [])])].map(
									issue => (
										<p key={issue} className="text-xs text-del">
											{issue}
										</p>
									)
								)}
							</section>
						</fieldset>
					) : null}
					{error ? (
						<p role="alert" className={errorClass}>
							{error}
						</p>
					) : null}
				</div>
			</div>
		</div>,
		document.body
	)
}
