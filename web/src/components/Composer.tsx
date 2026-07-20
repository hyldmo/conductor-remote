import { ArrowUp, Info, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSendPrompt } from '../hooks.ts'
import type { ActuatorInfo } from '../lib/types.ts'
import { useApp } from '../store.ts'

// Persist an unsent prompt per workspace so a force-quit (or reload) never loses
// typing. Keyed by workspace id; cleared on send.
const DRAFT_PREFIX = 'conductor-remote-draft:'

function loadDraft(workspaceId: string): string {
	try {
		return localStorage.getItem(DRAFT_PREFIX + workspaceId) ?? ''
	} catch {
		return ''
	}
}

function saveDraft(workspaceId: string, value: string) {
	try {
		if (value) localStorage.setItem(DRAFT_PREFIX + workspaceId, value)
		else localStorage.removeItem(DRAFT_PREFIX + workspaceId)
	} catch {}
}

export function Composer({
	sessionId,
	workspaceId,
	actuator
}: {
	sessionId: string | null
	workspaceId: string
	actuator?: ActuatorInfo
}) {
	const [text, setText] = useState(() => loadDraft(workspaceId))
	const online = useApp(s => s.online)
	const sendPrompt = useSendPrompt()
	const ref = useRef<HTMLTextAreaElement>(null)

	const autosize = () => {
		const el = ref.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`
	}

	// Grow the box to fit a restored draft on mount (SessionView keys us per workspace).
	useEffect(autosize, [])

	const edit = (value: string) => {
		setText(value)
		saveDraft(workspaceId, value)
		autosize()
	}

	// Fire-and-forget: the optimistic bubble (and its inline error on failure) is the
	// feedback now, so we clear the box immediately instead of awaiting the send.
	const send = () => {
		const value = text.trim()
		if (!value || !sessionId || !online) return
		void sendPrompt({ sessionId, workspaceId, text: value })
		setText('')
		saveDraft(workspaceId, '')
		requestAnimationFrame(autosize)
	}

	const disabled = !sessionId
	const precise = actuator?.precise && actuator.available

	return (
		<div className="pb-safe border-t border-border-soft bg-bg px-3 pt-2">
			{!online ? (
				<div className="mb-2 flex items-center gap-1.5 rounded-lg bg-del/10 px-3 py-1.5 text-xs text-del">
					<WifiOff size={12} />
					Offline — drafts are saved, sending resumes when the relay is back
				</div>
			) : (
				!precise && (
					<div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-faint">
						<Info size={12} />
						{actuator?.caveat || 'Sends to the focused session'}
					</div>
				)
			)}
			<div className="flex items-end gap-2 rounded-2xl border border-border bg-surface px-2.5 py-1.5 focus-within:border-accent/60">
				<textarea
					ref={ref}
					rows={1}
					value={text}
					disabled={disabled}
					placeholder={disabled ? 'No active session' : 'Send a prompt…'}
					className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-faint disabled:opacity-50"
					onChange={e => edit(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault()
							send()
						}
					}}
				/>
				<button
					type="button"
					onClick={send}
					disabled={disabled || !text.trim() || !online}
					aria-label="Send"
					className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition active:scale-90 disabled:bg-surface-2 disabled:text-faint"
				>
					<ArrowUp size={19} />
				</button>
			</div>
		</div>
	)
}
