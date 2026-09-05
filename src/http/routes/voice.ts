import { isRoute, routeParam, routes } from '../../routes.ts'

import {
	isOpenAIRealtimeVoice,
	isVoiceLanguage,
	isVoiceSpeed,
	OPENAI_REALTIME_VOICES,
	type OpenAIRealtimeVoice,
	type VoiceLanguage
} from '../../shared.ts'

import { openAIOriginForSipHost } from '../../voice/config.ts'

import { parseVoiceCallTarget, readVoiceChatContext, VoiceContextError } from '../../voice/context.ts'
import { parseVoiceDiagnostics } from '../../voice/diagnostic-fields.ts'
import { MAX_VOICE_SEARCH_CHARS } from '../../voice/history.ts'

import { mintSipTicket, missingTicketConfig } from '../../voice/ticket.ts'

import { createWebRtcCall, MAX_SDP_CHARS } from '../../voice/webrtc.ts'
import { NOT_HANDLED, type RouteHandler } from '../router-types.ts'
import type { RelayServices } from '../services.ts'

export function createVoiceRoutes(
	services: Pick<
		RelayServices,
		'json' | 'voiceHistory' | 'voiceConfig' | 'voiceBroker' | 'readBody' | 'reads' | 'voiceSafetyIdentifier'
	>
): RouteHandler {
	const { json, voiceHistory, voiceConfig, voiceBroker, readBody, reads, voiceSafetyIdentifier } = services
	return async (req, res, url) => {
		const { pathname } = url

		const diagnosticCall = routeParam(routes.voiceCallDiagnostics, req.method, pathname)
		if (diagnosticCall) {
			if (!voiceHistory.status(diagnosticCall)) return json(req, res, 404, { error: 'Saved voice call not found' })
			const raw = await readBody(req)
			if (raw.length > 32_000) return json(req, res, 413, { error: 'Voice diagnostic batch is too large' })
			let events: ReturnType<typeof parseVoiceDiagnostics> = null
			try {
				events = parseVoiceDiagnostics(JSON.parse(raw))
			} catch {}
			if (!events) return json(req, res, 400, { error: 'Invalid voice diagnostic batch' })
			// Keep each entry below the log ring's per-line cap, even after an offline batch.
			const receivedAt = Date.now()
			for (const event of events)
				console.info(
					`[voice-diagnostics] ${JSON.stringify({ callId: diagnosticCall, source: 'browser', receivedAt, ...event })}`
				)
			return json(req, res, 200, { ok: true })
		}

		const voiceTranscript = routeParam(routes.voiceTranscript, req.method, pathname)

		if (
			isRoute(routes.voiceHistory, req.method, pathname) ||
			isRoute(routes.voiceSearch, req.method, pathname) ||
			voiceTranscript
		) {
			try {
				if (isRoute(routes.voiceSearch, req.method, pathname)) {
					const query = url.searchParams.get('q')?.trim() ?? ''
					if (!query || query.length > MAX_VOICE_SEARCH_CHARS)
						return json(req, res, 400, { error: `q must contain 1–${MAX_VOICE_SEARCH_CHARS} characters` })
					return json(
						req,
						res,
						200,
						voiceHistory.search(query, {
							limit: Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 12)),
							offset: Math.max(0, Math.min(1_000_000, Number(url.searchParams.get('offset')) || 0)),
							callId: url.searchParams.get('callId') || undefined
						})
					)
				}
				if (!voiceTranscript) {
					const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 30))
					const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get('offset')) || 0))
					return json(req, res, 200, voiceHistory.list(Math.floor(limit), Math.floor(offset)))
				}
				const call =
					url.searchParams.get('summary') === '1'
						? voiceHistory.status(voiceTranscript)
						: voiceHistory.read(voiceTranscript)
				return call ? json(req, res, 200, call) : json(req, res, 404, { error: 'Saved voice call not found' })
			} catch (error) {
				console.warn('[voice] could not read call history:', error)
				return json(req, res, 503, { error: 'Call history is unavailable. Check the relay logs.' })
			}
		}

		// POST /api/voice/ticket — the native app presents the same relay bearer as
		// the PWA, and receives only a two-minute SIP URI. The OpenAI key, webhook
		// secret and marker key never leave this Mac.
		if (isRoute(routes.voiceTicket, req.method, pathname)) {
			const missing = missingTicketConfig(voiceConfig)
			if (missing.length || !voiceBroker) {
				return json(req, res, 503, {
					error: 'voice calls are not fully configured on this relay',
					missing
				})
			}
			return json(req, res, 200, mintSipTicket(voiceConfig))
		}

		// POST /api/voice/calls — the PWA sends its SDP offer to this authenticated
		// relay. The relay loads the selected chat context or the fleet session and
		// keeps OpenAI's permanent key and every function tool on the Mac.
		if (isRoute(routes.voiceCall, req.method, pathname)) {
			if (!voiceConfig.openaiKey || !voiceBroker)
				return json(req, res, 503, { error: 'voice needs an OpenAI API key on this relay' })
			const raw = await readBody(req)
			if (raw.length > MAX_SDP_CHARS * 2) return json(req, res, 413, { error: 'WebRTC offer is too large' })
			const body = JSON.parse(raw || '{}') as {
				sdp?: unknown
				voice?: unknown
				language?: unknown
				target?: unknown
				speed?: unknown
			}
			if (typeof body.sdp !== 'string' || !body.sdp.trim())
				return json(req, res, 400, { error: 'WebRTC offer is required' })
			if (body.sdp.length > MAX_SDP_CHARS) return json(req, res, 413, { error: 'WebRTC offer is too large' })
			if (!isOpenAIRealtimeVoice(body.voice))
				return json(req, res, 400, { error: `voice must be one of ${OPENAI_REALTIME_VOICES.join(', ')}` })
			if (!isVoiceLanguage(body.language)) return json(req, res, 400, { error: 'unsupported voice language' })
			if (body.speed !== undefined && !isVoiceSpeed(body.speed))
				return json(req, res, 400, { error: 'speed must be a number from 0.25 to 1.5' })
			try {
				const target = parseVoiceCallTarget(body.target)
				const context = target ? readVoiceChatContext(reads, target) : undefined
				const call = await createWebRtcCall(
					voiceConfig.openaiKey,
					openAIOriginForSipHost(voiceConfig.sipHost),
					body.sdp,
					{
						model: voiceConfig.model,
						reasoningEffort: voiceConfig.reasoningEffort,
						voice: body.voice as OpenAIRealtimeVoice,
						speed: body.speed ?? voiceConfig.speed,
						language: body.language as VoiceLanguage,
						context
					},
					voiceSafetyIdentifier
				)
				voiceBroker.registerWebRtc(call.callId, { voice: body.voice, language: body.language })
				return json(req, res, 200, call)
			} catch (err) {
				if (err instanceof VoiceContextError) return json(req, res, err.status, { error: err.message })
				console.warn('[voice] could not create WebRTC orchestrator call:', err)
				return json(req, res, 502, { error: err instanceof Error ? err.message : 'voice call failed' })
			}
		}

		const readyVoiceCall = routeParam(routes.voiceCallReady, req.method, pathname)

		if (readyVoiceCall) {
			if (!voiceBroker) return json(req, res, 503, { error: 'voice is not configured on this relay' })
			if (!voiceBroker.beginWebRtc(readyVoiceCall)) return json(req, res, 404, { error: 'voice call not found' })
			return json(req, res, 200, { ok: true })
		}

		const endedVoiceCall = routeParam(routes.voiceCallEnd, req.method, pathname)

		if (endedVoiceCall) {
			if (!voiceBroker) return json(req, res, 503, { error: 'voice is not configured on this relay' })
			try {
				if (!(await voiceBroker.hangupWebRtc(endedVoiceCall)))
					return json(req, res, 404, { error: 'voice call not found' })
				return json(req, res, 200, { ok: true })
			} catch (err) {
				console.warn('[voice] could not hang up WebRTC orchestrator call:', err)
				return json(req, res, 502, { error: err instanceof Error ? err.message : 'voice hangup failed' })
			}
		}
		return NOT_HANDLED
	}
}
