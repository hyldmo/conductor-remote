import { Fragment, memo, useLayoutEffect, useMemo, useState } from 'react'
import { useTranscript } from '../../hooks/transcript.ts'
import { assistantTurnEnds, latestAssistantForActions, turnOrigin } from '../../lib/transcript/actions.ts'
import { transcriptSubagents, transcriptTree } from '../../lib/transcript/tree.ts'
import { Spinner } from '../ui.tsx'
import { ChatActions } from './ChatActions.tsx'
import { NodeEntry, StepGroup, SubagentResult, subagentFinal } from './entries.tsx'
import { groupSteps, rowKey } from './grouping.ts'
import type { SplitFormat } from './types.ts'

/** Earlier contexts share the live transcript's scroller and renderer, never an attachment viewer. */
export const TranscriptHistory = memo(function TranscriptHistory({
	sessionId,
	onLayout,
	onFork
}: {
	sessionId: string
	onLayout?: () => void
	onFork?: (format: SplitFormat) => Promise<void>
}) {
	// The completed context is read once. Only the newest chat keeps the 1s poll.
	const transcript = useTranscript(sessionId, false)
	const entries = useMemo(() => transcript.entries.filter(entry => !entry.queued), [transcript.entries])
	const nodes = useMemo(() => transcriptTree(entries), [entries])
	const [selectedAgent, selectAgent] = useState<string | null>(null)
	const subagent = useMemo(
		() => transcriptSubagents(nodes).find(agent => agent.id === selectedAgent),
		[nodes, selectedAgent]
	)
	const rows = useMemo(() => groupSteps(subagent?.node.children ?? nodes), [nodes, subagent])
	const rootEntries = useMemo(() => nodes.map(node => node.e), [nodes])
	const actions = useMemo(() => new Set(assistantTurnEnds(rootEntries).map(rowKey)), [rootEntries])
	const latest = useMemo(() => latestAssistantForActions(rootEntries), [rootEntries])
	const final = subagent ? subagentFinal(subagent.node) : null

	// Fetching an older segment increases scrollHeight, not the scroller's height.
	// Tell its owner after layout so a reader at the bottom stays with the composer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: content/selection changes drive the layout notification
	useLayoutEffect(() => onLayout?.(), [entries, transcript.loading, selectedAgent, onLayout])

	return (
		<section data-chat-history={sessionId} aria-label="Previous conversation context">
			{transcript.loading ? (
				<Spinner label="Loading earlier conversation…" />
			) : transcript.error ? (
				<p className="py-3 text-xs text-del">Could not load earlier conversation: {transcript.error}</p>
			) : (
				<div className="flex min-w-0 flex-col gap-2.5">
					{subagent ? (
						<button type="button" className="self-start py-2 text-xs text-accent" onClick={() => selectAgent(null)}>
							Back to conversation
						</button>
					) : null}
					{rows.map(row =>
						row.kind === 'steps' ? (
							<StepGroup key={row.key} nodes={row.nodes} />
						) : (
							<Fragment key={row.key}>
								<NodeEntry node={row.node} onSelectSubagent={selectAgent} />
								{!subagent && actions.has(rowKey(row.node.e)) ? (
									<ChatActions
										text={row.node.e.text}
										entries={entries}
										at={row.node.e.ts}
										startedAt={turnOrigin(rootEntries, row.node.e)}
										rowid={row.node.e.rowid}
										through={row.node.e === latest ? undefined : row.node.e.rowid}
										onFork={onFork ? format => onFork({ ...format, sourceSessionId: sessionId }) : undefined}
									/>
								) : null}
							</Fragment>
						)
					)}
					{final ? <SubagentResult text={final} failed={!!subagent?.node.e.error} /> : null}
				</div>
			)}
			<div className="relative my-6">
				<hr className="border-border-soft" />
				<span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-bg px-3 text-[11px] text-faint">
					Context reset
				</span>
			</div>
		</section>
	)
})
