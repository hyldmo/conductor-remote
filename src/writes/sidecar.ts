import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * Client for Conductor's sidecar IPC — the `conductor-runtime sidecar` process
 * that owns every live `claude`/`codex` agent. The desktop app drives it over a
 * unix socket speaking newline-delimited JSON-RPC 2.0; we speak the same
 * protocol as an additional local client.
 *
 * This is by far the most precise write path: prompts are addressed by
 * `sessionId`, so there is no window focus or AppleScript involved and the app's
 * UI updates correctly because it's the real dispatch path. It is also the most
 * update-fragile surface (a private, versioned IPC), which is why it lives
 * behind the Actuator interface and falls back to AppleScript when the socket
 * can't be reached (see src/writes/actuator.ts).
 *
 * Reverse-engineered from conductor-runtime (Conductor 0.76):
 *   - socket:      `$TMPDIR/conductor-sidecar-v2-<sidecarPid>.sock`
 *   - transport:   newline-delimited JSON-RPC 2.0 (`{jsonrpc,id,method,params}`)
 *   - local auth:  the literal `{ userId: 'local', auth: 'local' }`
 *   - send prompt: method `query`, params `{ type: 'sendUserMessageRequest', … }`
 *   - safe read:   method `contextUsage`, params `{ sessionId, …auth }`
 *
 * Stale socket files from exited sidecars linger in `$TMPDIR`, so discovery is
 * connectivity-based: we try candidates newest-first and use the first that
 * actually accepts a connection.
 */

const SOCKET_PREFIX = 'conductor-sidecar-v2-'
const LOCAL_AUTH = { userId: 'local', auth: 'local' } as const

export type SidecarDeliveryMode = 'default' | 'queue'

/** Candidate sidecar socket paths in `$TMPDIR`, newest mtime first. */
function listSidecarSockets(): string[] {
	const dir = os.tmpdir()
	let names: string[]
	try {
		names = fs.readdirSync(dir)
	} catch {
		return []
	}
	const found: { p: string; m: number }[] = []
	for (const name of names) {
		if (!(name.startsWith(SOCKET_PREFIX) && name.endsWith('.sock'))) continue
		const p = path.join(dir, name)
		try {
			const st = fs.statSync(p)
			if (st.isSocket()) found.push({ p, m: st.mtimeMs })
		} catch {
			// vanished between readdir and stat — skip
		}
	}
	return found.sort((a, b) => b.m - a.m).map(x => x.p)
}

function isConnRefused(err: unknown): boolean {
	const code = (err as { code?: string })?.code
	return code === 'ECONNREFUSED' || code === 'ENOENT'
}

interface RpcMessage {
	id?: unknown
	result?: unknown
	error?: { code: number; message: string }
}

/** One JSON-RPC request/response over a fresh connection to a specific socket. */
function rpcOnSocket(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath)
		const id = 1
		let buf = ''
		let settled = false
		const finish = (err: Error | null, val?: unknown): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			sock.destroy()
			if (err) reject(err)
			else resolve(val)
		}
		const timer = setTimeout(() => finish(new Error(`sidecar RPC "${method}" timed out`)), timeoutMs)

		sock.on('connect', () => {
			sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		})
		sock.on('data', chunk => {
			buf += chunk.toString('utf8')
			// The sidecar also pushes unsolicited notifications — ignore anything
			// that isn't the response to our id.
			let nl = buf.indexOf('\n')
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim()
				buf = buf.slice(nl + 1)
				nl = buf.indexOf('\n')
				if (!line) continue
				let msg: RpcMessage
				try {
					msg = JSON.parse(line) as RpcMessage
				} catch {
					continue
				}
				if (msg.id === id && ('result' in msg || 'error' in msg)) {
					if (msg.error) return finish(new Error(msg.error.message || `sidecar RPC error ${msg.error.code}`))
					return finish(null, msg.result)
				}
			}
		})
		sock.on('error', e => finish(e instanceof Error ? e : new Error(String(e))))
		sock.on('close', () => finish(new Error('sidecar closed the connection before responding')))
	})
}

/** Try each candidate socket, skipping stale ones (connection refused). */
async function rpc(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
	const candidates = listSidecarSockets()
	if (!candidates.length) throw new Error('no Conductor sidecar socket found — is Conductor running?')
	let lastErr: unknown
	for (const socketPath of candidates) {
		try {
			return await rpcOnSocket(socketPath, method, params, timeoutMs)
		} catch (err) {
			lastErr = err
			if (isConnRefused(err)) continue // stale socket file, try the next
			throw err // a real RPC/protocol error — surface it, don't mask
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error('sidecar unreachable')
}

/** Resolve a connectable sidecar socket, or null. Used to decide write strategy. */
export function sidecarSocket(timeoutMs = 800): Promise<string | null> {
	const candidates = listSidecarSockets()
	return (async () => {
		for (const p of candidates) {
			const ok = await canConnect(p, timeoutMs)
			if (ok) return p
		}
		return null
	})()
}

function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const sock = net.connect(socketPath)
		let done = false
		const finish = (ok: boolean): void => {
			if (done) return
			done = true
			clearTimeout(t)
			sock.destroy()
			resolve(ok)
		}
		const t = setTimeout(() => finish(false), timeoutMs)
		sock.on('connect', () => finish(true))
		sock.on('error', () => finish(false))
	})
}

/** True when a precise (sidecar) send path is currently reachable. */
export async function sidecarAvailable(): Promise<boolean> {
	return (await sidecarSocket()) !== null
}

/**
 * Deliver a prompt to a specific session — the real send path, precisely
 * targeted. Resolves once the sidecar has accepted (queued/sent) the message.
 */
export async function sidecarSendUserMessage(
	sessionId: string,
	text: string,
	deliveryMode: SidecarDeliveryMode = 'default'
): Promise<void> {
	await rpc('query', {
		type: 'sendUserMessageRequest',
		...LOCAL_AUTH,
		sessionId,
		id: randomUUID(),
		message: text,
		agentMessage: text,
		deliveryMode
	})
}

/**
 * Read a session's context usage. Pure read — no turn is triggered — so it's the
 * safe way to prove the socket + auth + framing work end to end.
 */
export function sidecarContextUsage(sessionId: string): Promise<unknown> {
	return rpc('contextUsage', { ...LOCAL_AUTH, sessionId }, 5000)
}
