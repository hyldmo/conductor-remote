import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// The relay (src/server.ts) serves the built `dist/` in production and does its
// own SPA fallback. In dev, Vite serves `web/` with HMR and proxies /api to the
// relay so the phone can hit one origin.
//
// Ports are injected by `scripts/dev.ts` (WEB_PORT / RELAY_PORT) so Conductor
// workspaces can run concurrently on per-workspace ports; both default to the
// classic 5173 / 8787 pair. This `server` block is dev-only — `vite build`
// ignores it, so the prod bundle is unaffected.
const webPort = Number(process.env.WEB_PORT) || 5173
const relayPort = Number(process.env.RELAY_PORT) || 8787

// Baked into the bundle as `__APP_VERSION__` so the running app knows which build it
// is — shown on the Connect sheet beside the relay version, and compared against the
// relay's reported version to force a service-worker update when this client is stale.
// Same package.json the relay reads for its own version (src/autoupdate.ts), so a fresh
// client and the relay report identical strings; a mismatch means the client is behind.
// `0.0.0-development` in a dev checkout (semantic-release stamps the real version at publish).
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
	.version

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appVersion)
	},
	root: 'web',
	// Repo-root `public/` (outside the `web` root) so Conductor's repo-icon lookup —
	// which only scans root-level paths like `public/apple-touch-icon.png` — finds
	// the same assets the PWA serves, with no duplicated icon file.
	publicDir: '../public',
	build: {
		outDir: '../dist',
		emptyOutDir: true
	},
	server: {
		host: true,
		port: webPort,
		strictPort: true,
		proxy: {
			'/api': { target: `http://127.0.0.1:${relayPort}`, changeOrigin: true }
		}
	},
	plugins: [
		react(),
		tailwindcss(),
		VitePWA({
			// `prompt`, not `autoUpdate`: autoUpdate forces skipWaiting + reloads the page
			// the instant a new SW activates, which can interrupt a prompt mid-compose. The
			// ReloadPrompt banner (web/src/components/ReloadPrompt.tsx) applies updates on tap.
			registerType: 'prompt',
			includeAssets: ['icon.svg', 'apple-touch-icon.png'],
			manifest: {
				name: 'Conductor Remote',
				short_name: 'Conductor',
				description: 'Monitor and drive your local Conductor agents from your phone.',
				start_url: '/',
				scope: '/',
				display: 'standalone',
				orientation: 'portrait',
				background_color: '#0a0b0e',
				theme_color: '#0a0b0e',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
					{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
					{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }
				]
			},
			workbox: {
				// Push + notification-click handlers. Workbox owns sw.js in generateSW mode, so this
				// is the seam for adding listeners to it (see public/push-sw.js). The file is also
				// precached, which is what makes an edit to it change sw.js and actually ship.
				importScripts: ['/push-sw.js'],
				navigateFallback: '/index.html',
				// Never cache the token-gated API — it must always hit the live relay.
				navigateFallbackDenylist: [/^\/api\//],
				// Claim open pages the moment a new worker activates. Still prompt-mode
				// (skipWaiting stays gated behind ReloadPrompt's SKIP_WAITING message), but
				// once the user taps Update the activated worker takes control of this page,
				// so `controllerchange` fires and the reload lands — iOS otherwise leaves the
				// new worker active-but-not-controlling and the tap looks like a no-op.
				clientsClaim: true,
				// Drop prior-build precache entries when a new SW activates, so a stale shell
				// can't linger and re-serve old hashed assets.
				cleanupOutdatedCaches: true,
				runtimeCaching: []
			}
		})
	]
})
