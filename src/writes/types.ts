import type { Workspace } from '../reads/types.ts'

export interface SendResult {
	ok: boolean
	strategy: string
	warning?: string
	error?: string
}

export interface RunTaskResult {
	ok: boolean
	state?: 'running' | 'stopped'
	task?: string
	changed?: boolean
	/** Exact destinations Conductor exposes on its Open controls, when available. */
	previewUrls?: string[]
	/** Port-only compatibility path for Conductor builds whose controls expose no destination. */
	ports?: number[]
	error?: string
}

/**
 * Where the target chat sits in Conductor's tab strip. `index` is 1-based in
 * `reads.listSessions` order (created_at ASC) — verified to match the strip's
 * left-to-right order — and `title` is the tab label used as a sanity check.
 */
export interface ChatTab {
	index: number
	count: number
	title: string
}

/** Who to deliver a prompt to. `sessionId` is the precise target; `workspace` carries the worktree + focus context. */
export interface SendTarget {
	workspace: Workspace
	sessionId: string | null
	/** Which chat tab to select once the workspace is focused. Omitted → whichever tab is already active. */
	tab?: ChatTab
}

/** How `/api/state` describes the write strategy in force (see `describeActuator`). */
export interface ActuatorInfo {
	name: string
	/** Human-readable note about this strategy's limits, surfaced in the UI. */
	caveat: string
	/** True when delivery is addressed to a specific session (no window-focus dependency). */
	precise: boolean
	/** False when the strategy's runtime check says it can't deliver right now. */
	available: boolean
}

/** How a submitted prompt behaves when its chat is already working. */
export interface PromptSendOptions {
	/** Queue the prompt behind the current turn instead of using the default follow-up behavior. */
	queue?: boolean
	/** Epoch ms when the caller stops waiting for this delivery attempt. */
	deadline?: number
}

export interface Actuator {
	readonly name: string
	/** Human-readable note about this strategy's limits, surfaced in the UI. */
	readonly caveat: string
	/** True when delivery is addressed to a specific session (no window-focus dependency). */
	readonly precise: boolean
	/**
	 * `deadline` is when the caller stops waiting, so a caller retrying
	 * inside one request bounds every attempt with the *same* number. A deadline
	 * rather than a duration because `uiTurn` may queue this run: only the run itself
	 * knows how much of the budget was still left when it finally started.
	 */
	send: (target: SendTarget, text: string, options?: PromptSendOptions) => Promise<SendResult>
	/** Runtime availability check (e.g. the sidecar socket must be reachable). */
	available?: () => Promise<boolean>
}

export type WriteStrategy = 'applescript' | 'sidecar'
