import { useQuery } from '@tanstack/react-query'
import { History, LoaderCircle, Mic, MicOff, PhoneCall, PhoneOff, Send, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OPENAI_REALTIME_VOICES, type OpenAIRealtimeVoice, type VoiceLanguage } from '../../../../src/shared.ts'
import { client } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { useApp } from '../../store.ts'
import { BetaBadge } from '../BetaBadge.tsx'
import { VoiceHistoryPanel } from './VoiceHistoryPanel.tsx'
import { useVoiceCall, type VoiceCallStatus } from './VoiceProvider.tsx'

const LANGUAGE_OPTIONS: [VoiceLanguage, string][] = [
	['auto', 'Auto detect'],
	['no', 'Norsk'],
	['en', 'English']
]

function voiceLabel(voice: OpenAIRealtimeVoice): string {
	return voice[0].toUpperCase() + voice.slice(1)
}

function statusLabel(status: VoiceCallStatus, muted: boolean): string {
	if (status === 'idle') return 'Not connected'
	if (status === 'connecting') return 'Connecting…'
	if (status === 'listening') return muted ? 'Microphone muted' : 'Listening'
	if (status === 'thinking') return 'Thinking…'
	if (status === 'speaking') return 'Speaking'
	return muted ? 'Microphone muted' : 'Connected'
}

/** App-wide voice switchboard. Closing this sheet never ends the call. */
export function VoiceCallSheet() {
	const voice = useVoiceCall()
	const online = useApp(state => state.online)
	const [draft, setDraft] = useState('')
	const [historyOpen, setHistoryOpen] = useState(false)
	const [selectedCallId, setSelectedCallId] = useState<string | null>(null)
	const wasActive = useRef(false)
	const transcript = useRef<HTMLDivElement>(null)
	const active = voice.status !== 'idle'
	const target = voice.target
	const canType = voice.status === 'connected'
	const transcriptRevision = `${voice.entries.length}:${voice.inputPartial}:${voice.outputPartial}`
	const recording = useQuery({
		queryKey: ['voice-recording', voice.lastCallId],
		queryFn: () => client.voiceTranscriptStatus(voice.lastCallId!),
		enabled: voice.panelOpen && active && Boolean(voice.lastCallId),
		refetchInterval: 5_000,
		retry: false
	})

	useEffect(() => {
		if (wasActive.current && !active && voice.lastCallId) {
			setSelectedCallId(voice.lastCallId)
			setHistoryOpen(true)
		}
		wasActive.current = active
	}, [active, voice.lastCallId])

	useEffect(() => {
		if (!voice.panelOpen) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') voice.closePanel()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [voice.panelOpen, voice.closePanel])

	useEffect(() => {
		if (!voice.panelOpen || !transcriptRevision) return
		const element = transcript.current
		if (element) element.scrollTop = element.scrollHeight
	}, [voice.panelOpen, transcriptRevision])

	if (!voice.panelOpen) return null

	const submit = (event: FormEvent) => {
		event.preventDefault()
		if (voice.sendText(draft)) setDraft('')
	}

	const audioNotice = voice.error?.toLowerCase().includes('audio') ?? false

	return createPortal(
		<>
			<div className="fixed inset-0 z-[60] bg-black/65 md:block" onClick={voice.closePanel} aria-hidden />
			<section
				role="dialog"
				aria-modal="true"
				aria-label={target ? 'Workspace call' : 'Control room call'}
				className="app-height fade-in pt-safe pb-safe fixed inset-0 z-[60] flex flex-col bg-bg md:inset-x-auto md:inset-y-8 md:left-1/2 md:w-[32rem] md:-translate-x-1/2 md:rounded-3xl md:border md:border-border-soft md:shadow-2xl"
			>
				<header className="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3">
					<div
						className={cn(
							'grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted',
							active && 'bg-voice-soft text-voice'
						)}
					>
						<PhoneCall size={18} />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<h2 className="truncate text-[15px] font-semibold">{target?.workspaceTitle ?? 'Control room'}</h2>
							<BetaBadge />
						</div>
						<p className="flex items-center gap-1.5 text-xs text-muted">
							{active ? (
								<span
									className={cn(
										'size-1.5 rounded-full bg-voice',
										(voice.status === 'listening' || voice.status === 'speaking') && 'animate-pulse'
									)}
								/>
							) : null}
							<span className="truncate">
								{target?.chatTitle ?? 'All workspaces'} · {statusLabel(voice.status, voice.muted)}
							</span>
						</p>
					</div>
					{!active ? (
						<button
							type="button"
							onClick={() => {
								setSelectedCallId(null)
								setHistoryOpen(true)
							}}
							aria-label="Open call history"
							className="grid size-11 shrink-0 place-items-center rounded-full text-muted active:bg-surface-2 active:text-text"
						>
							<History size={19} />
						</button>
					) : null}
					<button
						type="button"
						onClick={voice.closePanel}
						aria-label={active ? 'Hide call controls' : 'Close'}
						className="grid size-9 shrink-0 place-items-center rounded-full text-muted active:bg-surface-2 active:text-text"
					>
						<X size={19} />
					</button>
				</header>

				{active ? (
					<>
						<div ref={transcript} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
							<div className="mx-auto flex max-w-xl flex-col gap-3">
								{voice.entries.length === 0 && !voice.inputPartial && !voice.outputPartial ? (
									<div className="grid min-h-48 place-items-center text-center">
										<div>
											<LoaderCircle size={22} className="mx-auto mb-3 animate-spin text-voice" />
											<p className="text-sm text-muted">
												{target ? 'Opening your chat…' : 'Opening the fleet channel…'}
											</p>
										</div>
									</div>
								) : null}
								{voice.entries.map(entry =>
									entry.role === 'activity' ? (
										<div key={entry.id} className="flex items-center justify-center gap-2 py-1 text-xs text-voice">
											<span className="size-1.5 rounded-full bg-voice" />
											{entry.text}
										</div>
									) : (
										<div
											key={entry.id}
											className={cn(
												'max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
												entry.role === 'user'
													? 'ml-auto rounded-br-md bg-voice-soft text-text'
													: 'mr-auto rounded-bl-md bg-surface-2 text-text'
											)}
										>
											{entry.text}
										</div>
									)
								)}
								{voice.inputPartial ? (
									<div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md border border-voice/25 bg-voice-soft/60 px-3.5 py-2.5 text-sm leading-relaxed text-muted">
										{voice.inputPartial}
									</div>
								) : null}
								{voice.outputPartial ? (
									<div className="mr-auto max-w-[88%] rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-text">
										{voice.outputPartial}
										<span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-voice align-middle" />
									</div>
								) : null}
							</div>
						</div>

						<div className="shrink-0 border-t border-border-soft bg-surface/80 px-4 pb-3 pt-3 backdrop-blur-xl">
							{recording.error || recording.data?.captureError ? (
								<p role="alert" className="mb-2 text-xs text-del">
									{recording.data?.captureError ??
										'Transcript saving could not be confirmed. Check call history when the connection returns.'}
								</p>
							) : null}
							{voice.error ? (
								<button
									type="button"
									onClick={audioNotice ? voice.enableAudio : voice.dismissError}
									className="mb-2 block w-full rounded-xl bg-del/10 px-3 py-2 text-left text-xs leading-snug text-del"
								>
									{voice.error}
								</button>
							) : null}
							<form onSubmit={submit} className="flex items-center gap-2">
								<input
									value={draft}
									onChange={event => setDraft(event.target.value)}
									disabled={!canType}
									placeholder={canType ? 'Type in this call…' : statusLabel(voice.status, voice.muted)}
									aria-label="Message the orchestrator"
									className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none placeholder:text-faint focus:border-voice/60 disabled:opacity-60"
								/>
								<button
									type="submit"
									disabled={!canType || !draft.trim()}
									aria-label="Send to orchestrator"
									className="grid size-11 shrink-0 place-items-center rounded-xl bg-voice text-white active:opacity-80 disabled:bg-surface-2 disabled:text-faint"
								>
									<Send size={18} />
								</button>
							</form>
							<div className="mt-3 flex items-center justify-center gap-5">
								<button
									type="button"
									onClick={voice.toggleMute}
									disabled={voice.status === 'connecting'}
									aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
									aria-pressed={voice.muted}
									className={cn(
										'grid size-12 place-items-center rounded-full bg-surface-2 text-text active:opacity-75 disabled:text-faint',
										voice.muted && 'bg-voice-soft text-voice'
									)}
								>
									{voice.muted ? <MicOff size={20} /> : <Mic size={20} />}
								</button>
								<button
									type="button"
									onClick={voice.endCall}
									aria-label="End call"
									className="grid size-12 place-items-center rounded-full bg-del text-white active:opacity-75"
								>
									<PhoneOff size={20} />
								</button>
							</div>
						</div>
					</>
				) : historyOpen ? (
					<VoiceHistoryPanel
						selectedId={selectedCallId}
						onSelect={setSelectedCallId}
						onBack={() => setHistoryOpen(false)}
					/>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-7">
						<div className="mx-auto flex max-w-sm flex-col items-center text-center">
							<div className="mb-5 grid size-16 place-items-center rounded-full bg-voice-soft text-voice">
								<PhoneCall size={27} />
							</div>
							<h3 className="text-xl font-semibold tracking-tight">
								{target ? 'Call this workspace' : 'Call your fleet'}
							</h3>
							<p className="mt-2 text-sm leading-relaxed text-muted">
								{target
									? `Continue from “${target.chatTitle}” with its recent conversation already in context. You can discuss the task and confirm a prompt to send back to this chat.`
									: 'Start a fresh conversation. Ask about your workspaces or recall a previous call, including one that dropped. Creating workspaces and sending prompts still require your confirmation.'}
							</p>

							<div className="mt-7 grid w-full grid-cols-2 gap-3 text-left">
								<label className="text-xs font-medium text-muted">
									Voice
									<select
										value={voice.preferences.voice}
										onChange={event => voice.setVoice(event.target.value as OpenAIRealtimeVoice)}
										className="mt-1.5 block h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-text [color-scheme:dark]"
									>
										{OPENAI_REALTIME_VOICES.map(value => (
											<option key={value} value={value}>
												{voiceLabel(value)}
											</option>
										))}
									</select>
								</label>
								<label className="text-xs font-medium text-muted">
									Language
									<select
										value={voice.preferences.language}
										onChange={event => voice.setLanguage(event.target.value as VoiceLanguage)}
										className="mt-1.5 block h-11 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-text [color-scheme:dark]"
									>
										{LANGUAGE_OPTIONS.map(([value, label]) => (
											<option key={value} value={value}>
												{label}
											</option>
										))}
									</select>
								</label>
							</div>

							{voice.error ? (
								<button
									type="button"
									onClick={voice.dismissError}
									className="mt-4 block w-full rounded-xl bg-del/10 px-3 py-2 text-left text-xs leading-snug text-del"
								>
									{voice.error}
								</button>
							) : null}

							<button
								type="button"
								onClick={() => void voice.startCall()}
								disabled={!online}
								className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-voice px-4 text-sm font-semibold text-white active:opacity-80 disabled:bg-surface-2 disabled:text-faint"
							>
								<PhoneCall size={18} />
								{online ? (target ? 'Start workspace call' : 'Start fleet call') : 'Relay offline'}
							</button>
							<p className="mt-3 text-[11px] leading-snug text-faint">
								{target
									? 'AI-generated voice. Audio and this chat’s recent messages are sent to OpenAI for this live call.'
									: 'AI-generated voice. Microphone audio is sent to OpenAI for this live call.'}{' '}
								Transcripts are saved on your Mac.
							</p>
						</div>
					</div>
				)}
			</section>
		</>,
		document.body
	)
}
