import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stateDir } from '../config.ts'
import { READ_TIMEOUT_MS } from './protocol.ts'
import type { CallOptions } from './types.ts'

function relayErrorMessage(error: unknown, status: number): string {
	if (typeof error === 'string' && error) return error
	if (error && typeof error === 'object') {
		const fields = error as { code?: unknown; message?: unknown }
		const parts = [fields.code, fields.message].filter((part): part is string => typeof part === 'string' && !!part)
		if (parts.length) return parts.join(': ')
	}
	return `HTTP ${status}`
}

export function relayBase(): string {
	const port = process.env.RELAY_PORT ?? '8787'
	// The relay binds loopback (see config.ts); RELAY_HOST only widens who else can
	// reach it, so 127.0.0.1 is always right for a client on the same Mac.
	return `http://127.0.0.1:${port}`
}

function relayToken(): string {
	if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN
	try {
		return readFileSync(path.join(stateDir(), 'token'), 'utf8').trim()
	} catch {
		throw new Error(
			`no relay token at ${path.join(stateDir(), 'token')} — start the relay once (conductor-remote service install), or set RELAY_TOKEN`
		)
	}
}

export async function call<T>(route: string, opts: CallOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
	let res: Response
	try {
		res = await fetch(`${relayBase()}${route}`, {
			method: opts.method ?? 'GET',
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				authorization: `Bearer ${relayToken()}`,
				'content-type': 'application/json',
				// Marks this caller as an agent: the relay drops it to background priority on
				// the UI lock, behind anyone using the phone (src/http/router.ts ▸ withUiPriority).
				'x-relay-client': 'mcp',
				// The relay retries a failed send inside this budget and never past it, so
				// stating it here is what stops it outliving us — see src/http/services/delivery.ts ▸ sendBudget.
				'x-client-timeout-ms': String(timeoutMs)
			},
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		})
	} catch (err) {
		if (err instanceof DOMException && err.name === 'TimeoutError')
			throw new Error(`the relay did not answer within ${Math.round(timeoutMs / 1000)}s`)
		throw new Error(
			`cannot reach the relay at ${relayBase()} (${err instanceof Error ? err.message : err}). Is it running? \`conductor-remote service status\``
		)
	}
	const payload: unknown = await res.json().catch(() => ({}))
	if (!res.ok) {
		// 503 is the UI lock refusing a deep queue, and it is worth naming as such: it
		// means "retry shortly", not "this failed".
		const busy = res.status === 503 ? ' (Conductor’s UI is busy — retry shortly)' : ''
		const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined
		throw new Error(`${relayErrorMessage(error, res.status)}${busy}`)
	}
	return payload as T
}
