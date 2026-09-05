/**
 * Deploy the relay as a macOS LaunchAgent — the only "deployment" this app has, since it must run
 * on the Mac that runs Conductor (local SQLite DB, git worktrees, and the sidecar unix socket all
 * live there). Installs a per-user agent that starts the relay on login and keeps it alive.
 *
 *   node scripts/service.ts <install|uninstall|status|restart>
 *   (or, once installed globally: `conductor-remote service <...>`)
 *
 * `yarn deploy` builds dist/ first, then runs `install`.
 */
import { applyFlags } from './service/flags.ts'

// Logs owns its -n/--no-follow arguments. All other flags win over ambient env.
if ((process.argv[2] ?? 'status') !== 'logs') applyFlags(process.argv.slice(3))

// Import only after parsing flags: environment.ts freezes the relay/voice ports.
const { runServiceCommand } = await import('./service/commands.ts')
runServiceCommand()
