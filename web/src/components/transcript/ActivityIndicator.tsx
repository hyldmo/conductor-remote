import { Hourglass } from 'lucide-react'
import { useEffect, useState } from 'react'
import { elapsed, timestampMs } from '../../lib/format.ts'
import type { BackgroundTask } from '../../lib/types.ts'

/**
 * The classic three-dot "typing" bubble, shown under the last message while the agent
 * works — with how long the current answer has been running beside it. `since` is the
 * turn's dispatch time, so steering the agent mid-answer keeps the clock running and
 * only a fresh prompt starts it over (see `turn_started_at` in src/reads/sessions.ts).
 */
export function WorkingIndicator({ since }: { since?: number | null }) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!since) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [since])
	return (
		<div className="fade-in flex items-center justify-start gap-2">
			<div className="flex items-center gap-1 px-0.5 py-3">
				<span className="typing-dot" />
				<span className="typing-dot" />
				<span className="typing-dot" />
			</div>
			{since ? <span className="text-[11px] tabular-nums text-faint">{elapsed(now - since)}</span> : null}
		</div>
	)
}

/**
 * The desktop's "Waiting for task" row: a background command or subagent the agent
 * handed off and will be resumed by. Drawn in the working indicator's place, because
 * that is what it is — the turn ended and the chat reads `idle`, but the agent is
 * coming back on its own — with the task's own description and how long it has waited.
 */
export function WaitingIndicator({ task }: { task: BackgroundTask }) {
	const since = timestampMs(task.since)
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [])
	return (
		<div className="fade-in flex min-w-0 items-center gap-2 px-0.5 py-1.5 text-[12.5px] text-muted">
			<Hourglass size={13} className="shrink-0 text-faint" />
			<span className="shrink-0 text-faint">Waiting for task</span>
			<span className="min-w-0 flex-1 truncate">{task.description}</span>
			{Number.isNaN(since) ? null : (
				<span className="shrink-0 text-[11px] tabular-nums text-faint">{elapsed(now - since)}</span>
			)}
		</div>
	)
}

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
