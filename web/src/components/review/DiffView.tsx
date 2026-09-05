import { ChevronLeft, ChevronRight, List } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useFilePreview } from '../../hooks/review.ts'
import { cn } from '../../lib/cn.ts'
import type { DiffFileScope, DiffFileTreeNode } from '../../lib/diff.ts'
import { buildDiffFileTree, filesForScope, filesInFlatOrder, filesInTreeOrder, patchForFile } from '../../lib/diff.ts'
import type { DiffFile, Workspace, WorkspaceDiff, WorkspaceFileDiff, WorkspaceFilesResponse } from '../../lib/types.ts'
import { FileIcon, FolderIcon } from '../FileIcon.tsx'
import { Empty, Spinner } from '../ui.tsx'
import { MergeBanner } from '../workspaces/MergeBanner.tsx'
import { Patch } from './Patch.tsx'
import { SourceLines } from './SourceLines.tsx'
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
	fileQuery: ReviewQuery<WorkspaceFileDiff>
}

function DiffFileRow({
	file,
	label,
	inset,
	alignWithFolders,
	selected,
	onSelectFile
}: {
	file: DiffFile
	label: string
	inset: number
	alignWithFolders?: boolean
	selected: boolean
	onSelectFile: (path: string) => void
}) {
	return (
		<li>
			<button
				type="button"
				title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
				aria-label={file.oldPath ? `${file.path}, renamed from ${file.oldPath}` : file.path}
				onClick={() => onSelectFile(file.path)}
				aria-pressed={selected}
				className={cn(
					'grid min-h-8 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md pr-2 text-left transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2',
					selected && 'bg-accent-soft'
				)}
				style={{ paddingLeft: inset }}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{alignWithFolders ? <span className="size-3.5 shrink-0" aria-hidden="true" /> : null}
					<FileIcon path={file.path} />
					<span className={cn('truncate', selected ? 'text-text' : 'text-muted')}>{label}</span>
					{file.oldPath ? (
						<span className="shrink-0 text-[10px] text-accent" aria-hidden="true">
							R
						</span>
					) : null}
				</span>
				<span className="min-w-8 text-right text-add">{file.added ? `+${file.added}` : null}</span>
				<span className="min-w-8 text-right text-del">{file.removed ? `−${file.removed}` : null}</span>
			</button>
		</li>
	)
}

/** The right review rail: actions and workspace files, never the patch itself. */
export function DiffView({
	review,
	sessionId,
	scope,
	showFolders,
	selectedFile,
	onSelectFile
}: {
	review: DiffReviewState
	sessionId?: string | null
	scope: DiffFileScope
	showFolders: boolean
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
					<DiffFileList
						files={files}
						scope={scope}
						showFolders={showFolders}
						selectedFile={selectedFile}
						onSelectFile={onSelectFile}
					/>
				</>
			) : null}
		</div>
	)
}

export function DiffFileList({
	files,
	scope,
	showFolders,
	selectedFile,
	onSelectFile
}: {
	files: readonly DiffFile[]
	scope: DiffFileScope
	showFolders: boolean
	selectedFile: string | null
	onSelectFile: (path: string) => void
}) {
	// All-files can hold thousands of entries. Build only the representation on
	// screen rather than sorting both the tree and flat list after every refresh.
	const tree = useMemo(() => (showFolders ? buildDiffFileTree(files) : []), [files, showFolders])
	const flatFiles = useMemo(() => (showFolders ? [] : filesInFlatOrder(files)), [files, showFolders])
	const selectedFolders = useMemo(() => {
		if (!selectedFile) return []
		const parts = selectedFile.split('/')
		parts.pop()
		return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
	}, [selectedFile])
	const [folderOverrides, setFolderOverrides] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(selectedFolders.map(path => [path, true]))
	)

	useEffect(() => {
		if (!selectedFolders.length) return
		setFolderOverrides(current => {
			const next = new Map(current)
			let changed = false
			for (const path of selectedFolders) {
				if (next.get(path) === true) continue
				next.set(path, true)
				changed = true
			}
			return changed ? next : current
		})
	}, [selectedFolders])

	const folderExpanded = (path: string) => folderOverrides.get(path) ?? scope === 'changed'
	const toggleFolder = (path: string) => {
		setFolderOverrides(current => {
			const next = new Map(current)
			next.set(path, !(current.get(path) ?? scope === 'changed'))
			return next
		})
	}

	const renderNode = (node: DiffFileTreeNode, depth: number) => {
		const inset = 8 + depth * 16
		if (node.kind === 'folder') {
			const expanded = folderExpanded(node.path)
			const onSelectedPath = !!selectedFile?.startsWith(`${node.path}/`)
			return (
				<li key={node.path}>
					<button
						type="button"
						onClick={() => toggleFolder(node.path)}
						aria-expanded={expanded}
						aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.path}, ${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`}
						className="grid min-h-8 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md pr-2 text-left transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2"
						style={{ paddingLeft: inset }}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							<ChevronRight
								size={14}
								className={cn('shrink-0 text-faint transition-transform', expanded && 'rotate-90')}
							/>
							<FolderIcon path={node.path} expanded={expanded} />
							<span className={cn('truncate', onSelectedPath ? 'text-text' : 'text-muted')}>{node.name}</span>
							<span className="shrink-0 text-[10px] tabular-nums text-faint">{node.fileCount}</span>
						</span>
						<span className="min-w-8 text-right text-add">{node.added ? `+${node.added}` : null}</span>
						<span className="min-w-8 text-right text-del">{node.removed ? `−${node.removed}` : null}</span>
					</button>
					{expanded ? <ul>{node.children.map(child => renderNode(child, depth + 1))}</ul> : null}
				</li>
			)
		}

		return (
			<DiffFileRow
				key={node.path}
				file={node.file}
				label={node.name}
				inset={inset}
				alignWithFolders
				selected={node.path === selectedFile}
				onSelectFile={onSelectFile}
			/>
		)
	}

	if (!showFolders) {
		return (
			<ul
				aria-label={`${scope === 'changed' ? 'Changed' : 'All'} files`}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 font-mono text-[12px]"
			>
				{flatFiles.map(file => (
					<DiffFileRow
						key={file.path}
						file={file}
						label={file.path}
						inset={8}
						selected={file.path === selectedFile}
						onSelectFile={onSelectFile}
					/>
				))}
			</ul>
		)
	}

	return (
		<ul
			aria-label={`${scope === 'changed' ? 'Changed' : 'All'} files by folder`}
			className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 font-mono text-[12px]"
		>
			{tree.map(node => renderNode(node, 0))}
		</ul>
	)
}

/** A selected file takes the transcript's space while the composer and both rails stay put. */
export function DiffFileViewer({
	review,
	filePath,
	scope,
	showFolders,
	onSelectFile,
	onShowFiles,
	onClose
}: {
	review: DiffReviewState
	filePath: string
	scope: DiffFileScope
	showFolders: boolean
	onSelectFile: (path: string) => void
	onShowFiles: () => void
	onClose: () => void
}) {
	const { workspace, query, filesQuery, fileQuery } = review
	const { data, isLoading, isError, error } = query
	const files = useMemo(() => {
		const scoped = filesForScope(scope, data?.files ?? [], filesQuery.data?.files ?? [])
		return showFolders ? filesInTreeOrder(scoped) : filesInFlatOrder(scoped)
	}, [scope, showFolders, data?.files, filesQuery.data?.files])
	const fileIndex = files.findIndex(file => file.path === filePath)
	const file = fileIndex >= 0 ? files[fileIndex] : undefined
	const aggregatePatch = useMemo(
		() => (scope === 'changed' && data && !data.truncated ? patchForFile(data.patch, data.files, filePath) : null),
		[scope, data, filePath]
	)
	const needsFileResponse = scope === 'changed' && !!data?.truncated
	const fileResponse = needsFileResponse && fileQuery.data?.path === filePath ? fileQuery.data : null
	const patch = fileResponse?.patch ?? aggregatePatch
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
				subtitle={
					file?.oldPath ? (
						<span title={`${file.oldPath} → ${file.path}`}>
							{file.oldPath} → {file.path}
						</span>
					) : (
						(file?.path ?? filePath)
					)
				}
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
						{data && fileIndex >= 0 && needsFileResponse && fileQuery.isLoading && !fileResponse ? (
							<Spinner label="Loading file changes…" />
						) : null}
						{data && fileIndex >= 0 && needsFileResponse && fileQuery.isError && !fileResponse ? (
							<Empty>{fileQuery.error?.message}</Empty>
						) : null}
						{data && fileIndex >= 0 && !needsFileResponse && patch === null ? (
							<Empty>No textual patch is available for this file.</Empty>
						) : null}
						{fileResponse && !patch ? <Empty>No textual patch is available for this file.</Empty> : null}
						{patch ? <Patch patch={patch} fileName={filePath} hideFileHeader className="p-4" /> : null}
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
