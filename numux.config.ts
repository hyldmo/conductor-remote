import net from 'node:net'
import { defineConfig } from 'numux'

// `yarn dev` — the Vite dev server (HMR PWA) and the relay (API + reads) in one TUI.
// Vite proxies /api → the relay so the phone hits a single origin.
//
// Dev-only per-workspace ports: inside a Conductor workspace, $CONDUCTOR_PORT is
// unique per workspace, so several `yarn dev`s can run concurrently. Vite (the
// origin a browser/phone opens) takes that port; the relay gets a free ephemeral
// port and Vite proxies /api to it on loopback. Outside Conductor, fall back to
// the classic 5173 (web) / 8787 (relay) pair. Prod (`yarn start`/`deploy`/the
// LaunchAgent) never runs through here, so its Tailscale bind and RELAY_PORT
// default stay untouched — this clutters neither the prod path nor the build.
//
// The port is resolved here rather than by a `port` process feeding `$port.PORT` to the
// other two, because `node --watch` restarts the relay in place: a relay that came back
// on a freshly picked port would leave Vite proxying /api at the old one.

/** Ask the OS for an unused TCP port so a Conductor workspace's relay never collides. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as net.AddressInfo
			srv.close(() => resolve(port))
		})
	})
}

const conductorPort = Number(process.env.CONDUCTOR_PORT) || 0
const webPort = conductorPort || 5173
// Loopback bind + Vite proxy target must match; only prod auto-binds the Tailscale NIC.
const relayPort = conductorPort ? await freePort() : 8787
const voicePort = process.env.VOICE_PORT ?? String(conductorPort ? await freePort() : 8788)

export default defineConfig({
	processes: {
		// Relay first: it is the tab printing the URL worth opening (Vite's origin plus the
		// token), and whatever reads this output for a link should meet that one first.
		//
		// Neither process waits on the other — Vite proxies /api, and a proxied request made
		// before the relay is up just fails until it is — so no dependsOn and no readyPattern.
		relay: {
			// `node --watch` owns the reload, so this process needs no numux `watch`.
			command: 'node --watch bin/cli.js',
			// RELAY_DEV + WEB_PORT tell the relay that Vite is serving the PWA in front of it: it
			// drops the `dist/` warning for a build this path never reads and prints Vite's URL,
			// with the token, in place of its own (src/config.ts, src/server.ts ▸ listen).
			env: {
				RELAY_PORT: String(relayPort),
				VOICE_PORT: voicePort,
				RELAY_HOST: process.env.RELAY_HOST ?? '127.0.0.1',
				RELAY_DEV: '1',
				WEB_PORT: String(webPort)
			},
			color: 'cyan'
		},
		web: {
			command: 'yarn dev:web',
			env: { WEB_PORT: String(webPort), RELAY_PORT: String(relayPort) },
			color: 'magenta'
		}
	}
})
