import type { ParkedAgentPatch } from '../../delivery/parked.ts'
import type { AgentEffort } from '../../wire.ts'

export interface AutoModelTuple {
	model: string
	effort?: AgentEffort
	fast?: boolean
}

export interface AutoModelProfile extends AutoModelTuple {
	id: string
	description: string
}

export interface AutoModelConfig {
	version: 1
	defaultAuto: boolean
	router: AutoModelTuple
	profiles: AutoModelProfile[]
	fallback: string
	rules: string
	timeoutMs: number
}

export interface AutoModelDecision extends AutoModelTuple {
	profile: string
	reason: string
	fallback: boolean
	durationMs: number
}

export interface AutoModelState {
	status: 'draft' | 'selecting' | 'waiting' | 'failed' | 'delivered' | 'cancelled'
	decision?: AutoModelDecision
	error?: string
}

/** The router owns this prompt until its durable Conductor receipt arrives. */
export interface AutoModelJob {
	id: string
	workspaceId: string
	sessionId?: string
	text: string
	repo: string
	config: AutoModelConfig
	attachmentIds: string[]
	sendImmediately: boolean
	createdAt: number
	status: AutoModelState['status']
	decision?: AutoModelDecision
	cursor?: { rowid: number; outboxIds: string[] }
	attempts: number
	earlyAttempts: number
	lastAttemptAt?: number
	reason: string
	error?: string
}

export interface AutoModelPending {
	workspaceId: string
	sessionId?: string
	text: string
	createdAt: number
	status: 'waiting' | 'failed'
	attempts: number
	reason: string
	error?: string
	autoModel: true
	agent?: ParkedAgentPatch
}

export interface AutoModelConfigResponse {
	config: AutoModelConfig
	issues: string[]
}
