import crypto from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { tcpOpen } from './ports.ts'
import { processAlive } from './processes.ts'
import type { DevProxy, StoredForward } from './types.ts'

export function bridgeMatches(record: StoredForward): Promise<boolean> {
	if (!record.bridgeToken) {
		// Compatibility for the first local prototype receipts. PID plus an open
		// bridge is enough to avoid stealing one during this upgrade; every newly
		// written receipt carries the unambiguous challenge below.
		return processAlive(record.ownerPid) ? tcpOpen(record.bridgePort) : Promise.resolve(false)
	}
	return new Promise(resolve => {
		let settled = false
		const finish = (matches: boolean) => {
			if (settled) return
			settled = true
			request.destroy()
			resolve(matches)
		}
		const request = http.request(
			{
				host: '127.0.0.1',
				port: record.bridgePort,
				method: 'GET',
				path: '/',
				headers: { 'x-conductor-remote-bridge': record.bridgeToken }
			},
			response => {
				response.resume()
				finish(response.statusCode === 204)
			}
		)
		request.setTimeout(500, () => finish(false))
		request.once('error', () => finish(false))
		request.end()
	})
}

function externalOrigin(req: http.IncomingMessage): string {
	const forwardedProto = String(req.headers['x-forwarded-proto'] ?? 'https')
		.split(',')[0]
		.trim()
	const forwardedHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
		.split(',')[0]
		.trim()
	return `${forwardedProto || 'https'}://${forwardedHost}`
}

function localOrigin(targetPort: number): string {
	return `http://127.0.0.1:${targetPort}`
}

function proxyHeaders(req: http.IncomingMessage, targetPort: number): IncomingHttpHeaders {
	const headers = { ...req.headers }
	const publicHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
	headers.host = `127.0.0.1:${targetPort}`
	if (publicHost) headers['x-forwarded-host'] = publicHost
	headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] ?? 'https')
	// Framework dev servers commonly apply the same allowlist to WebSocket Origin
	// that they apply to Host. Present the local origin they were configured for.
	if (headers.origin) headers.origin = localOrigin(targetPort)
	if (headers.referer) {
		try {
			const ref = new URL(headers.referer)
			headers.referer = `${localOrigin(targetPort)}${ref.pathname}${ref.search}`
		} catch {
			// Preserve an unusual Referer rather than inventing one.
		}
	}
	return headers
}

function rewriteLocation(
	location: string | undefined,
	req: http.IncomingMessage,
	targetPort: number
): string | undefined {
	if (!location) return undefined
	const local = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost)(?::${targetPort})?`, 'i')
	return location.replace(local, externalOrigin(req))
}

function writeUpgradeRequest(upstream: net.Socket, req: http.IncomingMessage, head: Buffer, targetPort: number): void {
	const headers = proxyHeaders(req, targetPort)
	const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) lines.push(`${name}: ${item}`)
		} else {
			lines.push(`${name}: ${value}`)
		}
	}
	upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
	if (head.length) upstream.write(head)
}

/** Loopback reverse proxy with raw WebSocket tunnelling for Vite-style HMR. */
export function createDevProxy(targetPort: number): Promise<DevProxy> {
	return new Promise((resolve, reject) => {
		const token = crypto.randomBytes(16).toString('hex')
		const sockets = new Set<net.Socket>()
		const server = http.createServer((req, res) => {
			if (req.headers['x-conductor-remote-bridge'] === token) {
				res.writeHead(204)
				return res.end()
			}
			const upstream = http.request(
				{
					host: '127.0.0.1',
					port: targetPort,
					method: req.method,
					path: req.url,
					headers: proxyHeaders(req, targetPort)
				},
				upstreamRes => {
					const headers = { ...upstreamRes.headers }
					const location = rewriteLocation(upstreamRes.headers.location, req, targetPort)
					if (location) headers.location = location
					res.writeHead(upstreamRes.statusCode ?? 502, headers)
					upstreamRes.pipe(res)
				}
			)
			upstream.once('error', () => {
				if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
				res.end('Dev server is not reachable')
			})
			req.pipe(upstream)
		})

		server.on('connection', socket => {
			sockets.add(socket)
			socket.once('close', () => sockets.delete(socket))
		})
		server.on('upgrade', (req, socket, head) => {
			const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
				writeUpgradeRequest(upstream, req, head, targetPort)
				socket.pipe(upstream).pipe(socket)
			})
			sockets.add(upstream)
			upstream.once('close', () => sockets.delete(upstream))
			upstream.once('error', () => socket.destroy())
			socket.once('error', () => upstream.destroy())
		})

		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close()
				return reject(new Error('could not allocate the dev-server bridge port'))
			}
			resolve({
				port: address.port,
				token,
				close: () =>
					new Promise<void>(done => {
						for (const socket of sockets) socket.destroy()
						server.close(() => done())
					})
			})
		})
	})
}
