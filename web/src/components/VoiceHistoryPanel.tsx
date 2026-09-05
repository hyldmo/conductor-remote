import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronRight, Copy, Download, LoaderCircle, PhoneCall } from 'lucide-react'
import { useState } from 'react'
import { client } from '../lib/api.ts'
import { copyText } from '../lib/clipboard.ts'
import { cn } from '../lib/cn.ts'
import type { VoiceHistoryCall, VoiceHistoryEntry } from '../lib/types.ts'
import { voiceToolLabel } from '../lib/voice.ts'
import { voiceTranscriptText } from '../lib/voice-history.ts'

function date(at: number): string {
	return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Entry({ entry }: { entry: VoiceHistoryEntry }) {
	if (entry.role === 'tool') return <p className="py-1 text-center text-xs text-voice">{voiceToolLabel(entry.text)}</p>
	return (
		<div className={cn('max-w-[92%]', entry.role === 'user' ? 'ml-auto' : 'mr-auto')}>
			<p className="mb-1 px-1 text-[11px] text-faint">
				{entry.role === 'user' ? 'You' : 'Orchestrator'} ·{' '}
				{new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
			</p>
			<div
				className={cn(
					'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
					entry.role === 'user' ? 'rounded-br-md bg-voice-soft' : 'rounded-bl-md bg-surface-2'
				)}
			>
				{entry.text}
				{entry.transcriptionFailed ? (
					<p className="mt-1 text-xs text-muted">Audio could not be transcribed.</p>
				) : entry.partial ? (
					<p className="mt-1 text-xs text-muted">Partial transcript</p>
				) : null}
				{entry.interrupted ? (
					<p className="mt-2 text-xs text-muted">
						Reply interrupted. This text may include words that were not played.
					</p>
				) : null}
			</div>
		</div>
	)
}

export function SavedVoiceTranscript({ call }: { call: VoiceHistoryCall }) {
	return (
		<div className="flex flex-col gap-4">
			<p className="text-xs text-muted">
				{date(call.startedAt)} ·{' '}
				{call.status === 'active' ? 'In progress' : call.status === 'ended' ? 'Call ended' : 'Connection interrupted'}
			</p>
			{call.captureError || call.hasGaps ? (
				<p role="status" className="rounded-xl bg-del/10 px-3 py-2 text-xs text-del">
					{call.captureError ?? 'This transcript may have gaps because the connection was interrupted.'}
				</p>
			) : null}
			{call.entries.length ? (
				call.entries.map(entry => <Entry key={entry.id} entry={entry} />)
			) : (
				<p className="py-8 text-center text-sm text-muted">No speech was captured in this call.</p>
			)}
		</div>
	)
}

/** Reads the Mac's archive, so history survives app reloads and changes of device. */
export function VoiceHistoryPanel({
	selectedId,
	onSelect,
	onBack
}: {
	selectedId: string | null
	onSelect: (callId: string | null) => void
	onBack: () => void
}) {
	const [offset, setOffset] = useState(0)
	const [copied, setCopied] = useState(false)
	const [actionError, setActionError] = useState<string | null>(null)
	const list = useQuery({
		queryKey: ['voice-history', offset],
		queryFn: () => client.voiceHistory(offset),
		enabled: !selectedId,
		staleTime: 0
	})
	const transcript = useQuery({
		queryKey: ['voice-transcript', selectedId],
		queryFn: () => client.voiceTranscript(selectedId!),
		enabled: Boolean(selectedId),
		staleTime: 0,
		refetchInterval: query => (query.state.data?.status === 'active' ? 3_000 : false)
	})
	const call = transcript.data
	const query = selectedId ? transcript : list

	const copy = async () => {
		if (!call) return
		try {
			await copyText(voiceTranscriptText(call))
			setCopied(true)
			setActionError(null)
		} catch {
			setActionError('Could not copy the transcript. You can still select its text or export it.')
		}
	}
	const download = () => {
		if (!call) return
		const url = URL.createObjectURL(new Blob([voiceTranscriptText(call)], { type: 'text/plain;charset=utf-8' }))
		const link = document.createElement('a')
		link.href = url
		link.download = `fleet-call-${new Date(call.startedAt).toISOString().replaceAll(':', '-')}.txt`
		link.click()
		setTimeout(() => URL.revokeObjectURL(url), 1_000)
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2">
				<button
					type="button"
					onClick={() => {
						setCopied(false)
						setActionError(null)
						selectedId ? onSelect(null) : onBack()
					}}
					className="flex min-h-11 items-center gap-2 px-2 text-sm text-muted active:text-text"
				>
					<ArrowLeft size={17} />
					{selectedId ? 'Call history' : 'New call'}
				</button>
				<div className="flex-1" />
				{selectedId && call ? (
					<>
						<button
							type="button"
							onClick={() => void copy()}
							aria-label="Copy transcript"
							className="grid size-11 place-items-center rounded-xl text-muted active:bg-surface-2"
						>
							{copied ? <Check size={18} /> : <Copy size={18} />}
						</button>
						<button
							type="button"
							onClick={download}
							aria-label="Export transcript"
							className="grid size-11 place-items-center rounded-xl text-muted active:bg-surface-2"
						>
							<Download size={18} />
						</button>
					</>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
				{actionError ? (
					<p role="alert" className="mb-4 text-xs text-del">
						{actionError}
					</p>
				) : null}
				{query.isPending ? (
					<div className="grid min-h-40 place-items-center">
						<LoaderCircle aria-label="Loading call history" className="animate-spin text-muted" size={22} />
					</div>
				) : query.error ? (
					<div className="py-8 text-center">
						<p role="alert" className="text-sm text-del">
							{query.error.message}
						</p>
						<button
							type="button"
							onClick={() => void query.refetch()}
							className="mt-3 min-h-11 px-4 text-sm text-voice"
						>
							Try again
						</button>
					</div>
				) : selectedId && call ? (
					<SavedVoiceTranscript call={call} />
				) : (
					<>
						<h3 className="mb-1 text-lg font-semibold">Call history</h3>
						<p className="mb-5 text-xs text-muted">Transcripts saved on your Mac.</p>
						{list.data?.calls.length ? (
							<div className="divide-y divide-border-soft">
								{list.data.calls.map(item => (
									<button
										key={item.callId}
										type="button"
										onClick={() => {
											setCopied(false)
											setActionError(null)
											onSelect(item.callId)
										}}
										className="flex w-full items-center gap-3 py-4 text-left active:opacity-70"
									>
										<PhoneCall className="shrink-0 text-voice" size={18} />
										<div className="min-w-0 flex-1">
											<p className="text-sm font-medium">{date(item.startedAt)}</p>
											<p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
												{item.preview || 'No speech captured'}
											</p>
											<p className="mt-1 text-[11px] text-faint">
												{item.entryCount} entries
												{item.status === 'active' ? ' · In progress' : item.hasGaps ? ' · May have gaps' : ''}
											</p>
										</div>
										<ChevronRight className="shrink-0 text-faint" size={17} />
									</button>
								))}
							</div>
						) : (
							<p className="py-8 text-center text-sm text-muted">Your next call will be saved here automatically.</p>
						)}
						{offset > 0 || list.data?.hasMore ? (
							<div className="mt-4 flex justify-between text-sm text-voice">
								<button
									type="button"
									disabled={!offset}
									onClick={() => setOffset(Math.max(0, offset - 30))}
									className="min-h-11 px-3 disabled:opacity-30"
								>
									Newer calls
								</button>
								<button
									type="button"
									disabled={!list.data?.hasMore}
									onClick={() => setOffset(offset + 30)}
									className="min-h-11 px-3 disabled:opacity-30"
								>
									Older calls
								</button>
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	)
}
