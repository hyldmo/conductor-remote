import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isVoiceSpeed, type OpenAIRealtimeVoice, type VoiceLanguage } from '../../../../src/shared.ts'
import { client } from '../../lib/api.ts'
import {
	loadVoicePreferences,
	parseVoiceEvent,
	saveVoicePreferences,
	type VoicePreferences,
	voiceToolLabel,
	type WorkspaceVoiceTarget
} from '../../lib/voice/connection.ts'

export type VoiceCallStatus = 'idle' | 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking'
export type VoiceCallRole = 'user' | 'assistant' | 'activity'

export interface VoiceCallEntry {
	id: string
	role: VoiceCallRole
	text: string
}

interface VoiceContextValue {
	panelOpen: boolean
	status: VoiceCallStatus
	muted: boolean
	error: string | null
	entries: VoiceCallEntry[]
	/** Kept after hang-up so the sheet can open the saved call. */
	lastCallId: string | null
	inputPartial: string
	outputPartial: string
	preferences: VoicePreferences
	target: WorkspaceVoiceTarget | null
	openPanel: () => void
	openWorkspacePanel: (target: WorkspaceVoiceTarget) => void
	closePanel: () => void
	startCall: () => Promise<void>
	endCall: () => void
	toggleMute: () => void
	sendText: (text: string) => boolean
	dismissError: () => void
	enableAudio: () => void
	setVoice: (voice: OpenAIRealtimeVoice) => void
	setLanguage: (language: VoiceLanguage) => void
	setSpeed: (speed: number) => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

function joined(parts: ReadonlyMap<string, string>): string {
	return [...parts.values()].join(' ').trimStart()
}

function deniedMicrophone(error: unknown): boolean {
	return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
}

/** One call whose selected context survives navigation between workspaces and chats. */
export function VoiceCallProvider({ children }: { children: ReactNode }) {
	const [panelOpen, setPanelOpen] = useState(false)
	const [status, setStatusState] = useState<VoiceCallStatus>('idle')
	const [muted, setMuted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [entries, setEntries] = useState<VoiceCallEntry[]>([])
	const [lastCallId, setLastCallId] = useState<string | null>(null)
	const [inputPartial, setInputPartial] = useState('')
	const [outputPartial, setOutputPartial] = useState('')
	const [preferences, setPreferencesState] = useState(loadVoicePreferences)
	const [target, setTarget] = useState<WorkspaceVoiceTarget | null>(null)
	const statusRef = useRef<VoiceCallStatus>('idle')
	const preferencesRef = useRef(preferences)
	const targetRef = useRef(target)
	const generation = useRef(0)
	const peer = useRef<RTCPeerConnection | null>(null)
	const channel = useRef<RTCDataChannel | null>(null)
	const stream = useRef<MediaStream | null>(null)
	const microphone = useRef<MediaStreamTrack | null>(null)
	const remoteAudio = useRef<HTMLAudioElement | null>(null)
	const callId = useRef<string | null>(null)
	const inputParts = useRef(new Map<string, string>())
	const outputParts = useRef(new Map<string, string>())
	const completedInputs = useRef(new Set<string>())
	const completedOutputs = useRef(new Set<string>())
	const seenTools = useRef(new Set<string>())
	const playing = useRef(false)
	const responding = useRef(false)
	const speaking = useRef(false)
	const interruptedOutputs = useRef(new Set<string>())
	const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	preferencesRef.current = preferences

	const setStatus = useCallback((next: VoiceCallStatus) => {
		statusRef.current = next
		setStatusState(next)
	}, [])

	const append = useCallback((entry: VoiceCallEntry) => {
		setEntries(current => (current.some(candidate => candidate.id === entry.id) ? current : [...current, entry]))
	}, [])

	const clearPartials = useCallback(() => {
		inputParts.current.clear()
		outputParts.current.clear()
		setInputPartial('')
		setOutputPartial('')
	}, [])

	const closeLocal = useCallback(() => {
		generation.current += 1
		playing.current = false
		responding.current = false
		speaking.current = false
		if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
		disconnectTimer.current = null
		try {
			channel.current?.close()
		} catch {}
		try {
			peer.current?.close()
		} catch {}
		for (const track of stream.current?.getTracks() ?? []) track.stop()
		if (remoteAudio.current) remoteAudio.current.srcObject = null
		peer.current = null
		channel.current = null
		stream.current = null
		microphone.current = null
		remoteAudio.current = null
		callId.current = null
		clearPartials()
	}, [clearPartials])

	const failCall = useCallback(
		(message: string) => {
			const activeCallId = callId.current
			closeLocal()
			setMuted(false)
			setStatus('idle')
			setError(message)
			if (activeCallId) void client.voiceCallEnd(activeCallId).catch(() => undefined)
		},
		[closeLocal, setStatus]
	)

	const handleEvent = useCallback(
		(raw: unknown) => {
			const event = parseVoiceEvent(raw)
			if (!event) return
			switch (event.kind) {
				case 'input-delta':
					inputParts.current.set(event.itemId, (inputParts.current.get(event.itemId) ?? '') + event.text)
					setInputPartial(joined(inputParts.current))
					return
				case 'input-done': {
					inputParts.current.delete(event.itemId)
					setInputPartial(joined(inputParts.current))
					if (!completedInputs.current.has(event.itemId) && event.text.trim()) {
						completedInputs.current.add(event.itemId)
						append({ id: `user:${event.itemId}`, role: 'user', text: event.text.trim() })
					}
					// Transcription can arrive after playback; captions do not own call state.
					return
				}
				case 'output-delta':
					if (interruptedOutputs.current.has(event.itemId)) return
					outputParts.current.set(event.itemId, (outputParts.current.get(event.itemId) ?? '') + event.text)
					setOutputPartial(joined(outputParts.current))
					return
				case 'output-done': {
					if (interruptedOutputs.current.has(event.itemId)) return
					const assembled = (event.text || outputParts.current.get(event.itemId) || '').trim()
					outputParts.current.delete(event.itemId)
					setOutputPartial(joined(outputParts.current))
					if (!completedOutputs.current.has(event.itemId) && assembled) {
						completedOutputs.current.add(event.itemId)
						append({ id: `assistant:${event.itemId}`, role: 'assistant', text: assembled })
					}
					return
				}
				case 'tool':
					if (!seenTools.current.has(event.itemId)) {
						seenTools.current.add(event.itemId)
						append({ id: `tool:${event.itemId}`, role: 'activity', text: voiceToolLabel(event.name) })
					}
					if (!speaking.current && !playing.current) setStatus('thinking')
					return
				case 'speech-started':
					speaking.current = true
					for (const id of outputParts.current.keys()) interruptedOutputs.current.add(id)
					outputParts.current.clear()
					setOutputPartial('')
					setStatus('listening')
					return
				case 'speech-stopped':
					speaking.current = false
					setStatus('thinking')
					return
				case 'playback-started':
					playing.current = true
					if (!speaking.current) setStatus('speaking')
					return
				case 'playback-cleared':
				case 'playback-stopped':
					playing.current = false
					if (!speaking.current) setStatus(responding.current ? 'thinking' : 'connected')
					return
				case 'truncated':
					interruptedOutputs.current.add(event.itemId)
					outputParts.current.delete(event.itemId)
					setOutputPartial(joined(outputParts.current))
					setEntries(current =>
						current.map(entry =>
							entry.id === `assistant:${event.itemId}` ? { ...entry, text: 'Reply interrupted.' } : entry
						)
					)
					return
				case 'response-started':
					responding.current = true
					if (!speaking.current && !playing.current) setStatus('thinking')
					return
				case 'response-done':
					responding.current = false
					if (event.error) {
						setError(event.error)
						append({ id: `failure:${crypto.randomUUID()}`, role: 'activity', text: event.error })
					}
					setStatus(speaking.current ? 'listening' : playing.current ? 'speaking' : 'connected')
					return
				case 'error':
					setError(event.text)
					if (statusRef.current !== 'idle') setStatus('connected')
			}
		},
		[append, setStatus]
	)

	const startCall = useCallback(async () => {
		if (statusRef.current !== 'idle') return
		const selected = targetRef.current
		if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
			setError('This browser does not support WebRTC calling')
			return
		}
		setPanelOpen(true)
		setError(null)
		setEntries([])
		setLastCallId(null)
		clearPartials()
		completedInputs.current.clear()
		completedOutputs.current.clear()
		seenTools.current.clear()
		interruptedOutputs.current.clear()
		setMuted(false)
		setStatus('connecting')
		const currentGeneration = ++generation.current
		try {
			const media = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			})
			if (currentGeneration !== generation.current) {
				for (const track of media.getTracks()) track.stop()
				return
			}
			const track = media.getAudioTracks()[0]
			if (!track) throw new Error('No microphone was available')
			// Do not let a turn begin before captions and the relay sideband are ready.
			track.enabled = false
			stream.current = media
			microphone.current = track

			const pc = new RTCPeerConnection()
			const dc = pc.createDataChannel('oai-events')
			const audio = document.createElement('audio')
			audio.autoplay = true
			audio.setAttribute('playsinline', '')
			peer.current = pc
			channel.current = dc
			remoteAudio.current = audio
			pc.addTrack(track, media)
			pc.addEventListener('track', event => {
				if (currentGeneration !== generation.current) return
				audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
				void audio.play().catch(() => setError('Tap the audio notice to hear this call'))
			})
			dc.addEventListener('message', event => {
				if (currentGeneration === generation.current) handleEvent(event.data)
			})
			dc.addEventListener('close', () => {
				if (currentGeneration === generation.current && statusRef.current !== 'idle') failCall('The call closed')
			})
			pc.addEventListener('connectionstatechange', () => {
				if (currentGeneration !== generation.current) return
				if (pc.connectionState === 'connected' && disconnectTimer.current) {
					clearTimeout(disconnectTimer.current)
					disconnectTimer.current = null
				}
				if (pc.connectionState === 'failed' || pc.connectionState === 'closed')
					return failCall('The call connection failed')
				if (pc.connectionState === 'disconnected' && !disconnectTimer.current) {
					disconnectTimer.current = setTimeout(() => {
						disconnectTimer.current = null
						if (currentGeneration === generation.current && pc.connectionState === 'disconnected')
							failCall('The call connection was lost')
					}, 4_000)
				}
			})

			const offer = await pc.createOffer()
			await pc.setLocalDescription(offer)
			const localSdp = pc.localDescription?.sdp
			if (!localSdp) throw new Error('The browser did not create a WebRTC offer')
			if (currentGeneration !== generation.current) return
			const answer = await client.voiceCall(
				localSdp,
				preferencesRef.current.voice,
				preferencesRef.current.language,
				selected ? { workspaceId: selected.workspaceId, sessionId: selected.sessionId } : undefined,
				preferencesRef.current.speed
			)
			if (currentGeneration !== generation.current) {
				void client.voiceCallEnd(answer.callId).catch(() => undefined)
				return
			}
			callId.current = answer.callId
			setLastCallId(answer.callId)
			await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
			await new Promise<void>((resolve, reject) => {
				if (dc.readyState === 'open') return resolve()
				const timeout = setTimeout(() => reject(new Error('Voice event channel did not open')), 8_000)
				dc.addEventListener(
					'open',
					() => {
						clearTimeout(timeout)
						resolve()
					},
					{ once: true }
				)
			})
			await client.voiceCallReady(answer.callId)
			if (currentGeneration !== generation.current) return
			track.enabled = true
			const afterReady = statusRef.current as VoiceCallStatus
			if (afterReady === 'connecting') setStatus('connected')
		} catch (cause) {
			if (currentGeneration !== generation.current) return
			failCall(
				deniedMicrophone(cause)
					? 'Microphone access was denied — allow it in this site’s settings and try again'
					: cause instanceof Error
						? cause.message
						: String(cause)
			)
		}
	}, [clearPartials, failCall, handleEvent, setStatus])

	const endCall = useCallback(() => {
		const activeCallId = callId.current
		closeLocal()
		setMuted(false)
		setStatus('idle')
		setError(null)
		if (activeCallId) void client.voiceCallEnd(activeCallId).catch(() => undefined)
	}, [closeLocal, setStatus])

	const toggleMute = useCallback(() => {
		if (statusRef.current === 'idle' || statusRef.current === 'connecting') return
		setMuted(current => {
			const next = !current
			if (microphone.current) microphone.current.enabled = !next
			return next
		})
	}, [])

	const sendText = useCallback(
		(text: string): boolean => {
			const spoken = text.trim()
			const dc = channel.current
			if (
				!spoken ||
				dc?.readyState !== 'open' ||
				!callId.current ||
				statusRef.current === 'idle' ||
				statusRef.current === 'connecting'
			)
				return false
			const id = crypto.randomUUID()
			append({ id: `typed:${id}`, role: 'user', text: spoken })
			for (const id of outputParts.current.keys()) interruptedOutputs.current.add(id)
			outputParts.current.clear()
			setOutputPartial('')
			void client
				.voiceCallText(callId.current, spoken)
				.catch(error =>
					setError(`Typed message was not confirmed: ${error instanceof Error ? error.message : String(error)}`)
				)
			setStatus('thinking')
			return true
		},
		[append, setStatus]
	)

	const updatePreferences = useCallback((patch: Partial<VoicePreferences>) => {
		if (statusRef.current !== 'idle') return
		setPreferencesState(current => {
			const next = { ...current, ...patch }
			preferencesRef.current = next
			saveVoicePreferences(next)
			return next
		})
	}, [])

	const enableAudio = useCallback(() => {
		void remoteAudio.current
			?.play()
			.then(() => setError(null))
			.catch(() => setError('This browser is still blocking call audio'))
	}, [])
	const openPanel = useCallback(() => {
		if (statusRef.current === 'idle') {
			targetRef.current = null
			setTarget(null)
			setError(null)
		}
		setPanelOpen(true)
	}, [])
	const openWorkspacePanel = useCallback((selected: WorkspaceVoiceTarget) => {
		if (statusRef.current === 'idle') {
			targetRef.current = { ...selected }
			setTarget(targetRef.current)
			setError(null)
		}
		setPanelOpen(true)
	}, [])
	const closePanel = useCallback(() => setPanelOpen(false), [])
	const dismissError = useCallback(() => setError(null), [])
	const setVoice = useCallback((voice: OpenAIRealtimeVoice) => updatePreferences({ voice }), [updatePreferences])
	const setLanguage = useCallback((language: VoiceLanguage) => updatePreferences({ language }), [updatePreferences])
	const setSpeed = useCallback(
		(speed: number) => {
			if (isVoiceSpeed(speed)) updatePreferences({ speed })
		},
		[updatePreferences]
	)

	const active = status !== 'idle' && status !== 'connecting'
	useEffect(() => {
		if (!active || !lastCallId) return
		let disposed = false
		const check = async () => {
			try {
				const saved = await client.voiceTranscriptStatus(lastCallId)
				if (!disposed && saved.status !== 'active')
					failCall('The relay’s voice connection was lost. Check the saved action receipts before retrying.')
			} catch {
				if (!disposed) setError('The relay connection could not be checked. Action receipts may be delayed.')
			}
		}
		const timer = setInterval(() => void check(), 5_000)
		return () => {
			disposed = true
			clearInterval(timer)
		}
	}, [active, lastCallId, failCall])

	useEffect(
		() => () => {
			const activeCallId = callId.current
			closeLocal()
			if (activeCallId) void client.voiceCallEnd(activeCallId).catch(() => undefined)
		},
		[closeLocal]
	)

	const value = useMemo<VoiceContextValue>(
		() => ({
			panelOpen,
			status,
			muted,
			error,
			entries,
			lastCallId,
			inputPartial,
			outputPartial,
			preferences,
			target,
			openPanel,
			openWorkspacePanel,
			closePanel,
			startCall,
			endCall,
			toggleMute,
			sendText,
			dismissError,
			enableAudio,
			setVoice,
			setLanguage,
			setSpeed
		}),
		[
			panelOpen,
			status,
			muted,
			error,
			entries,
			lastCallId,
			inputPartial,
			outputPartial,
			preferences,
			target,
			openPanel,
			openWorkspacePanel,
			closePanel,
			startCall,
			endCall,
			toggleMute,
			sendText,
			dismissError,
			enableAudio,
			setVoice,
			setLanguage,
			setSpeed
		]
	)

	return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoiceCall(): VoiceContextValue {
	const value = useContext(VoiceContext)
	if (!value) throw new Error('useVoiceCall must be used inside VoiceCallProvider')
	return value
}
