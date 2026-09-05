import { Download, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAgentImportCandidates } from '../../hooks/agents.ts'
import type { AgentImportScanResponse, ImportAgentsRequest, ImportAgentsResult } from '../../lib/types.ts'
import { Spinner } from '../ui.tsx'

export function AgentImportChoices({
	scan,
	selected,
	overwrite,
	onSelect,
	onOverwrite
}: {
	scan: AgentImportScanResponse
	selected: string[]
	overwrite: boolean
	onSelect: (name: string, checked: boolean) => void
	onOverwrite: (overwrite: boolean) => void
}) {
	return (
		<div className="flex flex-col gap-2">
			{scan.candidates.length === 0 && scan.skipped.length === 0 ? (
				<p className="text-xs text-muted">No agent files found in ~/.claude/agents.</p>
			) : null}
			{scan.candidates.map(candidate => (
				<label key={candidate.name} className="flex items-start gap-2 rounded-xl border border-border-soft p-2.5">
					<input
						type="checkbox"
						aria-label={`Import ${candidate.name}`}
						checked={selected.includes(candidate.name)}
						disabled={candidate.collision && !overwrite}
						onChange={event => onSelect(candidate.name, event.target.checked)}
						className="mt-0.5"
					/>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
							{candidate.name}
							{candidate.collision ? (
								<span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted">
									Already exists
								</span>
							) : null}
						</span>
						{candidate.description ? (
							<span className="mt-1 block text-xs text-muted">{candidate.description}</span>
						) : null}
						<span className="mt-1 block text-[11px] text-faint">
							{candidate.model} · {candidate.hasBody ? 'Has instructions' : 'No instructions'}
						</span>
					</span>
				</label>
			))}
			{scan.candidates.some(candidate => candidate.collision) ? (
				<label className="flex items-center gap-2 text-xs text-muted">
					<input type="checkbox" checked={overwrite} onChange={event => onOverwrite(event.target.checked)} />
					Overwrite selected existing agents
				</label>
			) : null}
			{scan.skipped.map(entry => (
				<p key={entry.name} className="whitespace-pre-wrap break-words rounded-xl bg-del/5 p-2.5 text-xs text-del">
					{entry.name}: skipped — {entry.reason}
				</p>
			))}
			{scan.truncated ? (
				<p className="text-xs text-muted">Only the first {scan.limit} Markdown files were scanned.</p>
			) : null}
		</div>
	)
}

export function AgentsImport({
	onImport
}: {
	onImport: (request: ImportAgentsRequest) => Promise<ImportAgentsResult>
}) {
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<string[]>([])
	const [overwrite, setOverwrite] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [result, setResult] = useState<ImportAgentsResult>()
	const pending = useRef(false)
	const candidates = useAgentImportCandidates(open)
	const names = selected.filter(name =>
		candidates.data?.candidates.some(candidate => candidate.name === name && (!candidate.collision || overwrite))
	)
	const submit = async () => {
		if (!names.length || pending.current) return
		pending.current = true
		setBusy(true)
		setError(undefined)
		setResult(undefined)
		try {
			const imported = await onImport({ names, overwrite })
			setResult(imported)
			const succeeded = new Set(imported.results.filter(outcome => outcome.ok).map(outcome => outcome.name))
			setSelected(current => current.filter(name => !succeeded.has(name)))
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			pending.current = false
			setBusy(false)
		}
	}
	return (
		<div className="mt-2 border-t border-border-soft pt-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex h-8 items-center gap-1.5 rounded-lg px-1 text-xs font-semibold text-muted active:bg-surface-2"
			>
				<Download size={14} /> Import from ~/.claude/agents
			</button>
			{open ? (
				<section className="mt-2 flex flex-col gap-2.5" aria-label="Import agent definitions">
					<p className="text-[11px] leading-relaxed text-faint">
						Imported files are saved immediately. Unsaved edits stay in this editor.
					</p>
					{candidates.isLoading ? <Spinner label="Scanning agent files…" /> : null}
					{candidates.isError ? (
						<p role="alert" className="text-xs text-del">
							{candidates.error.message || 'Could not scan agent files.'}
						</p>
					) : null}
					{candidates.data ? (
						<AgentImportChoices
							scan={candidates.data}
							selected={names}
							overwrite={overwrite}
							onSelect={(name, checked) =>
								setSelected(current =>
									checked ? [...new Set([...current, name])] : current.filter(entry => entry !== name)
								)
							}
							onOverwrite={next => {
								setOverwrite(next)
								if (!next)
									setSelected(current =>
										current.filter(
											name =>
												!candidates.data?.candidates.some(candidate => candidate.name === name && candidate.collision)
										)
									)
							}}
						/>
					) : null}
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={!names.length || busy || candidates.isFetching || candidates.isError}
							onClick={() => void submit()}
							className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-semibold text-white disabled:opacity-35"
						>
							{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
							Import{names.length ? ` (${names.length})` : ''}
						</button>
						<button
							type="button"
							disabled={busy || candidates.isFetching}
							onClick={() => void candidates.refetch()}
							className="h-8 px-2 text-xs text-muted disabled:opacity-35"
						>
							Refresh
						</button>
					</div>
					{result?.results.map(outcome => (
						<p
							key={outcome.name}
							role={outcome.ok ? 'status' : 'alert'}
							className={`text-xs ${outcome.ok ? 'text-muted' : 'text-del'}`}
						>
							{outcome.name}: {outcome.ok ? (outcome.overwritten ? 'Replaced.' : 'Imported.') : outcome.error}
						</p>
					))}
					{error ? (
						<p role="alert" className="text-xs text-del">
							{error}
						</p>
					) : null}
				</section>
			) : null}
		</div>
	)
}
