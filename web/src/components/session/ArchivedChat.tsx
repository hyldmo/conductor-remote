import { Archive, ArrowLeft } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useSessions } from '../../hooks/workspaces.ts'
import { cn } from '../../lib/cn.ts'
import { workspaceTitle } from '../../lib/format.ts'
import type { SearchWorkspace } from '../../lib/types.ts'
import { Header } from '../Header.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import { Empty } from '../ui.tsx'

/**
 * An archived workspace's chat, read-only.
 *
 * Archiving deletes the worktree, not the conversation: the transcript is rows in
 * `session_messages` and stays exactly where it was. So search reaches it (1,846 of the
 * 1,886 workspaces here are archived, which is the whole reason search exists) and this
 * reads it — no unarchive on the Mac, and nothing new in the sidebar. The workspace is
 * fetched by id (`GET /api/workspaces/:id`) rather than found in `/api/state`, which
 * lists only the live ones.
 *
 * Every write is gone rather than disabled, because none of them has anything to act on:
 * a send needs a Conductor pane that no longer exists, a diff needs a worktree that has
 * been deleted, and the status menu needs a sidebar row. Nothing here polls either — an
 * archived chat has no next message. The one thing that *can* change is the workspace
 * coming back: `/api/state` keeps polling upstream, so an unarchive puts the live view
 * back on screen on its own.
 */
export function ArchivedChat({ workspace }: { workspace: SearchWorkspace }) {
	// Same `?session=` as the live view, so a search result opening its own chat, a
	// notification and the tab strip all write to one place.
	const [searchParams, setSearchParams] = useSearchParams()
	const picked = searchParams.get('session')
	const pickedSubagent = searchParams.get('subagent')
	const { data, isLoading } = useSessions(workspace.id, false)

	const sessions = data?.sessions ?? []
	const sessionId = (picked && sessions.some(s => s.id === picked) ? picked : null) ?? sessions[0]?.id ?? null
	const activeSession = sessions.find(s => s.id === sessionId)
	const selectSubagent = (toolUseId: string | null) => {
		if (!sessionId) return
		setSearchParams(toolUseId ? { session: sessionId, subagent: toolUseId } : { session: sessionId }, { replace: true })
	}
	const subtitle = [workspace.repo_name, workspace.branch].filter(Boolean).join(' · ')

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden">
			<Header
				title={workspaceTitle(workspace)}
				subtitle={subtitle}
				menu
				right={
					<span className="flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
						<Archive size={12} />
						Archived
					</span>
				}
			/>
			{sessions.length > 1 ? (
				<nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-soft bg-bg px-3 py-2">
					{sessions.map(s => (
						<button
							type="button"
							key={s.id}
							onClick={() => setSearchParams({ session: s.id }, { replace: true })}
							className={cn('pill shrink-0', s.id === sessionId && !pickedSubagent && 'pill-active')}
						>
							<span className="whitespace-nowrap">{s.title || 'Untitled'}</span>
						</button>
					))}
				</nav>
			) : null}
			{!isLoading && !sessionId ? (
				<Empty>This workspace was archived with no chat in it.</Empty>
			) : (
				<Transcript
					sessionId={sessionId}
					workspaceId={workspace.id}
					turnStartedAt={activeSession?.turn_started_at}
					agentType={activeSession?.agent_type}
					model={activeSession?.model}
					selectedSubagentId={pickedSubagent}
					onSelectSubagent={selectSubagent}
					poll={false}
				/>
			)}
			{/* Where the composer would be. Saying it plainly beats a disabled box: the chat
			    reads exactly like a live one, and nothing else on screen says why typing does
			    not work. */}
			<div className="pb-safe shrink-0 border-t border-border-soft px-4 py-3 text-center text-xs text-faint">
				{pickedSubagent ? (
					<button
						type="button"
						onClick={() => selectSubagent(null)}
						className="mx-auto flex items-center gap-2 rounded-lg px-3 py-1.5 font-medium text-accent transition active:bg-surface-2"
					>
						<ArrowLeft size={14} />
						Back to parent transcript
					</button>
				) : (
					'Read-only — unarchive it in Conductor to reply.'
				)}
			</div>
		</div>
	)
}
