import crypto from 'node:crypto'

import path from 'node:path'
import { AgentStore } from '../../agents/agent-store.ts'
import { ModelCache } from '../../agents/model-cache.ts'
import { loadConfig, stateDir } from '../../config.ts'
import { ConductorDb } from '../../db.ts'
import { DevServerController } from '../../dev-server/controller.ts'
import { installLogCapture } from '../../host/logbuf.ts'
import {
	currentProcessStartIdentity,
	incompatibleRelayProcesses,
	listUiCapableRelayProcesses,
	processIdentityAlive
} from '../../host/relay-processes.ts'
import { recoverExpiredUiLease } from '../../host/ui-lease-watchdog.ts'
import { DelegationStore } from '../../orchestration/delegation/store.ts'
import { OrchestrationDb } from '../../orchestration/persistence/db.ts'
import { UiLeaseUnavailableError } from '../../orchestration/persistence/errors.ts'
import { ORCHESTRATION_PROTOCOL_VERSION, type RelayIdentity } from '../../orchestration/persistence/types.ts'
import { Reads } from '../../reads/repository.ts'
import { SessionPoller } from '../../reads/session-poller.ts'
import type { Workspace } from '../../reads/types.ts'
import { SearchIndex } from '../../search/coordinator.ts'
import { attachmentTokens } from '../../shared.ts'
import { ChatHistoryStore } from '../../transcript/chat-history.ts'
import { PlanUsageService } from '../../usage/plan-usage.ts'
import { ToolUsageService } from '../../usage/tool-usage-service.ts'
import { pickActuator } from '../../writes/actuator.ts'
import { setRestartGuard } from '../../writes/targeting.ts'
import type { SendResult } from '../../writes/types.ts'
import { configureSharedUiLeaseProvider, UiBusyError } from '../../writes/ui-lock.ts'
import { createWorkspace } from '../../writes/workspaces.ts'

export function createBaseServices() {
	// Before anything that logs: from here on every console line is also kept in memory for
	// `GET /api/logs`, so the phone can read why a send failed without ssh-ing into the Mac.
	installLogCapture()

	const cfg = loadConfig()

	const db = new ConductorDb(cfg.dbPath)

	const reads = new Reads(db, cfg.workspacesRoot)

	const sessionPoller = new SessionPoller(() => reads.listSessionStates())

	const actuator = pickActuator(cfg.writeStrategy)

	const devServers = new DevServerController()

	if (cfg.devWebPort !== undefined && process.env.CONDUCTOR_WORKSPACE_ID) {
		const preview = new URL(`http://localhost:${cfg.devWebPort}/`)
		preview.hash = new URLSearchParams({ token: cfg.token }).toString()
		// `yarn dev` is itself one application behind Conductor's Run button. Publish
		// the same canonical URL printed below. The private live advertisement crosses
		// into the installed relay that normally serves the phone; its forwarding code
		// still treats this exactly like any full URL and knows nothing about the token.
		devServers.advertisePreviewUrls(process.env.CONDUCTOR_WORKSPACE_ID, [
			{ name: 'Conductor Remote', url: preview.href }
		])
	}

	const STAGED_ATTACHMENTS_DIR = path.join(stateDir(), 'attachment-staging')

	/** Attachment IDs are already encoded in the immutable objective's Conductor tokens. */
	function stagedAttachmentIdsInObjective(objective: string): string[] {
		return [
			...new Set(
				attachmentTokens(objective).flatMap(token => {
					const match = /^\.context\/attachments\/([A-Za-z0-9]{6})\//.exec(token.path)
					return match ? [match[1]] : []
				})
			)
		]
	}

	// Picker labels cannot be reconstructed from `sessions.model`, so they belong to
	// relay state alongside the prompt queues. This lets a brand-new workspace choose
	// from a list before Conductor has created its first chat.
	const modelCache = new ModelCache(path.join(stateDir(), 'model-cache.json'))
	const chatHistory = new ChatHistoryStore(path.join(stateDir(), 'chat-history.json'))

	const planUsage = new PlanUsageService()

	const toolUsage = new ToolUsageService(cfg.dbPath)

	const agentStore = new AgentStore(path.join(stateDir(), 'agents'))
	const roleStore = agentStore.roles
	const routingConfig = agentStore.routing

	const orchestration = new OrchestrationDb(path.join(stateDir(), 'orchestration.db'), {
		processProbe: processIdentityAlive
	})

	const relayIdentity: RelayIdentity = {
		instanceId: crypto.randomUUID(),
		pid: process.pid,
		processStartedAt: currentProcessStartIdentity(),
		protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
	}

	function orchestrationUnavailableReason(): string {
		return orchestration.schemaWarning ?? `orchestration schema ${orchestration.schemaVersion} is unsupported`
	}

	if (orchestration.writable) {
		orchestration.registerRelayInstance({ ...relayIdentity, canDriveUi: true })
		const sharedUiLeases = orchestration.createSharedUiLeaseProvider(relayIdentity, { leaseMs: 2 * 60_000 })
		configureSharedUiLeaseProvider({
			acquire: async request => {
				try {
					return await sharedUiLeases.acquire(request)
				} catch (error) {
					if (error instanceof UiLeaseUnavailableError) throw new UiBusyError(0)
					throw error
				}
			}
		})
	} else {
		console.warn(`[relay] ${orchestrationUnavailableReason()}; Workflow is disabled until this relay is upgraded`)
	}

	/** One store object per live worktree, so the queue never registers a path twice. */
	const delegationStores = new Map<string, { worktree: string; store: DelegationStore }>()

	function delegationStore(ws: Pick<Workspace, 'id' | 'worktree'>): DelegationStore | null {
		if (!ws.worktree) return null
		const cached = delegationStores.get(ws.id)
		if (cached?.worktree === ws.worktree) return cached.store
		const store = new DelegationStore(ws.worktree)
		delegationStores.set(ws.id, { worktree: ws.worktree, store })
		return store
	}

	function liveDelegationStores(): DelegationStore[] {
		return reads.listWorkspaces().flatMap(ws => {
			const store = delegationStore(ws)
			return store ? [store] : []
		})
	}

	/** Preserve role identity for already-persisted pre-coordinator Workflow prompts. */
	function assignWorkflowRoot(
		ws: Workspace,
		sessionId: string,
		role: string,
		assignedAt: number
	): { ok: true } | { ok: false; error: string } {
		const store = delegationStore(ws)
		if (!store) return { ok: false, error: 'the workflow worktree is unavailable' }
		if (reads.sessionWorkspaceId(sessionId) !== ws.id) {
			return { ok: false, error: 'the workflow root chat is not in that workspace' }
		}
		const session = reads.getSession(sessionId)
		if (!session) return { ok: false, error: 'the workflow root chat is unavailable' }
		const assignments = store.sessionRoles()
		if (assignments.warning) return { ok: false, error: `cannot assign the workflow root: ${assignments.warning}` }
		const existing = assignments.sessions[sessionId]
		if (existing && existing.role !== role) {
			return { ok: false, error: `the new chat is already assigned to role ${existing.role}` }
		}
		if (!existing) store.assign(sessionId, { role, assignedAt })
		return { ok: true }
	}

	// Full-text index over the chat prose, in the relay's own sidecar DB — never in
	// Conductor's (see src/search/coordinator.ts). It backfills in the background and is disposable:
	// deleting the file rebuilds it on the next start.
	const search = new SearchIndex(cfg.dbPath, path.join(stateDir(), 'search.db'))

	search.start()

	// A windowless Conductor that ignores reopen *and* a Dock click can only be fixed
	// by restarting it — and quitting takes any agent mid-turn down with it. So the
	// write path may only do that while nothing is working, which is a DB fact, not
	// something AppleScript can see. Read fresh each time: a session can start between
	// the phone opening the app and the send landing.
	setRestartGuard(() => !reads.listWorkspaces().some(w => w.session_status === 'working'))

	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

	let uiLeaseRecoveryRunning = false

	/**
	 * A dead relay can leave its detached, already-authorized GUI helper behind. Keep
	 * the old mutex until that exact process group is gone, allow its external event
	 * to settle, then let the database CAS create the persistent safety hold.
	 */
	async function recoverUiLease(): Promise<void> {
		if (!orchestration.writable || uiLeaseRecoveryRunning) return
		uiLeaseRecoveryRunning = true
		try {
			const result = await recoverExpiredUiLease(orchestration, relayIdentity)
			if (result.status === 'external_process_alive') {
				console.warn(
					`[workflow] expired UI helper ${result.owner.externalProcess?.pid ?? 'unknown'} could not be proven dead; retaining its mutex`
				)
			} else if (result.status === 'owned_external_terminated') {
				console.warn(`[workflow] terminated overdue UI helper ${result.owner.externalProcess?.pid ?? 'unknown'}`)
			} else if (result.status === 'reclaimed') {
				console.warn(
					`[workflow] reclaimed expired UI action ${result.owner.actionId}${result.quarantined ? ' into persistent quarantine' : ''}`
				)
			}
		} catch (error) {
			console.error('[workflow] expired UI lease recovery failed:', error)
		} finally {
			uiLeaseRecoveryRunning = false
		}
	}

	/** Fail closed if another UI-capable relay cannot prove it speaks this protocol. */
	async function workflowCompatibilityError(): Promise<{
		kind: 'incompatible' | 'unverified'
		message: string
	} | null> {
		if (!orchestration.writable) {
			return { kind: 'incompatible', message: `Workflow is disabled because ${orchestrationUnavailableReason()}.` }
		}
		try {
			const processes = await listUiCapableRelayProcesses()
			const incompatible = incompatibleRelayProcesses(
				processes,
				orchestration.listRelayInstances(),
				ORCHESTRATION_PROTOCOL_VERSION
			)
			if (!incompatible.length) return null
			return {
				kind: 'incompatible',
				message: `Workflow needs every live conductor-remote UI relay on protocol ${ORCHESTRATION_PROTOCOL_VERSION}. Stop incompatible PID${incompatible.length === 1 ? '' : 's'} ${incompatible.map(process => process.pid).join(', ')} and try again.`
			}
		} catch (error) {
			return {
				kind: 'unverified',
				message: `Workflow could not verify the live relay processes: ${error instanceof Error ? error.message : String(error)}`
			}
		}
	}

	/**
	 * A deep link has no request id to correlate with the workspace row it creates. Keep
	 * relay-originated creations single-flight until that row appears, or two simultaneous
	 * requests can each claim the other's workspace. Manual desktop creation can still
	 * happen in the gap, so callers also narrow the fresh row to the requested repo.
	 */
	let workspaceCreationTail = Promise.resolve()

	async function createWorkspaceAndRead(
		prompt: string,
		repoPath: string | null,
		repoName?: string,
		strictUnique = false
	): Promise<{ result: SendResult; created?: Workspace }> {
		const previous = workspaceCreationTail
		let release: () => void = () => {}
		workspaceCreationTail = new Promise<void>(resolve => {
			release = resolve
		})
		await previous
		try {
			const before = new Set(reads.listWorkspaces().map(w => w.id))
			const result = await createWorkspace(prompt, repoPath)
			if (!result.ok) return { result }
			// The deep link is fire-and-forget, so the new row is the only proof it worked.
			// Creating a worktree takes a beat longer than opening a chat does.
			for (let attempt = 0; attempt < 40; attempt++) {
				await sleep(500)
				const candidates = reads
					.listWorkspaces()
					.filter(workspace => !before.has(workspace.id) && (!repoName || workspace.repo_name === repoName))
				if (strictUnique && candidates.length > 1) return { result }
				if (candidates[0]) return { result, created: candidates[0] }
			}
			return { result }
		} finally {
			release()
		}
	}
	return {
		cfg,
		reads,
		sleep,
		actuator,
		STAGED_ATTACHMENTS_DIR,
		assignWorkflowRoot,
		orchestration,
		stagedAttachmentIdsInObjective,
		modelCache,
		chatHistory,
		sessionPoller,
		delegationStore,
		relayIdentity,
		createWorkspaceAndRead,
		workflowCompatibilityError,
		orchestrationUnavailableReason,
		search,
		planUsage,
		toolUsage,
		agentStore,
		roleStore,
		routingConfig,
		devServers,
		recoverUiLease,
		liveDelegationStores
	}
}
export type BaseServices = ReturnType<typeof createBaseServices>
