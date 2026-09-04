/** Signature-gated Twilio and OpenAI route handlers for the public voice listener. */
import crypto from 'node:crypto'
import type http from 'node:http'
import type { RpcRequest } from '../mcp-tools.ts'
import type { VoiceConfig } from './config.ts'
import type { VoiceReply, VoiceRoutes } from './server.ts'
import {
	callerAllowed,
	mintMarker,
	parseForm,
	twimlDialSip,
	twimlGatherPin,
	twimlReject,
	verifyMarker,
	verifyTwilioSignature
} from './twiml.ts'
import { parseIncomingCall, ReplayGuard, sipHeader, verifyWebhookSignature } from './webhook.ts'

interface CallBroker {
	accept(callId: string): Promise<void>
	reject(callId: string, statusCode?: number): Promise<void>
}

interface GatewayDeps {
	config: () => VoiceConfig
	broker: () => CallBroker | null
	rpc: (callId: string, request: RpcRequest) => Promise<unknown | null>
	replay?: ReplayGuard
	now?: () => number
	log?: (line: string) => void
}

function header(headers: http.IncomingHttpHeaders, name: string): string | null {
	const raw = headers[name.toLowerCase()]
	return Array.isArray(raw) ? (raw[0] ?? null) : typeof raw === 'string' ? raw : null
}

function fixedEqual(left: string, right: string): boolean {
	const a = crypto.createHash('sha256').update(left).digest()
	const b = crypto.createHash('sha256').update(right).digest()
	return crypto.timingSafeEqual(a, b)
}

const xml = (status: number, body: string): VoiceReply => ({ status, body, contentType: 'text/xml; charset=utf-8' })

export function createVoiceGateway(deps: GatewayDeps): VoiceRoutes {
	const replay = deps.replay ?? new ReplayGuard()
	const now = deps.now ?? Date.now
	const log = deps.log ?? console.warn
	return {
		async twiml(body, headers) {
			const config = deps.config()
			if (!config.twilioAuthToken || !config.publicBaseUrl) return xml(503, twimlReject())
			const params = parseForm(body)
			const publicUrl = `${config.publicBaseUrl}/twiml`
			const signature = verifyTwilioSignature(
				publicUrl,
				params,
				config.twilioAuthToken,
				header(headers, 'x-twilio-signature')
			)
			if (!signature.ok || !callerAllowed(params.From, config.allowedCallers)) {
				log(`[voice] Twilio call refused: ${signature.ok ? 'caller not allowlisted' : signature.reason}`)
				return xml(403, twimlReject())
			}
			if (!config.pin || !config.projectId) return xml(503, twimlReject())
			if (!params.Digits) return xml(200, twimlGatherPin(publicUrl, config.pin.length))
			if (!fixedEqual(params.Digits, config.pin)) return xml(403, twimlReject())
			return xml(200, twimlDialSip(config.projectId, mintMarker(config.trunkSecret, now()), config.sipHost))
		},

		async webhook(body, headers) {
			const config = deps.config()
			if (!config.webhookSecret || !config.openaiKey) return { status: 503, body: 'voice is not configured' }
			const signature = verifyWebhookSignature(body, headers, config.webhookSecret, now())
			if (!signature.ok) {
				log(`[voice] OpenAI webhook refused: ${signature.reason}`)
				return { status: 400, body: 'invalid webhook' }
			}
			const webhookId = header(headers, 'webhook-id')
			if (!webhookId || !replay.accept(webhookId, now())) return { status: 409, body: 'duplicate webhook' }
			const call = parseIncomingCall(body)
			if (!call) return { status: 400, body: 'unexpected event' }
			const broker = deps.broker()
			if (!broker) return { status: 503, body: 'voice broker is not configured' }
			const marker = verifyMarker(sipHeader(call.sipHeaders, 'x-relay-call'), config.trunkSecret, now())
			try {
				if (!marker.ok) {
					log(`[voice] ${call.callId} rejected: ${marker.reason}`)
					await broker.reject(call.callId)
					return { status: 200, body: 'rejected' }
				}
				await broker.accept(call.callId)
				return { status: 200, body: 'accepted' }
			} catch (error) {
				// A non-2xx webhook response asks OpenAI to retry. Do not let our replay guard
				// turn that legitimate retry into a duplicate after the API call failed.
				replay.forget(webhookId)
				throw error
			}
		},

		async rpc(message, headers) {
			const callId = header(headers, 'x-voice-call-id')
			if (!callId) {
				const candidate = message as { id?: unknown }
				const id =
					typeof candidate?.id === 'string' || typeof candidate?.id === 'number' || candidate?.id === null
						? candidate.id
						: null
				return { jsonrpc: '2.0', id, error: { code: -32600, message: 'missing voice call id' } }
			}
			return deps.rpc(callId, message as RpcRequest)
		}
	}
}
