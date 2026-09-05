import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { VoicePreview } from '../../../../src/voice/preview.ts'
import { client } from '../../lib/api.ts'

export function VoiceDraftCard({
	draft,
	active,
	handsFree,
	refresh,
	onOpen
}: {
	draft: VoicePreview
	active: boolean
	handsFree: boolean
	refresh: () => void
	onOpen?: () => void
}) {
	const ref = useRef<HTMLElement>(null)
	const [editing, setEditing] = useState(draft.reviewPaused === true)
	const original = draft.kind === 'send_prompt' ? draft.text : draft.prompt
	const [text, setText] = useState(original)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const ready = draft.status === 'ready'
	const [expired, setExpired] = useState(() => Date.now() > draft.expiresAt)
	useEffect(() => {
		const timer = setTimeout(() => setExpired(true), Math.max(0, draft.expiresAt - Date.now() + 1))
		return () => clearTimeout(timer)
	}, [draft.expiresAt])
	const workspaceId = draft.outcome?.workspaceId ?? (draft.kind === 'send_prompt' ? draft.workspaceId : undefined)
	const state = draft.outcome?.state
	const label =
		draft.status === 'superseded'
			? 'Replaced draft'
			: state === 'completed'
				? draft.kind === 'send_prompt'
					? 'Sent'
					: 'Created'
				: state === 'running'
					? 'In progress'
					: state === 'parked'
						? 'Handed to unlock queue'
						: state === 'failed'
							? 'Failed'
							: state === 'unknown'
								? 'Outcome unknown'
								: expired
									? 'Approval expired'
									: 'Draft for review'
	useEffect(() => {
		if (active && ready) ref.current?.scrollIntoView({ block: 'nearest' })
	}, [active, ready])

	useEffect(() => {
		if (!active || handsFree || !ready || draft.presented || !ref.current) return
		let visible = false
		let sending = false
		const acknowledge = () => {
			if (!visible || document.visibilityState !== 'visible' || sending) return
			sending = true
			void client
				.voiceDraftAction(draft.callId, draft.token, 'present')
				.then(refresh)
				.catch(() => {
					sending = false
				})
		}
		const observer = new IntersectionObserver(entries => {
			visible = entries.some(entry => entry.isIntersecting)
			acknowledge()
		})
		observer.observe(ref.current)
		document.addEventListener('visibilitychange', acknowledge)
		return () => {
			observer.disconnect()
			document.removeEventListener('visibilitychange', acknowledge)
		}
	}, [active, handsFree, ready, draft.callId, draft.token, draft.presented, refresh])

	const act = async (action: 'edit' | 'approve' | 'pause' | 'resume') => {
		setBusy(true)
		setError(null)
		try {
			await client.voiceDraftAction(draft.callId, draft.token, action, action === 'edit' ? text : undefined)
			setEditing(action === 'pause')
			if (action === 'resume') setText(original)
			refresh()
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}
	const button = 'min-h-10 rounded-lg bg-surface-2 px-3 text-xs font-medium disabled:opacity-50'
	return (
		<article ref={ref} aria-label={label} className="rounded-2xl border border-voice/30 bg-voice-soft/20 p-4">
			<p className="text-xs font-semibold text-voice" role="status">
				{label}
			</p>
			<h3 className="mt-1 break-words text-sm font-semibold">
				{draft.kind === 'create_workspace' ? `New workspace · ${draft.repo}` : (draft.targetLabel ?? 'Chat prompt')}
			</h3>
			{editing ? (
				<textarea
					aria-label="Edit draft"
					value={text}
					onChange={event => setText(event.target.value)}
					className="mt-3 min-h-40 w-full rounded-lg bg-bg p-3 text-sm"
				/>
			) : (
				<p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{original || 'No first prompt'}</p>
			)}
			{draft.outcome?.message ? <p className="mt-2 text-xs text-muted">{draft.outcome.message}</p> : null}
			{error ? (
				<p role="alert" className="mt-2 text-xs text-del">
					{error}
				</p>
			) : null}
			<div className="mt-3 flex flex-wrap gap-2">
				{active && ready ? (
					editing ? (
						<>
							<button
								type="button"
								className={button}
								disabled={busy || (draft.kind === 'send_prompt' && !text.trim())}
								onClick={() => void act('edit')}
							>
								Save draft
							</button>
							<button type="button" className={button} disabled={busy} onClick={() => void act('resume')}>
								Cancel edit
							</button>
						</>
					) : (
						<>
							<button type="button" className={button} disabled={busy} onClick={() => void act('pause')}>
								Edit
							</button>
							<button
								type="button"
								className={button}
								disabled={busy}
								onClick={() => void act(expired ? 'edit' : 'approve')}
							>
								{expired ? 'Renew approval' : draft.kind === 'send_prompt' ? 'Send' : 'Create workspace'}
							</button>
						</>
					)
				) : null}
				{workspaceId ? (
					<Link
						className={`${button} inline-flex items-center text-voice`}
						to={`/w/${encodeURIComponent(workspaceId)}${draft.kind === 'send_prompt' ? `?session=${encodeURIComponent(draft.sessionId)}` : ''}`}
						onClick={onOpen}
					>
						Open {draft.kind === 'send_prompt' ? 'chat' : 'workspace'}
					</Link>
				) : null}
			</div>
		</article>
	)
}

/** Receipts keep polling after hang-up; speech is not their source of truth. */
export function VoiceDraftCards({
	callId,
	active = false,
	handsFree = true,
	onOpen
}: {
	callId: string
	active?: boolean
	handsFree?: boolean
	onOpen?: () => void
}) {
	const query = useQuery({
		queryKey: ['voice-drafts', callId],
		queryFn: () => client.voiceDrafts(callId),
		refetchInterval: query =>
			active ? 750 : query.state.data?.drafts.some(draft => draft.outcome?.state === 'running') ? 2_000 : false
	})
	return (
		<div className="flex flex-col gap-3">
			{query.error ? (
				<p role="alert" className="text-xs text-del">
					Drafts and action receipts are temporarily unavailable.
				</p>
			) : null}
			{query.data?.drafts
				.filter(draft => draft.status !== 'superseded')
				.map(draft => (
					<VoiceDraftCard
						key={draft.token}
						draft={draft}
						active={active}
						handsFree={handsFree}
						refresh={query.refetch}
						onOpen={onOpen}
					/>
				))}
		</div>
	)
}
