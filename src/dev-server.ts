/**
 * Local workspace dev servers: Conductor owns the process; Tailscale Serve owns
 * the tailnet-only HTTPS port.
 *
 * The relay never spawns a repository command itself. Starting and stopping go
 * through Conductor's real Run button (`writes.ts`), which preserves its task
 * selection, environment, run-mode rules and process-group cleanup. This module
 * discovers that workspace's allocated `CONDUCTOR_PORT`, accepts complete URLs
 * from Conductor configuration or a running application, and gives each local
 * preview a tailnet HTTPS origin on the Mac's MagicDNS name. Conductor's detected
 * Open-control URLs are used when its accessibility tree exposes them; port-only
 * controls remain the compatibility fallback.
 *
 * Tailscale's reverse proxy preserves the public Host header. Dev servers such
 * as Vite reject that by default, so a tiny loopback bridge rewrites Host/Origin
 * to the local target while leaving paths and WebSocket upgrades untouched.
 * Root-relative assets and HMR therefore work without application-specific base
 * paths or HTML rewriting.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { stateDir } from './config.ts'
import {
	type PreviewTarget,
	type PreviewUrlSetting,
	previewUrlSettings,
	resolvePreviewTargets
} from './preview-urls.ts'
import type { Workspace } from './reads.ts'
import { type DevRunConfig, runConfigsFor } from './run-configs.ts'
import type { ServeStatus } from './tailscale.ts'
import { magicDnsName, tailscaleBin } from './tailscale.ts'
import { setRunTask } from './writes.ts'

const exec = promisify(execFile)
// Keep the receipt additive and version-1-readable: an installed relay and a
// source `yarn dev` relay can briefly share this file during an update.
const STORE_VERSION = 1
const PREVIEW_ADVERTISEMENT_VERSION = 1
const PORT_WAIT_MS = 15_000
const PORT_SNAPSHOT_TTL_MS = 5000
const MAX_PREVIEW_ADVERTISEMENT_BYTES = 64 * 1024

export interface DevServerState {
	/** The local Tailscale prerequisites needed to expose a Run task are ready. */
	available: boolean
	/** Something currently accepts TCP connections on the workspace's primary port. */
	running: boolean
	/** This relay owns an active tailnet-only Tailscale Serve mapping. */
	forwarded: boolean
	/** The workspace's primary `CONDUCTOR_PORT`, when it can be discovered. */
	port: number | null
	/** Tailnet-only HTTPS URL, present only while forwarded. */
	url: string | null
	/** Configured or detected previews, in Conductor's Open-menu order. */
	forwards: DevServerForward[]
	/** Named Run choices visible in Conductor for this local workspace. */
	runConfigs: DevRunConfig[]
	/** The selected Conductor Run task, known after a start/stop action. */
	task?: string
	/** Why this workspace cannot currently be controlled or forwarded. */
	error?: string
}

export interface DevServerForward {
	/** Configured preview name; detected/fallback ports use "Port N". */
	name: string
	/** Local loopback port behind this forward. */
	port: number
	/** Something currently accepts TCP connections on `port`. */
	running: boolean
	/** This relay owns and can verify the Tailscale mapping. */
	forwarded: boolean
	/** Tailnet-only URL, including the configured path, when forwarded. */
	url: string | null
}

export interface DevServerResult extends DevServerState {
	ok: boolean
	/** Conductor's button actually changed, rather than already matching the request. */
	changed?: boolean
}

interface StoredForward {
	workspaceId: string
	/** Allocated base used to resolve preview templates; absent only on old receipts. */
	basePort?: number | null
	targetPort: number
	servePort: number
	bridgePort: number
	host: string
	/** Last launch label, retained only for a port-only fallback after restart. */
	name?: string
	/** Last path/query/fragment, retained only for a port-only fallback after restart. */
	path?: string
	/** Relay process holding the loopback bridge; absent on version-1 receipts. */
	ownerPid?: number
	/** Private loopback challenge proving that process still owns this bridge. */
	bridgeToken?: string
}

interface ForwardStore {
	version: number
	forwards: StoredForward[]
}

interface PreviewAdvertisement {
	version: number
	workspaceId: string
	ownerPid: number
	previews: PreviewUrlSetting[]
}

interface DevProxy {
	port: number
	token: string
	close: () => Promise<void>
}

function recordKey(workspaceId: string, targetPort: number): string {
	return `${workspaceId}:${targetPort}`
}

function validPort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= 65535
}

function processAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function bridgeMatches(record: StoredForward): Promise<boolean> {
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

/**
 * Parse a macOS `ps eww -axo command=` snapshot without ever logging it: process
 * environments can contain credentials. Multiple processes are expected, but
 * conflicting ports for one workspace are not safe to guess through.
 */
export function parseWorkspacePort(snapshot: string, workspaceId: string): number | null {
	const ports = new Set<number>()
	for (const line of snapshot.split('\n')) {
		const id = line.match(/(?:^|\s)CONDUCTOR_WORKSPACE_ID=([^\s]+)/)?.[1]
		if (id !== workspaceId) continue
		const port = Number(line.match(/(?:^|\s)CONDUCTOR_PORT=(\d+)(?:\s|$)/)?.[1])
		if (validPort(port)) ports.add(port)
	}
	return ports.size === 1 ? [...ports][0] : null
}

let portSnapshot: { at: number; text: string } | null = null
let portSnapshotInFlight: Promise<string> | null = null

async function readProcesses(): Promise<string> {
	const { stdout } = await exec('ps', ['eww', '-axo', 'command='], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: 5000
	})
	portSnapshot = { at: Date.now(), text: stdout }
	return stdout
}

/**
 * One `ps` snapshot shared by every workspace. It carries every process
 * environment on the Mac (~650 kB here), and the phone polls this state every
 * 2.5s per open chat, so a read reuses a recent one and simultaneous readers
 * await the same child process. A workspace whose Run task is stopped has no
 * port to remember, which is why the miss path needs this and not just the hit
 * path. A start asks for `maxAgeMs` 0, because the task it just pressed is
 * younger than any cached snapshot.
 */
function processSnapshot(maxAgeMs: number): Promise<string> {
	if (maxAgeMs <= 0) return readProcesses()
	if (portSnapshot && Date.now() - portSnapshot.at <= maxAgeMs) return Promise.resolve(portSnapshot.text)
	portSnapshotInFlight ??= readProcesses().finally(() => {
		portSnapshotInFlight = null
	})
	return portSnapshotInFlight
}

async function workspacePort(workspaceId: string, maxAgeMs = 0): Promise<number | null> {
	try {
		return parseWorkspacePort(await processSnapshot(maxAgeMs), workspaceId)
	} catch {
		// Never reflect the error: `execFile` includes stdout, which is the process
		// environment snapshot and may contain secrets.
		return null
	}
}

function tcpOpen(port: number, timeoutMs = 300): Promise<boolean> {
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

async function waitForPort(port: number, open: boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	do {
		if ((await tcpOpen(port)) === open) return true
		await new Promise(resolve => setTimeout(resolve, 250))
	} while (Date.now() < deadline)
	return false
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

function chooseServePort(status: ServeStatus, targetPort: number, reserved = new Set<number>()): number | null {
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

function previewPath(previewUrl: string): string {
	const url = new URL(previewUrl)
	return `${url.pathname || '/'}${url.search}${url.hash}`
}

function localPreviewUrl(port: number, suffix = '/'): string {
	return `http://localhost:${port}${suffix}`
}

function forwardUrl(record: StoredForward, previewUrl?: string): string {
	const suffix = previewUrl ? previewPath(previewUrl) : record.path || '/'
	return `https://${record.host}${record.servePort === 443 ? '' : `:${record.servePort}`}${suffix}`
}

export class DevServerController {
	private readonly storeFile: string
	private readonly advertisementDir: string
	private bin: string | null
	private host: string | null
	private readonly records = new Map<string, StoredForward>()
	private readonly proxies = new Map<string, DevProxy>()
	private readonly ports = new Map<string, number>()
	private readonly advertisedPreviews = new Map<string, PreviewUrlSetting[]>()
	private readonly actions = new Map<string, Promise<DevServerResult>>()

	constructor(storeFile = path.join(stateDir(), 'dev-forwards.json')) {
		this.storeFile = storeFile
		this.advertisementDir = path.join(path.dirname(storeFile), 'dev-preview-advertisements')
		this.bin = tailscaleBin()
		this.host = this.bin ? magicDnsName(this.bin) : null
		this.load()
	}

	/**
	 * Let a running application publish the exact URLs it wants opened. A source
	 * relay and the installed relay are separate processes, so the advertisement
	 * is also written to a private workspace-scoped manifest they can both read.
	 *
	 * The producer owns every path, query parameter and fragment — including any
	 * bootstrap credential. The forwarding layer only accepts loopback HTTP URLs
	 * and changes their origin, so it never needs application-specific token logic.
	 */
	advertisePreviewUrls(workspaceId: string, previews: PreviewUrlSetting[]): void {
		if (!workspaceId) return
		if (!previews.length) {
			this.advertisedPreviews.delete(workspaceId)
			this.removeOwnPreviewAdvertisement(workspaceId)
			return
		}
		const published = previews.slice(0, 10).map(preview => ({ name: preview.name, url: preview.url }))
		this.advertisedPreviews.set(workspaceId, published)
		const advertisement: PreviewAdvertisement = {
			version: PREVIEW_ADVERTISEMENT_VERSION,
			workspaceId,
			ownerPid: process.pid,
			previews: published
		}
		const file = this.previewAdvertisementFile(workspaceId)
		const temporary = `${file}.${process.pid}.tmp`
		try {
			fs.mkdirSync(this.advertisementDir, { recursive: true, mode: 0o700 })
			fs.writeFileSync(temporary, `${JSON.stringify(advertisement, null, 2)}\n`, { mode: 0o600 })
			fs.chmodSync(temporary, 0o600)
			fs.renameSync(temporary, file)
		} catch (err) {
			try {
				fs.unlinkSync(temporary)
			} catch {}
			console.warn(`⚠ could not publish dev-server previews (${err instanceof Error ? err.message : err})`)
		}
	}

	private previewAdvertisementFile(workspaceId: string): string {
		const key = crypto.createHash('sha256').update(workspaceId).digest('hex')
		return path.join(this.advertisementDir, `${key}.json`)
	}

	private readPreviewAdvertisement(workspaceId: string): PreviewUrlSetting[] {
		try {
			const file = this.previewAdvertisementFile(workspaceId)
			if (fs.statSync(file).size > MAX_PREVIEW_ADVERTISEMENT_BYTES) return []
			const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PreviewAdvertisement>
			if (
				value.version !== PREVIEW_ADVERTISEMENT_VERSION ||
				value.workspaceId !== workspaceId ||
				!Number.isInteger(value.ownerPid) ||
				(value.ownerPid ?? 0) <= 0 ||
				!processAlive(value.ownerPid) ||
				!Array.isArray(value.previews)
			)
				return []
			return value.previews
				.flatMap(preview =>
					preview &&
					typeof preview.url === 'string' &&
					preview.url.length <= 8192 &&
					(preview.name === undefined || (typeof preview.name === 'string' && preview.name.length <= 256))
						? [{ name: preview.name, url: preview.url }]
						: []
				)
				.slice(0, 10)
		} catch {
			return []
		}
	}

	private removeOwnPreviewAdvertisement(workspaceId: string): void {
		const file = this.previewAdvertisementFile(workspaceId)
		try {
			const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PreviewAdvertisement>
			if (value.workspaceId === workspaceId && value.ownerPid === process.pid) fs.unlinkSync(file)
		} catch {
			// Missing, malformed or owned by another producer: there is nothing of ours to remove.
		}
	}

	private refreshTailscale(): void {
		this.bin ??= tailscaleBin()
		if (this.bin && !this.host) this.host = magicDnsName(this.bin)
	}

	private load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as ForwardStore
			if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.forwards)) return
			for (const record of parsed.forwards) {
				if (
					record.workspaceId &&
					(record.basePort === undefined || record.basePort === null || validPort(record.basePort)) &&
					validPort(record.targetPort) &&
					validPort(record.servePort) &&
					validPort(record.bridgePort) &&
					typeof record.host === 'string' &&
					record.host.length > 0
				) {
					if (record.basePort === undefined) record.basePort = record.targetPort
					this.records.set(recordKey(record.workspaceId, record.targetPort), record)
				}
			}
		} catch {
			// First run, or a disposable corrupt cache. Never touch an unrecognised
			// Tailscale mapping without a valid record proving this relay owns it.
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.storeFile), { recursive: true })
			const body: ForwardStore = { version: STORE_VERSION, forwards: [...this.records.values()] }
			fs.writeFileSync(this.storeFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
		} catch (err) {
			console.warn(`⚠ could not persist dev-server forwards (${err instanceof Error ? err.message : err})`)
		}
	}

	private async portFor(workspaceId: string): Promise<number | null> {
		const cached = this.ports.get(workspaceId)
		if (cached) return cached
		const discovered = await workspacePort(workspaceId, PORT_SNAPSHOT_TTL_MS)
		if (discovered) this.ports.set(workspaceId, discovered)
		if (discovered) return discovered
		for (const record of this.records.values()) {
			if (record.workspaceId === workspaceId && record.basePort) return record.basePort
		}
		return null
	}

	private targetsFor(
		workspace: Workspace,
		basePort: number | null,
		detectedPorts: number[] = [],
		detectedUrls: string[] = []
	): PreviewTarget[] {
		const configured = resolvePreviewTargets(previewUrlSettings(workspace), basePort)
		if (configured.length) return configured
		const advertised = resolvePreviewTargets(
			this.advertisedPreviews.get(workspace.id) ?? this.readPreviewAdvertisement(workspace.id),
			basePort
		)
		if (advertised.length) return advertised
		const detected = resolvePreviewTargets(
			detectedUrls.map(url => ({ url })),
			basePort
		)
		const ports = [...new Set(detectedPorts.filter(validPort))]
		const representedPorts = new Set(detected.map(target => target.port))
		if (!ports.length && !detected.length && basePort) ports.push(basePort)
		if (!ports.length && !detected.length) {
			for (const record of this.records.values()) {
				if (record.workspaceId === workspace.id) ports.push(record.targetPort)
			}
		}
		const fallbacks = ports
			.filter(port => !representedPorts.has(port))
			.slice(0, 10 - detected.length)
			.map(port => {
				const record = this.records.get(recordKey(workspace.id, port))
				return { name: record?.name || `Port ${port}`, port, url: localPreviewUrl(port, record?.path || '/') }
			})
		return [...detected, ...fallbacks]
	}

	private async serveStatus(): Promise<ServeStatus> {
		if (!this.bin) throw new Error('Tailscale CLI is not available on this Mac')
		const { stdout } = await exec(this.bin, ['serve', 'status', '--json'], {
			encoding: 'utf8',
			timeout: 10_000
		})
		return JSON.parse(stdout) as ServeStatus
	}

	private async setServe(servePort: number, bridgePort: number): Promise<void> {
		if (!this.bin) throw new Error('Tailscale CLI is not available on this Mac')
		await exec(this.bin, ['serve', '--bg', '--yes', `--https=${servePort}`, `http://127.0.0.1:${bridgePort}`], {
			encoding: 'utf8',
			timeout: 15_000
		})
	}

	private async unsetServe(record: StoredForward): Promise<void> {
		if (!this.bin) return
		try {
			const status = await this.serveStatus()
			// The user may have replaced this endpoint since the relay created it.
			// Only remove the exact loopback bridge our persisted receipt names.
			if (serveProxyAt(status, record.servePort) !== `http://127.0.0.1:${record.bridgePort}`) return
			await exec(this.bin, ['serve', '--yes', `--https=${record.servePort}`, 'off'], {
				encoding: 'utf8',
				timeout: 15_000
			})
		} catch {
			// Cleanup is best-effort. Keep the record so the next relay start can
			// identify and remove its own stale mapping rather than forgetting it.
			throw new Error(`could not remove the Tailscale Serve mapping on :${record.servePort}`)
		}
	}

	private async releaseRecord(key: string): Promise<void> {
		const record = this.records.get(key)
		const proxy = this.proxies.get(key)
		let cleanupError: unknown
		if (record) {
			try {
				await this.unsetServe(record)
			} catch (err) {
				cleanupError = err
			}
		}
		// Even when the Serve CLI is temporarily unavailable, close the bridge so
		// its stale HTTPS mapping cannot reach a later process that reuses the port.
		if (proxy) await proxy.close()
		this.proxies.delete(key)
		if (!cleanupError) this.records.delete(key)
		this.save()
		if (cleanupError) throw cleanupError
	}

	private async release(workspaceId: string): Promise<void> {
		let firstError: unknown
		for (const [key, record] of [...this.records]) {
			if (record.workspaceId !== workspaceId) continue
			try {
				await this.releaseRecord(key)
			} catch (err) {
				firstError ??= err
			}
		}
		if (firstError) throw firstError
	}

	private async forward(
		workspaceId: string,
		basePort: number | null,
		target: PreviewTarget,
		reservedPorts: Set<number>
	): Promise<StoredForward> {
		const key = recordKey(workspaceId, target.port)
		const existing = this.records.get(key)
		if (existing) {
			const status = await this.serveStatus()
			const expected = `http://127.0.0.1:${existing.bridgePort}`
			if (serveProxyAt(status, existing.servePort) === expected && (await bridgeMatches(existing))) {
				existing.basePort = basePort ?? existing.basePort
				existing.name = target.name
				existing.path = previewPath(target.url)
				this.save()
				return existing
			}
		}
		if (existing) await this.releaseRecord(key)
		if (!this.bin || !this.host) throw new Error('Tailscale is not connected on this Mac')

		const status = await this.serveStatus()
		const servePort = chooseServePort(status, target.port, reservedPorts)
		if (!servePort) throw new Error('no free Tailscale Serve port is available')
		const proxy = await createDevProxy(target.port)
		try {
			await this.setServe(servePort, proxy.port)
		} catch (err) {
			// `tailscale serve` may have applied the mapping just before its child
			// process timed out. Remove only this exact bridge if it did, so a failed
			// action never leaves an untracked endpoint behind.
			try {
				const statusAfterFailure = await this.serveStatus()
				if (serveProxyAt(statusAfterFailure, servePort) === `http://127.0.0.1:${proxy.port}` && this.bin) {
					await exec(this.bin, ['serve', '--yes', `--https=${servePort}`, 'off'], {
						encoding: 'utf8',
						timeout: 15_000
					})
				}
			} catch {
				// The bridge closes below regardless, making any stale mapping inert.
			}
			await proxy.close()
			throw err
		}
		const record: StoredForward = {
			workspaceId,
			basePort,
			targetPort: target.port,
			servePort,
			bridgePort: proxy.port,
			host: this.host,
			name: target.name,
			path: previewPath(target.url),
			ownerPid: process.pid,
			bridgeToken: proxy.token
		}
		this.proxies.set(key, proxy)
		this.records.set(key, record)
		this.save()
		return record
	}

	private async forwardAll(workspaceId: string, basePort: number | null, targets: PreviewTarget[]): Promise<void> {
		const byPort = new Map<number, PreviewTarget>()
		for (const target of targets) if (!byPort.has(target.port)) byPort.set(target.port, target)
		const wanted = new Set([...byPort].map(([port]) => recordKey(workspaceId, port)))
		for (const [key, record] of [...this.records]) {
			if (record.workspaceId === workspaceId && !wanted.has(key)) await this.releaseRecord(key)
		}
		const naturalPorts = new Set(byPort.keys())
		for (const target of byPort.values()) {
			const reserved = new Set([...naturalPorts].filter(port => port !== target.port))
			await this.forward(workspaceId, basePort, target, reserved)
		}
	}

	/** Rebuild loopback bridges after launchd or the self-updater restarts the relay. */
	async restore(): Promise<void> {
		this.refreshTailscale()
		// Tailscale can come up after a login LaunchAgent. Retain the receipts in
		// that case; a later tap can safely replace or remove their exact mappings.
		if (!this.bin || !this.host) return
		for (const [key, record] of [...this.records]) {
			try {
				if (record.basePort) this.ports.set(record.workspaceId, record.basePort)
				// `yarn dev` runs another relay beside the installed LaunchAgent. A
				// node --watch restart must not steal the installed relay's live bridge
				// merely because both instances share the same state directory.
				if (record.ownerPid !== process.pid && (await bridgeMatches(record))) continue
				const status = await this.serveStatus()
				const owned = serveProxyAt(status, record.servePort) === `http://127.0.0.1:${record.bridgePort}`
				if (!owned) {
					this.records.delete(key)
					continue
				}
				if (!(await tcpOpen(record.targetPort))) {
					await this.releaseRecord(key)
					continue
				}
				const proxy = await createDevProxy(record.targetPort)
				await this.setServe(record.servePort, proxy.port)
				record.bridgePort = proxy.port
				record.ownerPid = process.pid
				record.bridgeToken = proxy.token
				this.proxies.set(key, proxy)
				this.records.set(key, record)
			} catch (err) {
				console.warn(
					`⚠ could not restore dev-server forward for ${record.workspaceId} (${err instanceof Error ? err.message : err})`
				)
			}
		}
		this.save()
	}

	async state(workspace: Workspace): Promise<DevServerState> {
		this.refreshTailscale()
		const runConfigs = runConfigsFor(workspace)
		const basePort = await this.portFor(workspace.id)
		if (basePort) this.ports.set(workspace.id, basePort)
		const targets = this.targetsFor(workspace, basePort)
		const targetPorts = new Set(targets.map(target => target.port))
		// Keep a configured URL list authoritative, but don't hide a still-owned
		// forward after the file changes; it must remain visible until Start
		// reconciles it or Stop removes it.
		for (const record of this.records.values()) {
			if (record.workspaceId !== workspace.id || targetPorts.has(record.targetPort)) continue
			targets.push({
				name: record.name || `Port ${record.targetPort}`,
				port: record.targetPort,
				url: localPreviewUrl(record.targetPort, record.path || '/')
			})
			targetPorts.add(record.targetPort)
		}

		let status: ServeStatus | null = null
		try {
			if (targets.some(target => this.records.has(recordKey(workspace.id, target.port))))
				status = await this.serveStatus()
		} catch {
			// A disconnected CLI makes every URL unverified, never optimistically live.
		}
		const openByPort = new Map<number, Promise<boolean>>()
		const ownedByPort = new Map<number, Promise<boolean>>()
		const forwards = await Promise.all(
			targets.map(async target => {
				let open = openByPort.get(target.port)
				if (!open) {
					open = tcpOpen(target.port)
					openByPort.set(target.port, open)
				}
				const record = this.records.get(recordKey(workspace.id, target.port))
				let owned = ownedByPort.get(target.port)
				if (!owned) {
					owned = Promise.resolve(
						Boolean(
							status && record && serveProxyAt(status, record.servePort) === `http://127.0.0.1:${record.bridgePort}`
						)
					).then(matches => (matches && record ? bridgeMatches(record) : false))
					ownedByPort.set(target.port, owned)
				}
				const [targetRunning, targetForwarded] = await Promise.all([open, owned])
				return {
					name: target.name,
					port: target.port,
					running: targetRunning,
					forwarded: targetForwarded,
					url: targetForwarded && record ? forwardUrl(record, target.url) : null
				}
			})
		)
		const primary = forwards[0]
		const firstForwarded = forwards.find(forward => forward.forwarded && forward.url)
		let error: string | undefined
		if (!this.bin || !this.host) error = 'Tailscale is not connected on this Mac'
		return {
			available: !!this.bin && !!this.host,
			running: primary?.running ?? false,
			forwarded: Boolean(firstForwarded),
			port: primary?.port ?? basePort,
			url: firstForwarded?.url ?? null,
			forwards,
			runConfigs,
			error
		}
	}

	private exclusive(workspace: Workspace, operation: () => Promise<DevServerResult>): Promise<DevServerResult> {
		const previous = this.actions.get(workspace.id)
		// Two phones can tap opposite actions at once. Preserve their order instead
		// of answering Stop with the in-flight Start result.
		const action = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation)
		this.actions.set(workspace.id, action)
		void action
			.finally(() => {
				if (this.actions.get(workspace.id) === action) this.actions.delete(workspace.id)
			})
			.catch(() => undefined)
		return action
	}

	start(workspace: Workspace, runConfigId?: string): Promise<DevServerResult> {
		return this.exclusive(workspace, async () => {
			const runConfigs = runConfigsFor(workspace)
			const selected = runConfigId ? runConfigs.find(config => config.id === runConfigId) : undefined
			// Conductor still renders its desktop chooser for one named config. Resolve
			// that sole choice here so the phone stays one-tap while the actuator can
			// select the exact menu item instead of inheriting desktop selection state.
			const taskConfig = selected ?? (runConfigs.length === 1 ? runConfigs[0] : undefined)
			if (runConfigId && !selected) {
				return {
					ok: false,
					...(await this.state(workspace)),
					error: `Run config ${runConfigId} is not available in this workspace`
				}
			}
			if (runConfigs.length > 1 && !selected) {
				return {
					ok: false,
					...(await this.state(workspace)),
					error: 'Choose which Run config to start'
				}
			}
			this.refreshTailscale()
			if (!this.bin || !this.host) return { ok: false, ...(await this.state(workspace)) }
			try {
				// Fail before pressing Run when this Mac cannot currently configure
				// Serve. Starting a process the requested one-tap action cannot expose
				// would leave the phone showing failure while the task keeps running.
				await this.serveStatus()
			} catch {
				return {
					ok: false,
					...(await this.state(workspace)),
					error: 'Tailscale Serve is not available on this Mac'
				}
			}
			let basePort = await this.portFor(workspace.id)
			let targets = this.targetsFor(workspace, basePort)
			let primaryPort = targets[0]?.port ?? null
			// A task already listening needs no button. Forwarding it touches only
			// Tailscale and this relay, so it costs about a second, steals no focus
			// from the Mac, and stays inside the tap activation a phone can open a
			// tab with. Pressing Run here would also assert a pane for a press it
			// then decides not to make.
			if (!selected && primaryPort && (await tcpOpen(primaryPort))) {
				try {
					await this.forwardAll(workspace.id, basePort, targets)
					return { ok: true, ...(await this.state(workspace)), changed: false }
				} catch (err) {
					return {
						ok: false,
						...(await this.state(workspace)),
						changed: false,
						error: err instanceof Error ? err.message : String(err)
					}
				}
			}
			const run = await setRunTask(workspace, true, taskConfig?.name)
			if (!run.ok) return { ok: false, ...(await this.state(workspace)), error: run.error }
			basePort ??= await workspacePort(workspace.id)
			if (basePort) this.ports.set(workspace.id, basePort)
			// Configured and producer-advertised URLs win. Conductor's Open controls
			// supply an exact AXURL when available and a port-only compatibility path
			// on current builds.
			targets = this.targetsFor(workspace, basePort, run.ports, run.previewUrls)
			primaryPort = targets[0]?.port ?? null
			if (!primaryPort) {
				const rollback = run.changed ? await setRunTask(workspace, false) : null
				const suffix = rollback
					? rollback.ok
						? '; it was stopped again'
						: `; stopping it again also failed: ${rollback.error}`
					: ''
				return {
					ok: false,
					...(await this.state(workspace)),
					task: run.task,
					changed: run.changed,
					error: `Conductor started the task, but no configured or detected preview port was visible${suffix}`
				}
			}
			if (!(await waitForPort(primaryPort, true, PORT_WAIT_MS))) {
				const rollback = run.changed ? await setRunTask(workspace, false) : null
				const suffix = rollback
					? rollback.ok
						? '; it was stopped again'
						: `; stopping it again also failed: ${rollback.error}`
					: ''
				return {
					ok: false,
					...(await this.state(workspace)),
					task: run.task,
					changed: run.changed,
					error: `${run.task ?? 'Run task'} started, but nothing listened on :${primaryPort}${suffix}`
				}
			}
			try {
				await this.forwardAll(workspace.id, basePort, targets)
				return { ok: true, ...(await this.state(workspace)), task: run.task, changed: run.changed }
			} catch (err) {
				try {
					await this.release(workspace.id)
				} catch {
					// The original forwarding failure remains the actionable error. Any
					// receipt cleanup failure stays persisted for the next relay start.
				}
				const rollback = run.changed ? await setRunTask(workspace, false) : null
				const suffix = rollback
					? rollback.ok
						? '; it was stopped again'
						: `; stopping it again also failed: ${rollback.error}`
					: ''
				return {
					ok: false,
					...(await this.state(workspace)),
					task: run.task,
					changed: run.changed,
					error: `${err instanceof Error ? err.message : String(err)}${suffix}`
				}
			}
		})
	}

	stop(workspace: Workspace): Promise<DevServerResult> {
		return this.exclusive(workspace, async () => {
			const before = await this.state(workspace)
			const run = await setRunTask(workspace, false)
			if (!run.ok) return { ok: false, ...before, error: run.error }
			let cleanupError: unknown
			try {
				await this.release(workspace.id)
			} catch (err) {
				cleanupError = err
			}
			if (before.port && !(await waitForPort(before.port, false, 5000))) {
				return {
					ok: false,
					...(await this.state(workspace)),
					task: run.task,
					changed: run.changed,
					error: `${run.task ?? 'Run task'} stopped, but :${before.port} is still listening`
				}
			}
			if (cleanupError) {
				return {
					ok: false,
					...(await this.state(workspace)),
					task: run.task,
					changed: run.changed,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
				}
			}
			return { ok: true, ...(await this.state(workspace)), task: run.task, changed: run.changed }
		})
	}
}
