#!/usr/bin/env node
// conductor-remote CLI entrypoint.
//
// Runs on plain Node ≥24 with zero flags. The published tarball ships compiled JS
// under dist-node/ (Node REFUSES to type-strip .ts under node_modules, so an
// installed package can't run raw sources); a dev checkout has no dist-node/ and
// runs the .ts sources directly, since type-stripping works outside node_modules.
// resolveEntry() prefers compiled, falls back to source — one entrypoint, both worlds.
//
// The one remaining wrinkle is node:sqlite, still flagged experimental in 24.
// We silence *only* that warning here (instead of re-execing node with
// --disable-warning) so the entrypoint stays a shebang + import.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
	const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type
	if (type === 'ExperimentalWarning') return
	return emitWarning(warning, ...rest)
}

const REQUIRED_MAJOR = 24
const major = Number(process.versions.node.split('.')[0])
if (major < REQUIRED_MAJOR) {
	console.error(
		`conductor-remote needs Node ${REQUIRED_MAJOR}+ (found ${process.versions.node}).\n` +
			'It relies on node:sqlite and default TypeScript type-stripping. Upgrade node and retry.'
	)
	process.exit(1)
}

// Under node_modules (installed package) Node can't type-strip, so run compiled dist-node/; outside it
// (dev checkout) run the live .ts source so edits take effect without a build. Each falls back to the
// other if its preferred artifact is missing.
function resolveEntry(compiledRel, sourceRel) {
	const order = import.meta.url.includes('/node_modules/') ? [compiledRel, sourceRel] : [sourceRel, compiledRel]
	for (const rel of order) {
		const url = new URL(rel, import.meta.url)
		if (existsSync(fileURLToPath(url))) return url.href
	}
	return new URL(order[0], import.meta.url).href
}

const [cmd, ...rest] = process.argv.slice(2)

function version() {
	// Read the installed manifest lazily; semantic-release stamps the real version
	// into it at publish time (the checked-in value is a placeholder).
	const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
	console.info(version)
}

function usage() {
	console.info(
		[
			'conductor-remote — phone control panel for local Conductor agents',
			'',
			'Usage:',
			'  conductor-remote [start]                 run the relay (default)',
			'  conductor-remote service <subcommand>    manage the login LaunchAgent',
			'      install | uninstall | restart | status',
			'  conductor-remote nosleep [duration]      keep this Mac awake (incl. lid-closed) until',
			'                                           Ctrl-C or the duration (e.g. 1h, 90m); needs sudo',
			'  conductor-remote --version               print the installed version',
			'',
			'Install flags (each also settable via the env var in [brackets]):',
			'  --expose public|tailnet   reachability: public Funnel (default) or tailnet-only  [EXPOSE]',
			'  --port <n>                listen port (default 8787)                             [RELAY_PORT]',
			'  --host <addr>             bind address (default 127.0.0.1)                       [RELAY_HOST]',
			'  --token <secret>          pin the shared secret (default: generated + persisted) [RELAY_TOKEN]',
			'  --write-strategy <s>      applescript (default) | sidecar                        [WRITE_STRATEGY]',
			'  --auto-update <mode>      auto (default) | check | off                           [AUTO_UPDATE]',
			'  --db <path>               Conductor state DB                                     [CONDUCTOR_DB]',
			'  --workspaces <path>       worktree root                                          [CONDUCTOR_WORKSPACES]',
			'',
			'e.g.  conductor-remote service install --expose tailnet --port 9000'
		].join('\n')
	)
}

switch (cmd) {
	case undefined:
	case 'start':
		await import(resolveEntry('../dist-node/src/server.js', '../src/server.ts'))
		break
	case 'service':
		// service.ts reads its subcommand from argv[2]; re-shape argv so `service install` → `install`.
		process.argv = [process.argv[0], process.argv[1], ...rest]
		await import(resolveEntry('../dist-node/scripts/service.js', '../scripts/service.ts'))
		break
	case 'nosleep':
		// nosleep.ts reads its optional duration from argv[2]; re-shape argv so `nosleep 1h` → `1h`.
		process.argv = [process.argv[0], process.argv[1], ...rest]
		await import(resolveEntry('../dist-node/scripts/nosleep.js', '../scripts/nosleep.ts'))
		break
	case '-v':
	case '--version':
	case 'version':
		version()
		break
	case '-h':
	case '--help':
	case 'help':
		usage()
		break
	default:
		console.error(`unknown command: ${cmd}\n`)
		usage()
		process.exit(1)
}
