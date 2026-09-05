import { FileDiff, FolderTree, X } from 'lucide-react'
import { cn } from '../../lib/cn.ts'
import type { DiffFileScope } from '../../lib/diff.ts'
import type { DiffStats } from '../../lib/types.ts'
import { type DiffReviewState, DiffView } from '../review/DiffView.tsx'

/** Header shortcut to the workspace diff, with a glanceable hint when changes exist. */
export function DiffButton({
	stats,
	open,
	onToggle
}: {
	stats?: DiffStats | null
	open: boolean
	onToggle: () => void
}) {
	const hasDiff = !!stats && (stats.added > 0 || stats.removed > 0)
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={hasDiff ? 'Toggle diff panel, changes available' : 'Toggle diff panel'}
			aria-pressed={open}
			className={cn(
				'relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition active:bg-surface-2',
				open && 'bg-surface-2 text-text'
			)}
		>
			<FileDiff size={19} />
			{hasDiff ? (
				<span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />
			) : null}
		</button>
	)
}

/** One shared segmented control for the desktop rail and mobile file navigator. */
export function DiffFileScopeToggle({
	scope,
	onChange
}: {
	scope: DiffFileScope
	onChange: (scope: DiffFileScope) => void
}) {
	return (
		<fieldset aria-label="Files shown" className="flex shrink-0 rounded-full bg-surface-2 p-0.5 text-xs">
			{(['changed', 'all'] as const).map(value => (
				<button
					key={value}
					type="button"
					onClick={() => onChange(value)}
					aria-label={value === 'changed' ? 'Changed files' : 'All files'}
					aria-pressed={scope === value}
					className={cn(
						'rounded-full px-2.5 py-1 font-medium text-muted transition',
						scope === value && 'bg-bg text-text shadow-sm'
					)}
				>
					{value === 'changed' ? 'Changed' : 'All'}
				</button>
			))}
		</fieldset>
	)
}

/** One persisted switch shared by the desktop rail and mobile file navigator. */
export function DiffFolderToggle({
	showFolders,
	onChange
}: {
	showFolders: boolean
	onChange: (showFolders: boolean) => void
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!showFolders)}
			aria-label="Group files into folders"
			aria-pressed={showFolders}
			title="Group files into folders"
			className={cn(
				'flex size-8 shrink-0 items-center justify-center rounded-full text-faint transition active:bg-surface-2',
				showFolders && 'bg-surface-2 text-text'
			)}
		>
			<FolderTree size={16} />
		</button>
	)
}

/** Workspace files stay as the right rail on lg+. */
export function DiffPanel({
	review,
	sessionId,
	scope,
	onScopeChange,
	showFolders,
	onShowFoldersChange,
	selectedFile,
	onSelectFile,
	onClose
}: {
	review: DiffReviewState
	sessionId: string | null
	scope: DiffFileScope
	onScopeChange: (scope: DiffFileScope) => void
	showFolders: boolean
	onShowFoldersChange: (showFolders: boolean) => void
	selectedFile: string | null
	onSelectFile: (path: string) => void
	onClose: () => void
}) {
	return (
		<aside className="hidden flex-col bg-bg lg:flex lg:w-[380px] lg:shrink-0 lg:border-l lg:border-border-soft xl:w-[460px]">
			<header className="flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
				<span className="flex-1 text-[15px] font-semibold">Files</span>
				<DiffFileScopeToggle scope={scope} onChange={onScopeChange} />
				<DiffFolderToggle showFolders={showFolders} onChange={onShowFoldersChange} />
				<button
					type="button"
					onClick={onClose}
					aria-label="Close diff panel"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<DiffView
				review={review}
				sessionId={sessionId}
				scope={scope}
				showFolders={showFolders}
				selectedFile={selectedFile}
				onSelectFile={onSelectFile}
			/>
		</aside>
	)
}

/** On narrow screens the same file rail replaces only the transcript, never the composer. */
export function MobileDiffNavigator({
	review,
	sessionId,
	scope,
	onScopeChange,
	showFolders,
	onShowFoldersChange,
	selectedFile,
	onSelectFile,
	onClose
}: {
	review: DiffReviewState
	sessionId: string | null
	scope: DiffFileScope
	onScopeChange: (scope: DiffFileScope) => void
	showFolders: boolean
	onShowFoldersChange: (showFolders: boolean) => void
	selectedFile: string | null
	onSelectFile: (path: string) => void
	onClose: () => void
}) {
	return (
		<section className="absolute inset-0 z-20 flex flex-col bg-bg lg:hidden" aria-label="Workspace files">
			<header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2.5">
				<span className="flex-1 text-[15px] font-semibold">Files</span>
				<DiffFileScopeToggle scope={scope} onChange={onScopeChange} />
				<DiffFolderToggle showFolders={showFolders} onChange={onShowFoldersChange} />
				<button
					type="button"
					onClick={onClose}
					aria-label="Close diff panel"
					className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
				>
					<X size={20} />
				</button>
			</header>
			<DiffView
				review={review}
				sessionId={sessionId}
				scope={scope}
				showFolders={showFolders}
				selectedFile={selectedFile}
				onSelectFile={onSelectFile}
			/>
		</section>
	)
}
