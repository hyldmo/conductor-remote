import type { ConductorDb } from '../db.ts'
import type { ResolvedIcon } from '../files/icons.ts'
import type { ContextBreakdown } from '../transcript/context-breakdown.ts'
import type { TranscriptEntry } from '../transcript/parser.ts'
import { agentProcessStarts } from './background-tasks.ts'
import { MessageReads } from './messages.ts'
import { SessionReads } from './sessions.ts'
import type {
	ClosedSession,
	DeliveryCursor,
	DeliveryReceipt,
	RepoRow,
	SearchWorkspace,
	SessionRow,
	SessionState,
	Workspace
} from './types.ts'
import { WorkspacesReads } from './workspaces.ts'

/** One read-only Conductor connection shared by the three focused query repositories. */
export class Reads {
	private readonly workspaces: WorkspacesReads
	private readonly sessions: SessionReads
	private readonly messages: MessageReads
	constructor(db: ConductorDb, workspacesRoot: string, liveAgents: () => Map<string, number> = agentProcessStarts) {
		this.workspaces = new WorkspacesReads(db, workspacesRoot)
		this.sessions = new SessionReads(db, liveAgents)
		this.messages = new MessageReads(db, workspacesRoot)
	}
	listWorkspaces(): Workspace[] {
		return this.workspaces.listWorkspaces()
	}
	getWorkspace(id: string): Workspace | null {
		return this.workspaces.getWorkspace(id)
	}
	listRepos(): RepoRow[] {
		return this.workspaces.listRepos()
	}
	searchTargets(sessionIds: string[]): Map<string, { sessionTitle: string | null; workspace: SearchWorkspace }> {
		return this.workspaces.searchTargets(sessionIds)
	}
	searchSessionIds(repos: string[] | undefined, includeArchived: boolean): string[] {
		return this.workspaces.searchSessionIds(repos, includeArchived)
	}
	findWorkspacesByName(tokens: string[], limit = 20, repos?: string[], includeArchived = true): SearchWorkspace[] {
		return this.workspaces.findWorkspacesByName(tokens, limit, repos, includeArchived)
	}
	getAnyWorkspace(id: string): SearchWorkspace | null {
		return this.workspaces.getAnyWorkspace(id)
	}
	resolveRepoIcon(repoName: string): ResolvedIcon | null {
		return this.workspaces.resolveRepoIcon(repoName)
	}
	sessionWorkspaceId(sessionId: string): string | null {
		return this.workspaces.sessionWorkspaceId(sessionId)
	}
	listSessions(workspaceId: string): SessionRow[] {
		return this.sessions.listSessions(workspaceId)
	}
	listClosedSessions(workspaceId: string): ClosedSession[] {
		return this.sessions.listClosedSessions(workspaceId)
	}
	getSession(sessionId: string): SessionRow | null {
		return this.sessions.getSession(sessionId)
	}
	listSessionStates(): SessionState[] {
		return this.sessions.listSessionStates()
	}
	lastQuestionInput(sessionId: string): unknown | null {
		return this.messages.lastQuestionInput(sessionId)
	}
	lastAssistantText(sessionId: string): string | null {
		return this.messages.lastAssistantText(sessionId)
	}
	toolImage(reference: string): { mediaType: string; data: string } | null {
		return this.messages.toolImage(reference)
	}
	deliveryCursor(sessionId: string): DeliveryCursor {
		return this.messages.deliveryCursor(sessionId)
	}
	promptDeliveredSince(sessionId: string, text: string, before: DeliveryCursor): boolean {
		return this.messages.promptDeliveredSince(sessionId, text, before)
	}
	deliveryReceiptSince(sessionId: string, text: string, before: DeliveryCursor): DeliveryReceipt | null {
		return this.messages.deliveryReceiptSince(sessionId, text, before)
	}
	deliveryReceiptContainingSince(sessionId: string, marker: string, before: DeliveryCursor): DeliveryReceipt | null {
		return this.messages.deliveryReceiptContainingSince(sessionId, marker, before)
	}
	deliveryReceiptForId(sessionId: string, messageId: string): DeliveryReceipt | null {
		return this.messages.deliveryReceiptForId(sessionId, messageId)
	}
	deliveryTextMatches(sessionId: string, messageId: string, text: string): boolean {
		return this.messages.deliveryTextMatches(sessionId, messageId, text)
	}
	getMessages(
		sessionId: string,
		afterRowid = 0
	): { entries: TranscriptEntry[]; queued: TranscriptEntry[]; cursor: number } {
		return this.messages.getMessages(sessionId, afterRowid)
	}
	getContextBreakdown(sessionId: string): ContextBreakdown | null {
		return this.messages.getContextBreakdown(sessionId)
	}
	getMessagesForTurn(
		sessionId: string,
		turnId: string,
		afterRowid = 0
	): { entries: TranscriptEntry[]; cursor: number } {
		return this.messages.getMessagesForTurn(sessionId, turnId, afterRowid)
	}
}
