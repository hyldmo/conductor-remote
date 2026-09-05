import { History, Hourglass, LoaderCircle, Plus, X } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { cn } from '../../lib/cn.ts'
import type { PromptIndicatorState } from '../../lib/prompts/pending.ts'
import { isUnread, type ReadMarks } from '../../lib/read.ts'
import type { Session, SessionRoleAssignment } from '../../lib/types.ts'
import { FileIcon } from '../FileIcon.tsx'
import { RoleChip } from '../orchestration/RolesSettings.tsx'
import { PromptStatusDot } from '../ui.tsx'
import { ContextButton } from './SessionNotices.tsx'

/** Conductor workspaces can hold several sessions — render them as tabs like the desktop app,
 *  with a trailing "+" (new chat, same files) pinned past the scrollable tabs. */
export function SessionTabs({
	sessions,
	activeId,
	readMarks,
	promptStates,
	roles = {},
	subtabSessionIds,
	fileTab,
	onSelect,
	onContext,
	onNewChat,
	onClose,
	onClosedTabs,
	creating,
	closingId,
	online
}: {
	sessions: Session[]
	activeId: string | null
	readMarks: ReadMarks
	promptStates: Record<string, PromptIndicatorState>
	roles?: Record<string, SessionRoleAssignment>
	/** Live delegated children not yet present in the durable role snapshot. */
	subtabSessionIds?: ReadonlySet<string>
	/** One local preview tab, independent of Conductor's real chat sessions. */
	fileTab?: { path: string; active: boolean; onSelect: () => void; onClose: () => void }
	onSelect: (id: string) => void
	onContext: (session: Session) => void
	onNewChat: () => void
	onClose: (id: string) => void
	onClosedTabs: () => void
	creating: boolean
	closingId: string | null
	online: boolean
}) {
	const activeTab = useRef<HTMLDivElement>(null)
	const activeSessionId = fileTab?.active ? null : activeId
	const activeFilePath = fileTab?.active ? fileTab.path : null
	const primarySessions = sessions.filter(
		session => !roles[session.id]?.delegationId && !subtabSessionIds?.has(session.id)
	)
	const activeHasPrimaryTab = primarySessions.some(session => session.id === activeSessionId)

	// Opening a workspace can restore a session near the end of a long tab row. Keep its
	// selected tab visible on first paint and after each tab change, without moving the
	// transcript or the rest of the page.
	useLayoutEffect(() => {
		if (!(activeSessionId && activeHasPrimaryTab) && !activeFilePath) return
		activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [activeSessionId, activeHasPrimaryTab, activeFilePath])

	return (
		<nav
			aria-label="Workspace tabs"
			className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-bg px-3 py-2"
		>
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
				{primarySessions.map(s => {
					const promptState = promptStates[s.id]
					const hasContext = typeof s.context_used_percent === 'number' && s.context_used_percent > 0
					return (
						<div
							key={s.id}
							ref={s.id === activeSessionId ? activeTab : undefined}
							className={cn(
								'flex shrink-0 items-center rounded-full text-sm font-medium text-muted transition',
								s.id === activeSessionId && 'bg-surface-2 text-text'
							)}
						>
							<button
								type="button"
								onClick={() => onSelect(s.id)}
								aria-current={s.id === activeSessionId ? 'page' : undefined}
								className={cn(
									'flex min-w-0 items-center gap-1.5 py-1.5 pl-3.5',
									sessions.length > 1 || hasContext ? 'pr-1' : 'pr-3.5'
								)}
							>
								{promptState ? (
									<PromptStatusDot state={promptState} className="size-3" />
								) : s.status === 'working' ? (
									<span className="dot-spinner size-3" />
								) : s.background_tasks?.length ? (
									<Hourglass size={11} className="shrink-0 text-faint" aria-label="Waiting for a background task" />
								) : null}
								<span className="whitespace-nowrap">{s.title || 'Untitled'}</span>
								{roles[s.id] ? <RoleChip name={roles[s.id].role} /> : null}
								{/* `unread_count` is a 0/1 flag, so a dot — not the meaningless number "1". */}
								{isUnread(s, readMarks) ? <span className="dot size-1.5 bg-accent" /> : null}
							</button>
							<ContextButton session={s} onOpen={() => onContext(s)} />
							{sessions.length > 1 ? (
								<button
									type="button"
									onClick={() => onClose(s.id)}
									disabled={!online || closingId !== null}
									aria-label={`Close ${s.title || 'Untitled'} chat`}
									className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-bg/70 active:text-text disabled:opacity-40"
								>
									{closingId === s.id ? <LoaderCircle size={12} className="animate-spin" /> : <X size={12} />}
								</button>
							) : null}
						</div>
					)
				})}
				{fileTab ? (
					<div
						ref={fileTab.active ? activeTab : undefined}
						className={cn(
							'flex shrink-0 items-center rounded-full text-sm font-medium text-muted transition',
							fileTab.active && 'bg-surface-2 text-text'
						)}
					>
						<button
							type="button"
							onClick={fileTab.onSelect}
							aria-label={`Open ${fileTab.path}`}
							aria-current={fileTab.active ? 'page' : undefined}
							title={fileTab.path}
							className="flex min-w-0 items-center gap-1.5 py-1.5 pl-3.5 pr-1"
						>
							<FileIcon path={fileTab.path} />
							<span className="whitespace-nowrap">{fileTab.path.split('/').pop()}</span>
						</button>
						<button
							type="button"
							onClick={fileTab.onClose}
							aria-label={`Close ${fileTab.path} file tab`}
							className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-bg/70 active:text-text"
						>
							<X size={12} />
						</button>
					</div>
				) : null}
			</div>
			<button
				type="button"
				onClick={onClosedTabs}
				aria-label="Closed tabs"
				title="Closed tabs"
				aria-haspopup="dialog"
				className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2"
			>
				<History size={17} />
			</button>
			<button
				type="button"
				onClick={onNewChat}
				disabled={creating}
				aria-label="New chat, same files"
				className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-40"
			>
				<Plus size={18} />
			</button>
		</nav>
	)
}

export function TabCloseNotice({
	title,
	busy,
	onCancel,
	onConfirm
}: {
	title: string
	busy: boolean
	onCancel: () => void
	onConfirm: () => void
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-working/30 bg-working/5 px-3 py-2 text-xs">
			<span className="min-w-0 flex-1 truncate">
				<span className="font-semibold">{title}</span> is still working. Close the tab anyway?
			</span>
			<button
				type="button"
				onClick={onCancel}
				disabled={busy}
				className="rounded-lg px-2 py-1 text-muted active:bg-surface-2"
			>
				Cancel
			</button>
			<button
				type="button"
				onClick={onConfirm}
				disabled={busy}
				className="flex items-center gap-1 rounded-lg bg-del px-2 py-1 font-semibold text-black active:scale-95 disabled:opacity-50"
			>
				{busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
				Close anyway
			</button>
		</div>
	)
}
