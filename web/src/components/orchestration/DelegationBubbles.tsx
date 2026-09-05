import type { DelegationProjection } from '../../lib/types.ts'
import { Markdown } from '../transcript/Markdown.tsx'
import { QueueBubble, type QueueBubbleAction } from '../transcript/QueueBubble.tsx'
import { delegationStatusLabel } from './labels.ts'

/** Parent/child transcript cards for ad hoc jobs. Workflows have their own projection. */
export function DelegationBubbles({
	jobs,
	sessionId,
	onSelectSession,
	onDismiss,
	onOpenRoles
}: {
	jobs: DelegationProjection[]
	sessionId: string | null
	onSelectSession: (sessionId: string) => void
	onDismiss: (delegationId: string) => void
	onOpenRoles: () => void
}) {
	if (!sessionId) return null
	const visible = jobs.filter(
		job => !job.workflowId && (job.parentSessionId === sessionId || job.childSessionId === sessionId)
	)
	if (!visible.length) return null
	return (
		<>
			{visible.map(job => {
				const parent = job.parentSessionId === sessionId
				const failed = job.status === 'failed'
				const peer = parent ? job.childSessionId : job.parentSessionId
				const actions: QueueBubbleAction[] = []
				if (peer) actions.push({ label: parent ? 'Open worker' : 'Open parent', onClick: () => onSelectSession(peer) })
				if (failed) {
					actions.push({ label: 'Edit roles', onClick: onOpenRoles, primary: true })
					actions.push({ label: 'Dismiss delegation', onClick: () => onDismiss(job.id) })
				}
				return (
					<QueueBubble
						key={job.id}
						state={failed ? 'failed' : 'pending'}
						align="wide"
						label={`${parent ? 'Delegated' : 'Assigned'} · ${job.role} · ${job.resolvedRole.model}${job.resolvedRole.effort ? ` · ${job.resolvedRole.effort}` : ''}`}
						meta={
							failed
								? `${job.failure?.code ?? 'failed'}: ${job.failure?.message ?? 'The delegated job failed.'}`
								: `${delegationStatusLabel(job.status)}${job.attempts ? ` · attempt ${job.attempts + 1}` : ''}`
						}
						actions={actions}
						dataMessageState={`delegation-${job.status}`}
					>
						<Markdown>{job.prompt}</Markdown>
					</QueueBubble>
				)
			})}
		</>
	)
}
