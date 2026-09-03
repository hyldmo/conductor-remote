import { ChevronLeft, ChevronRight, List } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '../lib/cn.ts'
import { patchForFile } from '../lib/diff.ts'
import type { DiffFile, Workspace, WorkspaceDiff } from '../lib/types.ts'
import { MergeBanner } from './MergeBanner.tsx'
import { Patch } from './Patch.tsx'
import { Empty, Spinner } from './ui.tsx'
import { ViewerHeader } from './ViewerHeader.tsx'

/** One query result shared by the center viewer and both responsive copies of the file rail. */
export interface DiffReviewState {
	workspace: Workspace
	query: {
		data: WorkspaceDiff | undefined
		isLoading: boolean
		isError: boolean
		error: Error | null
	}
}

/** The right review rail: actions and changed files, never the patch itself. */
export function DiffView({
	review,
	sessionId,
	selectedFile,
	onSelectFile
}: {
	review: DiffReviewState
	sessionId?: string | null
	selectedFile: string | null
	onSelectFile: (path: string) => void
}) {
	const { workspace: ws, query } = review
	const { data, isLoading, isError, error } = query
	const local = data ? { dirty: data.dirty, unpushed: data.unpushed } : undefined

	return (
		<div className="min-h-0 flex flex-1 flex-col">
			<MergeBanner ws={ws} local={local} sessionId={sessionId} />
			{isLoading && !data ? <Spinner label="Computing diff…" /> : null}
			{isError ? <Empty>{error?.message}</Empty> : null}
			{!isLoading && !isError && !data ? <Empty>No diff.</Empty> : null}
			{data?.files.length === 0 ? (
				<Empty>
					No changes vs <span className="font-mono">{data.base}</span>.
				</Empty>
			) : null}
			{data && data.files.length > 0 ? (
				<>
					<div className="shrink-0 border-b border-border-soft px-3 py-2 text-xs text-muted">
						vs <span className="font-mono text-faint">{data.base}</span> · {data.files.length} file
						{data.files.length === 1 ? '' : 's'}
					</div>
					<DiffFileList files={data.files} selectedFile={selectedFile} onSelectFile={onSelectFile} />
				</>
			) : null}
		</div>
	)
}

export function DiffFileList({
	files,
	selectedFile,
	onSelectFile
}: {
	files: readonly DiffFile[]
	selectedFile: string | null
	onSelectFile: (path: string) => void
}) {
	return (
		<ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 overflow-y-auto overscroll-contain px-2 py-2 font-mono text-[12px]">
			{files.map(file => {
				const selected = file.path === selectedFile
				return (
					<li key={file.path} className="col-span-3 grid grid-cols-subgrid items-center">
						<button
							type="button"
							title={file.path}
							onClick={() => onSelectFile(file.path)}
							aria-pressed={selected}
							className={cn(
								'col-span-3 grid min-w-0 grid-cols-subgrid items-center rounded-md px-2 py-1.5 text-left transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2',
								selected && 'bg-accent-soft'
							)}
						>
							<span className={cn('truncate', selected ? 'text-text' : 'text-muted')}>{file.path}</span>
							<span className="text-right text-add">{file.added ? `+${file.added}` : null}</span>
							<span className="text-right text-del">{file.removed ? `−${file.removed}` : null}</span>
						</button>
					</li>
				)
			})}
		</ul>
	)
}

/** A selected file takes the transcript's space while the composer and both rails stay put. */
export function DiffFileViewer({
	review,
	filePath,
	onSelectFile,
	onShowFiles,
	onClose
}: {
	review: DiffReviewState
	filePath: string
	onSelectFile: (path: string) => void
	onShowFiles: () => void
	onClose: () => void
}) {
	const { query } = review
	const { data, isLoading, isError, error } = query
	const fileIndex = data?.files.findIndex(file => file.path === filePath) ?? -1
	const file = fileIndex >= 0 ? data?.files[fileIndex] : undefined
	const patch = useMemo(() => (data ? patchForFile(data.patch, data.files, filePath) : null), [data, filePath])
	const previous = fileIndex > 0 ? data?.files[fileIndex - 1] : undefined
	const next = data && fileIndex >= 0 && fileIndex < data.files.length - 1 ? data.files[fileIndex + 1] : undefined

	return (
		<section className="min-h-0 flex flex-1 flex-col bg-bg" aria-label={`Changes in ${filePath}`}>
			<ViewerHeader
				title={
					<span className="flex items-baseline gap-2">
						<span>Changes</span>
						{file?.added ? <span className="text-xs font-normal text-add">+{file.added}</span> : null}
						{file?.removed ? <span className="text-xs font-normal text-del">−{file.removed}</span> : null}
					</span>
				}
				subtitle={file?.path ?? filePath}
				actions={
					<div className="flex shrink-0 items-center gap-0.5 lg:hidden">
						<button
							type="button"
							onClick={() => previous && onSelectFile(previous.path)}
							disabled={!previous}
							aria-label="Previous changed file"
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-25"
						>
							<ChevronLeft size={17} />
						</button>
						<span className="min-w-9 text-center text-[11px] tabular-nums text-faint">
							{fileIndex >= 0 && data ? `${fileIndex + 1}/${data.files.length}` : '—'}
						</span>
						<button
							type="button"
							onClick={() => next && onSelectFile(next.path)}
							disabled={!next}
							aria-label="Next changed file"
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-25"
						>
							<ChevronRight size={17} />
						</button>
						<button
							type="button"
							onClick={onShowFiles}
							aria-label="Show changed files"
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2"
						>
							<List size={17} />
						</button>
					</div>
				}
				onClose={onClose}
				closeLabel="Close diff viewer"
			/>
			<div className="min-h-0 flex-1 overflow-auto overscroll-contain">
				{isLoading && !data ? <Spinner label="Loading changes…" /> : null}
				{isError ? <Empty>{error?.message}</Empty> : null}
				{data && fileIndex < 0 ? <Empty>This file is no longer changed.</Empty> : null}
				{data && fileIndex >= 0 && patch === null ? (
					<Empty>
						{data.truncated
							? 'This file falls beyond the workspace diff preview.'
							: 'No textual patch is available for this file.'}
					</Empty>
				) : null}
				{patch !== null ? <Patch patch={patch} className="min-w-max p-4" /> : null}
			</div>
		</section>
	)
}
