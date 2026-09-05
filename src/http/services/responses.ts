import crypto from 'node:crypto'

import type http from 'node:http'

import zlib from 'node:zlib'

import { scrubWorkflowSecrets, withoutClientWindowEvidence } from '../../shared.ts'
import type { BaseServices } from './base.ts'

export function createResponsesServices(services: Pick<BaseServices, 'cfg'>) {
	const { cfg } = services

	/** Per-file ceiling for a relay exposed through Tailscale Funnel. Large media belongs in a link. */
	const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

	class PayloadTooLargeError extends Error {}

	/**
	 * The last thing that happens to an error before it leaves the relay: the diagnostic
	 * tail `windowEvidence()` appends comes off, and the full text goes to the log instead.
	 *
	 * One place rather than the dozen routes that hand back a UI-write failure, for the
	 * same reason `redactSecrets` sits in front of every served log line: a rule applied at
	 * the boundary cannot be forgotten by the next route someone adds. What it prevents is
	 * what a tap on Fork against a locked Mac used to answer with — the sentence, then
	 * "[window server: 6; screen: locked] [processes: conductor=0] [menus: Apple, Conductor,
	 * File, ...]", in 11px red, on a phone that can do nothing with any of it. The evidence
	 * is still the fastest way to tell a wedged Conductor from a hidden window, so it lands
	 * in relay.log, which `/api/logs` serves to the same phone on request.
	 */
	function forTheClient(body: unknown): unknown {
		const scrub = (value: unknown, key?: string): unknown => {
			if (typeof value === 'string') {
				const withoutEvidence = withoutClientWindowEvidence(value, key)
				if (withoutEvidence !== value) console.warn(`[relay] ${scrubWorkflowSecrets(value)}`)
				return scrubWorkflowSecrets(withoutEvidence)
			}
			if (Array.isArray(value)) return value.map(item => scrub(item))
			if (!value || typeof value !== 'object') return value
			return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrub(child, childKey)]))
		}
		return scrub(body)
	}

	/**
	 * Successful GETs are conditional + compressed to keep the phone's polling cheap.
	 * `no-cache` (not `no-store`) means the browser must revalidate on every tick —
	 * the relay still runs the handler and auth each time, so data is never stale;
	 * a matching ETag just elides the redundant body (304), and changed bodies over
	 * ~1 KB go out gzipped. Errors and non-GETs stay unconditional `no-store`.
	 */
	function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
		const payload = Buffer.from(JSON.stringify(forTheClient(body)))
		if (status !== 200 || req.method !== 'GET') {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
			return void res.end(payload)
		}
		// Weak: the same entity may be delivered gzipped or plain.
		const etag = `W/"${crypto.createHash('sha1').update(payload).digest('base64url')}"`
		const headers: http.OutgoingHttpHeaders = {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-cache',
			etag,
			vary: 'accept-encoding'
		}
		if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end()
		if (payload.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
			headers['content-encoding'] = 'gzip'
			return void res.writeHead(200, headers).end(zlib.gzipSync(payload))
		}
		res.writeHead(200, headers).end(payload)
	}

	/** Constant-time string compare — the token is the sole internet-facing gate when exposed via Funnel. */
	function tokenEq(candidate: string | null): boolean {
		if (candidate == null) return false
		const a = Buffer.from(candidate)
		const b = Buffer.from(cfg.token)
		return a.length === b.length && crypto.timingSafeEqual(a, b)
	}

	function authed(req: http.IncomingMessage): boolean {
		const auth = req.headers.authorization
		if (auth?.startsWith('Bearer ')) return tokenEq(auth.slice('Bearer '.length))
		const url = new URL(req.url ?? '/', 'http://x')
		return tokenEq(url.searchParams.get('token'))
	}

	async function readBody(req: http.IncomingMessage): Promise<string> {
		const chunks: Buffer[] = []
		for await (const c of req) chunks.push(c as Buffer)
		return Buffer.concat(chunks).toString('utf8')
	}

	/** Read one uploaded file without allowing a token holder to fill the relay's memory. */
	async function readAttachmentBody(req: http.IncomingMessage): Promise<Buffer> {
		const declared = Number(req.headers['content-length'])
		if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
			throw new PayloadTooLargeError(`attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
		}
		const chunks: Buffer[] = []
		let bytes = 0
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			bytes += buffer.length
			if (bytes > MAX_ATTACHMENT_BYTES) {
				req.destroy()
				throw new PayloadTooLargeError(`attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
			}
			chunks.push(buffer)
		}
		return Buffer.concat(chunks, bytes)
	}

	function attachmentHeaderName(req: http.IncomingMessage): string | null {
		const encoded = req.headers['x-attachment-name']
		if (typeof encoded !== 'string' || !encoded) return null
		try {
			return decodeURIComponent(encoded)
		} catch {
			return null
		}
	}
	return { json, authed, readBody, forTheClient, attachmentHeaderName, readAttachmentBody, PayloadTooLargeError }
}
export type ResponsesServices = ReturnType<typeof createResponsesServices>
