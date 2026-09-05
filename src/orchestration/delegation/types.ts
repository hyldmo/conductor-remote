/** Persisted ordinary-chat delegation records and the queue adapter contract. */

import type {
	Attachment,
	DelegationError,
	DelegationOutcome,
	DelegationReturnMode,
	DelegationStatus,
	ResolvedDelegatedRole,
	SessionRoleAssignment
} from '../../wire.ts'

/** Saved before sending; an accepted id is followed through outbox promotion without another send. */
export interface DelegationDelivery {
	rowid: number
	outboxIds: string[]
	messageId?: string
	/** Older Conductor builds can consume a queued draft before exposing any DB receipt. */
	accepted?: true
}

export interface PersistedDelegation {
	version: 1
	id: string
	workspaceId: string
	parentSessionId: string
	childSessionId?: string
	role: string
	resolvedRole: ResolvedDelegatedRole
	prompt: string
	returnMode: DelegationReturnMode
	includeThinking: boolean
	throughRowid?: number
	status: DelegationStatus
	attempts: number
	createdAt: number
	updatedAt: number
	handoff?: Attachment
	sendDelivery?: DelegationDelivery
	sentRowid?: number
	completionRowid?: number
	/** Parent transcript baseline, also retained for returns saved by older relays. */
	returnCursor?: number
	returnAttachment?: Attachment
	returnText?: string
	returnDelivery?: DelegationDelivery
	returnRowid?: number
	outcome?: DelegationOutcome
	failure?: DelegationError
	lastAttemptAt?: number
}

export interface StateWarning {
	file: string
	message: string
}

export interface DelegationList {
	jobs: PersistedDelegation[]
	warnings: StateWarning[]
}

export interface SessionRolesRead {
	sessions: Record<string, SessionRoleAssignment>
	warning?: string
}

export interface DelegationTransitionPatch {
	childSessionId?: string
	handoff?: Attachment
	sentRowid?: number
	completionRowid?: number
	returnCursor?: number
	returnAttachment?: Attachment
	returnText?: string
	returnRowid?: number
	outcome?: DelegationOutcome
	failure?: DelegationError
	attempts?: number
	lastAttemptAt?: number
}

export interface DelegationActionError {
	ok: false
	code: DelegationError['code']
	error: string
	blocked?: boolean
	/** False means another identical attempt cannot help; fail immediately. */
	retryable?: boolean
}

export type OpenDelegationResult = { ok: true; childSessionId: string; handoff: Attachment } | DelegationActionError

export type ConfigureDelegationResult = { ok: true } | DelegationActionError

export type SendDelegationResult =
	| { ok: true; sentRowid: number }
	| { ok: true; pending: true; sendDelivery: DelegationDelivery }
	| DelegationActionError

export type ReturnDelegationResult =
	| { ok: true; returnRowid: number }
	| {
			ok: true
			pending: true
			returnCursor: number
			returnAttachment: Attachment
			returnText: string
			returnDelivery?: DelegationDelivery
	  }
	| DelegationActionError

export interface DelegationCompletion {
	outcome: DelegationOutcome
	completionRowid?: number
}

export interface DelegationQueueDeps {
	open: (job: PersistedDelegation) => Promise<OpenDelegationResult>
	configure: (job: PersistedDelegation) => Promise<ConfigureDelegationResult>
	send: (job: PersistedDelegation) => Promise<SendDelegationResult>
	/** Null means the child has not reached a terminal observation on this poll. */
	completion: (job: PersistedDelegation) => DelegationCompletion | null | Promise<DelegationCompletion | null>
	returnResult: (job: PersistedDelegation) => Promise<ReturnDelegationResult>
}

export interface DelegationQueueOptions {
	now?: () => number
	retryDelayMs?: number
	maxAttempts?: number
	/** Lock/UI saturation is temporary queue pressure, not a failed attempt. */
	blockedError?: (error: unknown) => boolean
	onError?: (message: string) => void
}
