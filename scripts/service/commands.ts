import { config } from './configuration.ts'
import { FLAG_ENV } from './flags.ts'
import { install, restart, uninstall } from './installation.ts'
import { logs, status } from './presentation.ts'

export function runServiceCommand(): void {
	const cmd = process.argv[2] ?? 'status'
	switch (cmd) {
		case 'install':
			install()
			break
		case 'uninstall':
			uninstall()
			break
		case 'restart':
			restart()
			break
		case 'status':
			status()
			break
		case 'config':
			config()
			break
		case 'logs':
			logs()
			break
		default:
			console.error(
				`unknown command: ${cmd}\n` +
					'usage: service.ts <install|uninstall|restart|status|config|logs> [flags]\n' +
					`  flags (install): ${Object.keys(FLAG_ENV).join(', ')}`
			)
			process.exit(1)
	}
}
