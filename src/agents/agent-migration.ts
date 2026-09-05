import fs from 'node:fs'
import path from 'node:path'
import type { AgentDefinition } from '../wire.ts'
import { decodeAgents, parseAgentFile, serializeAgentFile } from './agent-file.ts'
import { AutoModelConfigStore } from './auto-model/config.ts'
import { RoleStore } from './roles.ts'
import { RoutingConfigStore, routingGlobals } from './routing.ts'

/** Copy once, publishing a complete roster. The two legacy files are never written. */
export function migrateAgents(directory: string): void {
	try {
		if (!fs.lstatSync(directory).isDirectory()) throw new Error('agents must be a directory')
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const root = path.dirname(directory)
	const roles = new RoleStore(path.join(root, 'roles.json')).read()
	// A malformed legacy file must stay repairable, not turn defaults into permanent state.
	if (roles.warning) throw new Error(roles.warning)
	const auto = new AutoModelConfigStore(path.join(root, 'auto-model.json')).read()
	const agents = new Map<string, AgentDefinition>(
		Object.entries(roles.config.roles).map(([name, role]) => [name, { name, ...role }])
	)
	for (const { id, description, ...tuple } of auto.profiles) {
		const role = agents.get(id)
		agents.set(id, { ...(role ?? { name: id, ...tuple }), description })
	}
	const config = decodeAgents({ version: 1, agents: [...agents.values()] })
	fs.mkdirSync(root, { recursive: true })
	const staging = fs.mkdtempSync(path.join(root, '.agents-migration-'))
	try {
		for (const { name, preamble = '', ...fields } of config.agents) {
			fs.writeFileSync(path.join(staging, `${name}.md`), serializeAgentFile(parseAgentFile(''), fields, preamble), {
				mode: 0o600
			})
		}
		const routingFile = path.join(root, 'routing.json')
		// A prior interrupted migration may have published the globals already.
		if (!fs.existsSync(routingFile)) new RoutingConfigStore(routingFile).write(routingGlobals(auto))
		try {
			fs.renameSync(staging, directory)
		} catch (error) {
			if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
			// Another relay finished the same copy while this process prepared its files.
			if (!fs.lstatSync(directory).isDirectory()) throw error
		}
	} finally {
		fs.rmSync(staging, { recursive: true, force: true })
	}
}
