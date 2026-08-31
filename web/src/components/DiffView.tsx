import { useDiff, useWorkspaces } from '../hooks.ts'
import { MergeBanner } from './MergeBanner.tsx'
import { Patch } from './Patch.tsx'
import { Empty, Spinner } from './ui.tsx'

export function DiffView({ workspaceId }: { workspaceId: string }) {
	const { data: state } = useWorkspaces()
	const ws = state?.workspaces.find(w => w.id === workspaceId)
	// Shares react-query's cache with DiffBody's useDiff (same key) — one fetch, no double request.
	const { data: diff } = useDiff(workspaceId, true)
	const local = diff ? { dirty: diff.dirty, unpushed: diff.unpushed } : undefined
	return (
		<div className="pb-safe flex flex-1 flex-col overflow-y-auto">
			{ws ? <MergeBanner ws={ws} local={local} /> : null}
			<DiffBody workspaceId={workspaceId} />
		</div>
	)
}

function DiffBody({ workspaceId }: { workspaceId: string }) {
	const { data, isLoading, isError, error } = useDiff(workspaceId, true)

	if (isLoading && !data) return <Spinner label="Computing diff…" />
	if (isError) return <Empty>{(error as Error)?.message}</Empty>
	if (!data) return <Empty>No diff.</Empty>
	if (data.files.length === 0)
		return (
			<Empty>
				No changes vs <span className="font-mono">{data.base}</span>.
			</Empty>
		)

	return (
		<>
			<div className="border-b border-border-soft px-3 py-2 text-xs text-muted">
				vs <span className="font-mono text-faint">{data.base}</span> · {data.files.length} file
				{data.files.length === 1 ? '' : 's'}
			</div>
			<ul className="flex flex-col gap-1 px-3 py-3">
				{data.files.map(f => (
					<li key={f.path} className="flex items-center gap-2 font-mono text-[12px]">
						<span className="truncate text-muted">{f.path}</span>
						<span className="ml-auto shrink-0 text-add">+{f.added}</span>
						<span className="shrink-0 text-del">−{f.removed}</span>
					</li>
				))}
			</ul>
			<Patch patch={data.patch} truncated={data.truncated} className="border-t border-border-soft px-3 py-3" />
		</>
	)
}
