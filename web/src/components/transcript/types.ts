/** The transcript cuts the fork control exposes. */
export interface SplitFormat {
	/** A response in an earlier stitched chat still copies from its own real session. */
	sourceSessionId?: string
	thinking: boolean
	tools: boolean
	/** Put the handoff in a separate worktree carrying the source's current code. */
	destination?: 'chat' | 'workspace'
	/** Source row to stop the copy at — a fork from an earlier turn. Undefined takes the whole chat. */
	through?: number
	/** Keep only this source message, with no earlier or later history. */
	only?: number
}
