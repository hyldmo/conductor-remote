import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createDevProxy, DevServerController, parseWorkspacePort, serveProxyAt } from '../src/dev-server.ts'
import { type PreviewTarget, parsePreviewUrlsToml, resolvePreviewTargets } from '../src/preview-urls.ts'
import type { Workspace } from '../src/reads.ts'
import type { ServeStatus } from '../src/tailscale.ts'

const closeAfter: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closeAfter.splice(0).map(close => close()))
})

function listen(server: http.Server | net.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') return reject(new Error('test server did not bind to TCP'))
			resolve(address.port)
		})
	})
}

function closeServer(server: http.Server | net.Server): Promise<void> {
	return new Promise(resolve => server.close(() => resolve()))
}

describe('workspace port discovery', () => {
	test('accepts one exact workspace id and one valid port', () => {
		const snapshot = [
			'node app OTHER=1 CONDUCTOR_WORKSPACE_ID=other CONDUCTOR_PORT=4100',
			'node app CONDUCTOR_WORKSPACE_ID=workspace-1 CONDUCTOR_PORT=55300 TOKEN=secret',
			'child CONDUCTOR_WORKSPACE_ID=workspace-1 CONDUCTOR_PORT=55300'
		].join('\n')
		expect(parseWorkspacePort(snapshot, 'workspace-1')).toBe(55300)
		expect(parseWorkspacePort(snapshot, 'workspace')).toBeNull()
	})

	test('refuses ambiguous or invalid ports', () => {
		expect(
			parseWorkspacePort(
				'one CONDUCTOR_WORKSPACE_ID=workspace-1 CONDUCTOR_PORT=55300\n' +
					'two CONDUCTOR_WORKSPACE_ID=workspace-1 CONDUCTOR_PORT=55301',
				'workspace-1'
			)
		).toBeNull()
		expect(parseWorkspacePort('one CONDUCTOR_WORKSPACE_ID=workspace-1 CONDUCTOR_PORT=99999', 'workspace-1')).toBeNull()
	})
})

describe('configured preview URLs', () => {
	test('reads Conductor array tables and their optional names', () => {
		const config = `
[scripts]
run = "yarn dev"

[[preview_urls]]
name = "Web"
url = "http://localhost:$CONDUCTOR_PORT/app#today"

[[preview_urls]] # a fixed companion service
name = 'Storybook'
url = 'http://127.0.0.1:6006/'
`
		expect(parsePreviewUrlsToml(config)).toEqual([
			{ name: 'Web', url: 'http://localhost:$CONDUCTOR_PORT/app#today' },
			{ name: 'Storybook', url: 'http://127.0.0.1:6006/' }
		])
	})

	test('accepts the inline-array form and distinguishes absent from empty', () => {
		expect(
			parsePreviewUrlsToml(`preview_urls = [
				{ name = "Web", url = "http://localhost:$CONDUCTOR_PORT" },
				{ url = 'http://localhost:6006' }
			]`)
		).toEqual([
			{ name: 'Web', url: 'http://localhost:$CONDUCTOR_PORT' },
			{ name: undefined, url: 'http://localhost:6006' }
		])
		expect(parsePreviewUrlsToml('preview_urls = []')).toEqual([])
		expect(parsePreviewUrlsToml('[scripts]\nrun = "yarn dev"')).toBeNull()
	})

	test('expands the allocated port and keeps only valid loopback HTTP previews', () => {
		expect(
			resolvePreviewTargets(
				[
					{ name: 'Web', url: `http://localhost:\${CONDUCTOR_PORT}/app?q=1#top` },
					{ name: 'Other path', url: `http://localhost:\${CONDUCTOR_PORT}/other` },
					{ url: 'http://127.0.0.1:6006/' },
					{ name: 'Duplicate', url: 'http://127.0.0.1:6006/' },
					{ name: 'Remote', url: 'https://example.com:3000/' },
					{ name: 'TLS', url: 'https://localhost:3443/' },
					{ name: 'Unknown', url: 'http://localhost:$OTHER_PORT/' }
				],
				55300
			)
		).toEqual([
			{ name: 'Web', port: 55300, path: '/app?q=1#top' },
			{ name: 'Other path', port: 55300, path: '/other' },
			{ name: 'Port 6006', port: 6006, path: '/' }
		])
	})

	test('forwards every named port and reuses one bridge for two paths', async () => {
		const first = http.createServer((_req, res) => res.end('first'))
		const second = http.createServer((_req, res) => res.end('second'))
		const firstPort = await listen(first)
		const secondPort = await listen(second)
		closeAfter.push(
			() => closeServer(first),
			() => closeServer(second)
		)

		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-previews-'))
		closeAfter.push(async () => fs.rmSync(temp, { recursive: true, force: true }))
		const store = path.join(temp, 'forwards.json')
		const controller = new DevServerController(store)
		const targets: PreviewTarget[] = [
			{ name: 'App', port: firstPort, path: '/app' },
			{ name: 'Admin', port: firstPort, path: '/admin' },
			{ name: 'Storybook', port: secondPort, path: '/' }
		]
		const status: ServeStatus = { TCP: {}, Web: {} }
		type Harness = {
			bin: string | null
			host: string | null
			portFor: () => Promise<number | null>
			targetsFor: () => PreviewTarget[]
			serveStatus: () => Promise<ServeStatus>
			setServe: (servePort: number, bridgePort: number) => Promise<void>
			unsetServe: (record: { servePort: number }) => Promise<void>
			release: (workspaceId: string) => Promise<void>
		}
		const harness = controller as unknown as Harness
		harness.bin = 'test-tailscale'
		harness.host = 'test.ts.net'
		harness.portFor = async () => null
		harness.targetsFor = () => targets.map(target => ({ ...target }))
		harness.serveStatus = async () => status
		harness.setServe = async (servePort, bridgePort) => {
			status.TCP ??= {}
			status.Web ??= {}
			status.TCP[String(servePort)] = { HTTPS: true }
			status.Web[`test.ts.net:${servePort}`] = {
				Handlers: { '/': { Proxy: `http://127.0.0.1:${bridgePort}` } }
			}
		}
		harness.unsetServe = async record => {
			delete status.TCP?.[String(record.servePort)]
			delete status.Web?.[`test.ts.net:${record.servePort}`]
		}

		try {
			const result = await controller.start({ id: 'workspace-multi' } as Workspace)
			expect(result.ok).toBe(true)
			expect(result.forwards).toEqual([
				{
					name: 'App',
					port: firstPort,
					running: true,
					forwarded: true,
					url: `https://test.ts.net:${firstPort}/app`
				},
				{
					name: 'Admin',
					port: firstPort,
					running: true,
					forwarded: true,
					url: `https://test.ts.net:${firstPort}/admin`
				},
				{
					name: 'Storybook',
					port: secondPort,
					running: true,
					forwarded: true,
					url: `https://test.ts.net:${secondPort}/`
				}
			])
			const receipt = JSON.parse(fs.readFileSync(store, 'utf8')) as { forwards: unknown[] }
			expect(receipt.forwards).toHaveLength(2)
		} finally {
			await harness.release('workspace-multi')
		}
	})
})

describe('dev-server bridge', () => {
	test('rewrites public origins for strict local dev servers and publicises redirects', async () => {
		let targetPort = 0
		const upstream = http.createServer((req, res) => {
			res.writeHead(302, {
				'content-type': 'application/json',
				location: `http://localhost:${targetPort}/next`
			})
			res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin, referer: req.headers.referer }))
		})
		targetPort = await listen(upstream)
		closeAfter.push(() => closeServer(upstream))
		const proxy = await createDevProxy(targetPort)
		closeAfter.push(proxy.close)

		const response = await fetch(`http://127.0.0.1:${proxy.port}/from?q=1`, {
			headers: {
				host: 'dev-mac.example.ts.net:55300',
				origin: 'https://dev-mac.example.ts.net:55300',
				referer: 'https://dev-mac.example.ts.net:55300/from?q=1',
				'x-forwarded-host': 'dev-mac.example.ts.net:55300',
				'x-forwarded-proto': 'https'
			},
			redirect: 'manual'
		})
		const body = (await response.json()) as Record<string, string>
		expect(body).toEqual({
			host: `127.0.0.1:${targetPort}`,
			origin: `http://127.0.0.1:${targetPort}`,
			referer: `http://127.0.0.1:${targetPort}/from?q=1`
		})
		expect(response.headers.get('location')).toBe('https://dev-mac.example.ts.net:55300/next')
	})

	test('answers a private ownership challenge without reaching the dev server', async () => {
		let upstreamRequests = 0
		const upstream = http.createServer((_req, res) => {
			upstreamRequests++
			res.end('upstream')
		})
		const targetPort = await listen(upstream)
		closeAfter.push(() => closeServer(upstream))
		const proxy = await createDevProxy(targetPort)
		closeAfter.push(proxy.close)

		const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
			headers: { 'x-conductor-remote-bridge': proxy.token }
		})
		expect(response.status).toBe(204)
		expect(upstreamRequests).toBe(0)
	})

	test('passes WebSocket upgrades through with a local Host and Origin', async () => {
		let received = ''
		const upstream = net.createServer(socket => {
			socket.once('data', chunk => {
				received = chunk.toString('utf8')
				socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
			})
		})
		const targetPort = await listen(upstream)
		closeAfter.push(() => closeServer(upstream))
		const proxy = await createDevProxy(targetPort)
		closeAfter.push(proxy.close)

		const response = await new Promise<string>((resolve, reject) => {
			const socket = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
				socket.write(
					'GET /hmr HTTP/1.1\r\n' +
						'Host: dev-mac.example.ts.net:55300\r\n' +
						'Origin: https://dev-mac.example.ts.net:55300\r\n' +
						'Connection: Upgrade\r\n' +
						'Upgrade: websocket\r\n\r\n'
				)
			})
			let body = ''
			socket.on('data', chunk => {
				body += chunk.toString('utf8')
			})
			socket.once('end', () => resolve(body))
			socket.once('error', reject)
		})

		expect(response).toContain('101 Switching Protocols')
		expect(received).toContain(`host: 127.0.0.1:${targetPort}`)
		expect(received).toContain(`origin: http://127.0.0.1:${targetPort}`)
	})

	test('reads only the root proxy for the requested HTTPS port', () => {
		const status = {
			Web: {
				'host.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } },
				'host.ts.net:55300': { Handlers: { '/': { Proxy: 'http://127.0.0.1:60000' } } }
			}
		}
		expect(serveProxyAt(status, 55300)).toBe('http://127.0.0.1:60000')
		expect(serveProxyAt(status, 55301)).toBeNull()
	})
})
