import net from 'node:net'
import type { ServeStatus } from '../host/tailscale.ts'
import type { StoredForward } from './types.ts'

export function validPort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= 65535
}

export function tcpOpen(port: number, timeoutMs = 300): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host: '127.0.0.1', port })
		const finish = (open: boolean) => {
			socket.destroy()
			resolve(open)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

export async function waitForPort(port: number, open: boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	do {
		if ((await tcpOpen(port)) === open) return true
		await new Promise(resolve => setTimeout(resolve, 250))
	} while (Date.now() < deadline)
	return false
}

export function serveProxyAt(status: ServeStatus, port: number): string | null {
	for (const [origin, web] of Object.entries(status.Web ?? {})) {
		if (!origin.endsWith(`:${port}`)) continue
		return web.Handlers?.['/']?.Proxy ?? null
	}
	return null
}

function servePorts(status: ServeStatus): Set<number> {
	return new Set(
		Object.keys(status.TCP ?? {})
			.map(Number)
			.filter(validPort)
	)
}

export function chooseServePort(status: ServeStatus, targetPort: number, reserved = new Set<number>()): number | null {
	const used = servePorts(status)
	for (let offset = 0; offset < 10; offset++) {
		const candidate = targetPort + offset
		if (validPort(candidate) && !used.has(candidate) && !reserved.has(candidate)) return candidate
	}
	for (let candidate = 49152; candidate <= 65535; candidate++) {
		if (!used.has(candidate) && !reserved.has(candidate)) return candidate
	}
	return null
}

export function previewPath(previewUrl: string): string {
	const url = new URL(previewUrl)
	return `${url.pathname || '/'}${url.search}${url.hash}`
}

export function localPreviewUrl(port: number, suffix = '/'): string {
	return `http://localhost:${port}${suffix}`
}

export function forwardUrl(record: StoredForward, previewUrl?: string): string {
	const suffix = previewUrl ? previewPath(previewUrl) : record.path || '/'
	return `https://${record.host}${record.servePort === 443 ? '' : `:${record.servePort}`}${suffix}`
}
