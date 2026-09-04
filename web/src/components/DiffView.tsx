import { ChevronLeft, ChevronRight, List } from 'lucide-react'
import { useMemo } from 'react'
import { useFilePreview } from '../hooks.ts'
import { cn } from '../lib/cn.ts'
import type { DiffFileScope } from '../lib/diff.ts'
import { filesForScope, patchForFile } from '../lib/diff.ts'
import type { DiffFile, Workspace, WorkspaceDiff, WorkspaceFilesResponse } from '../lib/types.ts'
import { MergeBanner } from './MergeBanner.tsx'
import { Patch } from './Patch.tsx'
import { SourceLines } from './SourceLines.tsx'
import { Empty, Spinner } from './ui.tsx'
import { ViewerHeader } from './ViewerHeader.tsx'

interface ReviewQuery<T> {
	data: T | undefined
	isLoading: boolean
	isError: boolean
	error: Error | null
}

/** Query results shared by the center viewer and both responsive copies of the file rail. */
export interface DiffReviewState {
	workspace: Workspace
	query: ReviewQuery<WorkspaceDiff>
	filesQuery: ReviewQuery<WorkspaceFilesResponse>
}

/** The right review rail: actions and workspace files, never the patch itself. */
export function DiffView({
	review,
	sessionId,
	scope,
	selectedFile,
	onSelectFile
}: {
	review: DiffReviewState
	sessionId?: string | null
	scope: DiffFileScope
	selectedFile: string | null
	onSelectFile: (path: string) => void
}) {
	const { workspace: ws, query, filesQuery } = review
	const { data, isLoading, isError, error } = query
	const local = data ? { dirty: data.dirty, unpushed: data.unpushed } : undefined
	const files = useMemo(
		() => filesForScope(scope, data?.files ?? [], filesQuery.data?.files ?? []),
		[scope, data?.files, filesQuery.data?.files]
	)
	const listLoading = scope === 'changed' ? isLoading : filesQuery.isLoading
	const listError = scope === 'changed' ? isError : filesQuery.isError
	const listErrorDetail = scope === 'changed' ? error : filesQuery.error
	const hasListData = scope === 'changed' ? !!data : !!filesQuery.data

	return (
		<div className="min-h-0 flex flex-1 flex-col">
			<MergeBanner ws={ws} local={local} sessionId={sessionId} />
			{listLoading && !hasListData ? (
				<Spinner label={scope === 'changed' ? 'Computing diff…' : 'Listing files…'} />
			) : null}
			{listError && !hasListData ? <Empty>{listErrorDetail?.message}</Empty> : null}
			{!listLoading && !listError && !hasListData ? (
				<Empty>{scope === 'changed' ? 'No diff.' : 'No file list.'}</Empty>
			) : null}
			{scope === 'changed' && data?.files.length === 0 ? (
				<Empty>
					No changes vs <span className="font-mono">{data.base}</span>.
				</Empty>
			) : null}
			{scope === 'all' && filesQuery.data?.files.length === 0 ? (
				<Empty>No previewable files in this workspace.</Empty>
			) : null}
			{hasListData && files.length > 0 ? (
				<>
					<div className="shrink-0 border-b border-border-soft px-3 py-2 text-xs text-muted">
						{scope === 'changed' && data ? (
							<>
								vs <span className="font-mono text-faint">{data.base}</span> · {files.length} file
								{files.length === 1 ? '' : 's'}
							</>
						) : (
							<>
								{files.length}
								{filesQuery.data?.truncated ? '+' : ''} previewable file{files.length === 1 ? '' : 's'}
							</>
						)}
					</div>
					<DiffFileList files={files} selectedFile={selectedFile} onSelectFile={onSelectFile} />
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
	scope,
	onSelectFile,
	onShowFiles,
	onClose
}: {
	review: DiffReviewState
	filePath: string
	scope: DiffFileScope
	onSelectFile: (path: string) => void
	onShowFiles: () => void
	onClose: () => void
}) {
	const { workspace, query, filesQuery } = review
	const { data, isLoading, isError, error } = query
	const files = useMemo(
		() => filesForScope(scope, data?.files ?? [], filesQuery.data?.files ?? []),
		[scope, data?.files, filesQuery.data?.files]
	)
	const fileIndex = files.findIndex(file => file.path === filePath)
	const file = fileIndex >= 0 ? files[fileIndex] : undefined
	const patch = useMemo(
		() => (scope === 'changed' && data ? patchForFile(data.patch, data.files, filePath) : null),
		[scope, data, filePath]
	)
	const previous = fileIndex > 0 ? files[fileIndex - 1] : undefined
	const next = fileIndex >= 0 && fileIndex < files.length - 1 ? files[fileIndex + 1] : undefined
	const sourceReference = scope === 'all' && workspace.worktree ? `${workspace.worktree}/${filePath}` : null
	const sourceQuery = useFilePreview(sourceReference, scope === 'all')
	const fileLabel = scope === 'changed' ? 'changed file' : 'file'
	const filesLabel = scope === 'changed' ? 'changed files' : 'all files'

	return (
		<section
			className="min-h-0 flex flex-1 flex-col bg-bg"
			aria-label={scope === 'changed' ? `Changes in ${filePath}` : `Source of ${filePath}`}
		>
			<ViewerHeader
				title={
					<span className="flex items-baseline gap-2">
						<span>{scope === 'changed' ? 'Changes' : 'Source'}</span>
						{scope === 'changed' && file?.added ? (
							<span className="text-xs font-normal text-add">+{file.added}</span>
						) : null}
						{scope === 'changed' && file?.removed ? (
							<span className="text-xs font-normal text-del">−{file.removed}</span>
						) : null}
					</span>
				}
				subtitle={file?.path ?? filePath}
				actions={
					<div className="flex shrink-0 items-center gap-0.5 lg:hidden">
						<button
							type="button"
							onClick={() => previous && onSelectFile(previous.path)}
							disabled={!previous}
							aria-label={`Previous ${fileLabel}`}
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-25"
						>
							<ChevronLeft size={17} />
						</button>
						<span className="min-w-9 text-center text-[11px] tabular-nums text-faint">
							{fileIndex >= 0 ? `${fileIndex + 1}/${files.length}` : '—'}
						</span>
						<button
							type="button"
							onClick={() => next && onSelectFile(next.path)}
							disabled={!next}
							aria-label={`Next ${fileLabel}`}
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2 disabled:opacity-25"
						>
							<ChevronRight size={17} />
						</button>
						<button
							type="button"
							onClick={onShowFiles}
							aria-label={`Show ${filesLabel}`}
							className="flex size-8 items-center justify-center rounded-full text-muted transition active:bg-surface-2"
						>
							<List size={17} />
						</button>
					</div>
				}
				onClose={onClose}
				closeLabel="Close file viewer"
			/>
			<div className="min-h-0 flex-1 overflow-auto overscroll-contain">
				{scope === 'changed' ? (
					<>
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
						{patch !== null ? <Patch patch={patch} fileName={filePath} hideFileHeader className="p-4" /> : null}
					</>
				) : (
					<>
						{sourceQuery.isLoading && !sourceQuery.data ? <Spinner label="Reading source…" /> : null}
						{sourceQuery.isError && !sourceQuery.data ? <Empty>{sourceQuery.error?.message}</Empty> : null}
						{!filesQuery.isLoading && !workspace.worktree ? <Empty>Workspace files are unavailable.</Empty> : null}
						{sourceQuery.data ? <SourceLines preview={sourceQuery.data} /> : null}
					</>
				)}
			</div>
		</section>
	)
}
