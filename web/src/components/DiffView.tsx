import { useId, useRef } from 'react'
import { useDiff, useWorkspaces } from '../hooks.ts'
import { MergeBanner } from './MergeBanner.tsx'
import { Patch, scrollToPatchFile } from './Patch.tsx'
import { Empty, Spinner } from './ui.tsx'

export function DiffView({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string | null }) {
	const scroller = useRef<HTMLDivElement>(null)
	const { data: state } = useWorkspaces()
	const ws = state?.workspaces.find(w => w.id === workspaceId)
	// Shares react-query's cache with DiffBody's useDiff (same key) — one fetch, no double request.
	const { data: diff } = useDiff(workspaceId, true)
	const local = diff ? { dirty: diff.dirty, unpushed: diff.unpushed } : undefined
	return (
		<div ref={scroller} className="pb-safe min-h-0 flex flex-1 flex-col overflow-y-auto overscroll-contain">
			{ws ? <MergeBanner ws={ws} local={local} sessionId={sessionId} /> : null}
			<DiffBody workspaceId={workspaceId} scrollToFile={anchorId => scrollToPatchFile(anchorId, scroller.current)} />
		</div>
	)
}

function DiffBody({ workspaceId, scrollToFile }: { workspaceId: string; scrollToFile: (anchorId: string) => void }) {
	const { data, isLoading, isError, error } = useDiff(workspaceId, true)
	const anchorPrefix = useId()

	if (isLoading && !data) return <Spinner label="Computing diff…" />
	if (isError) return <Empty>{(error as Error)?.message}</Empty>
	if (!data) return <Empty>No diff.</Empty>
	if (data.files.length === 0)
		return (
			<Empty>
				No changes vs <span className="font-mono">{data.base}</span>.
			</Empty>
		)
	const fileAnchorIds = data.files.map((_, index) => `${anchorPrefix}-file-${index}`)

	return (
		<>
			<div className="border-b border-border-soft px-3 py-2 text-xs text-muted">
				vs <span className="font-mono text-faint">{data.base}</span> · {data.files.length} file
				{data.files.length === 1 ? '' : 's'}
			</div>
			{/* One grid for the whole list, each row a subgrid: the two count columns take the
			    same width on every row, so a zero count renders as an empty cell — no marker,
			    no number — and the counts beside it stay put. */}
			<ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 px-3 py-3 font-mono text-[12px]">
				{data.files.map((f, index) => (
					<li key={f.path} className="col-span-3 grid grid-cols-subgrid items-center">
						<button
							type="button"
							onClick={() => scrollToFile(fileAnchorIds[index])}
							aria-controls={fileAnchorIds[index]}
							className="col-span-3 grid min-w-0 grid-cols-subgrid items-center rounded-sm py-0.5 text-left transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2"
						>
							<span className="truncate text-muted">{f.path}</span>
							<span className="text-right text-add">{f.added ? `+${f.added}` : null}</span>
							<span className="text-right text-del">{f.removed ? `−${f.removed}` : null}</span>
						</button>
					</li>
				))}
			</ul>
			<Patch
				patch={data.patch}
				truncated={data.truncated}
				fileAnchorIds={fileAnchorIds}
				className="border-t border-border-soft px-3 py-3"
			/>
		</>
	)
}
