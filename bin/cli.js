#!/usr/bin/env node
// conductor-remote CLI entrypoint.
//
// Runs on plain Node ≥24 with zero flags: the relay is stdlib-only and the two
// param-property constructors that once needed --experimental-transform-types
// are gone, so default type-stripping handles the .ts sources on import.
//
// The one remaining wrinkle is node:sqlite, still flagged experimental in 24.
// We silence *only* that warning here (instead of re-execing node with
// --disable-warning) so the entrypoint stays a shebang + import.
import { readFileSync } from 'node:fs'

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
		await import('../src/server.ts')
		break
	case 'service':
		// service.ts reads its subcommand from argv[2]; re-shape argv so `service install` → `install`.
		process.argv = [process.argv[0], process.argv[1], ...rest]
		await import('../scripts/service.ts')
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
