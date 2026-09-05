import { cn } from '../../lib/cn.ts'
import { relativeAge, STATUS_COLORS, workspaceTitle } from '../../lib/format.ts'
import type { PromptIndicatorState } from '../../lib/prompts/pending.ts'
import type { CachedModelGroup, RolesConfig, Workspace } from '../../lib/types.ts'
import { ChangeStats } from '../review/ChangeStats.tsx'
import { Badge, RepoAvatar, RunBadge, StatusDot } from '../ui.tsx'
import { WorkspaceRunLabel } from './WorkspaceRunLabel.tsx'

/** Status glyph for group headers — backlog is hollow, like the desktop sidebar. */
export function GroupDot({ status }: { status?: string }) {
	if (!status) return null
	const color = STATUS_COLORS[status]
	if (!color) return <span className="dot size-2 border border-faint bg-transparent" />
	return <span className="dot size-2" style={{ background: color }} />
}

export function WorkspaceCard({
	w,
	unread,
	selected,
	modelGroups,
	workflowRoles,
	promptState,
	showDiffs
}: {
	w: Workspace
	unread: number
	selected: boolean
	modelGroups: CachedModelGroup[] | undefined
	workflowRoles: RolesConfig['roles'] | undefined
	promptState: PromptIndicatorState
	showDiffs: boolean
}) {
	return (
		<>
			{/* No `self-start`: it pinned the tile to the top of the text column and left it
			    high of the row's middle. Both lines beside it are single-line (truncate), so
			    the column can never grow and centring can never drift. */}
			<div className="relative shrink-0">
				<RepoAvatar icon={w.icon} name={w.repo_name || workspaceTitle(w)} artwork="full-bleed" />
				{/* `bg-surface` fills the spinner's hollow centre so the avatar doesn't show through it. */}
				<StatusDot
					w={w}
					promptState={promptState}
					className="absolute -right-0.5 -bottom-0.5 bg-surface ring-2 ring-surface"
				/>
				{w.run_active ? <RunBadge className="absolute -top-0.5 -left-0.5" /> : null}
			</div>
			<div className="min-w-0 flex-1 space-y-1.25 overflow-hidden">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-1.5">
						<span
							className={cn(
								'min-w-0 truncate text-sm leading-none',
								unread ? 'font-bold' : 'font-medium',
								unread || selected ? 'text-text' : 'text-muted'
							)}
						>
							{workspaceTitle(w)}
						</span>
						{w.pinned_at ? <span className="shrink-0 text-xs text-faint">📌</span> : null}
						{/* Unread is a per-chat flag, so one unread chat has no number worth printing — a
						    dot says it; the count only appears once several chats here have news. */}
						{unread > 1 ? <Badge>{unread}</Badge> : unread ? <span className="dot size-2 bg-accent" /> : null}
					</div>
					{/* Conductor's own sidebar puts +adds/-deletes on the workspace title line.
					    The patch size owns the trailing edge; pin and unread stay with the title. */}
					{showDiffs ? <ChangeStats stats={w.change_stats} /> : null}
				</div>
				{/* Context usage is *not* here: a workspace holds several chats and this card can only
				    speak for the active one, so the number read as the workspace's. It lives on the
				    chat tab that owns it (components/session/SessionTabs.tsx ▸ SessionTabs). */}
				{/* Age first: it is the one thing every row is scanned for, and the left edge is
				    where that scan already is. The run identity sits at the right edge: workflows
				    span several models, while an ordinary workspace names its active chat's model. */}
				<div className="flex min-w-0 items-end gap-2 text-xs text-muted">
					<span className="shrink-0 text-[11px] text-faint">{relativeAge(w.updated_at)}</span>
					<WorkspaceRunLabel workspace={w} modelGroups={modelGroups} configuredRoles={workflowRoles} />
				</div>
			</div>
		</>
	)
}
