import { isUtf8 } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../config.ts'
import type { AgentDefinition, AgentsConfig, RolesConfig, RoutingConfig } from '../wire.ts'
import {
	type AgentFile,
	decodeAgent,
	decodeAgents,
	MAX_AGENTS,
	parseAgentFile,
	serializeAgentFile
} from './agent-file.ts'
import { migrateAgents } from './agent-migration.ts'
import { decodeAutoModelConfig } from './auto-model/config.ts'
import type { AutoModelConfig } from './auto-model/types.ts'
import { decodeRoles, type RoleStoreRead, type RoleStoreWrite } from './roles.ts'
import {
	agentProfiles,
	assertRoutingFallback,
	decodeRoutingConfig,
	RoutingConfigStore,
	routingGlobals
} from './routing.ts'

export interface AgentStoreRead extends AgentsConfig {
	warning?: string
}

export type AgentStoreWrite = { ok: true; config: AgentStoreRead } | { ok: false; error: string }

interface StoredFile {
	agent: AgentDefinition
	file: AgentFile
	source: string
}

interface Snapshot {
	files: Map<string, StoredFile>
	warning?: string
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function agentsRoles(agents: AgentDefinition[]): RolesConfig {
	return {
		version: 1,
		roles: Object.fromEntries(
			agents.map(({ name, model, effort, fast, preamble }) => [
				name,
				{ model, ...(effort ? { effort } : {}), ...(fast !== undefined ? { fast } : {}), preamble: preamble ?? '' }
			])
		)
	}
}

/** One canonical directory, with legacy method shapes for unchanged runtime consumers. */
export class AgentStore {
	private readonly directory: string
	private readonly routingStore: RoutingConfigStore
	private cache: Snapshot | undefined
	private cacheStamp: string | undefined

	readonly roles = {
		read: (): RoleStoreRead => this.readRoles(),
		write: (raw: unknown): RoleStoreWrite => this.writeRoles(raw)
	}
	readonly autoModel = {
		read: (): AutoModelConfig => this.readAutoModel(),
		write: (raw: unknown): AutoModelConfig => this.writeAutoModel(raw)
	}
	readonly routing = {
		read: (): RoutingConfig => this.readRouting(),
		write: (raw: unknown): RoutingConfig => this.writeRouting(raw)
	}

	constructor(directory = path.join(stateDir(), 'agents')) {
		this.directory = directory
		this.routingStore = new RoutingConfigStore(path.join(path.dirname(directory), 'routing.json'))
	}

	private inspect(): { stamp: string; names: string[] } {
		migrateAgents(this.directory)
		const names = fs
			.readdirSync(this.directory)
			.filter(name => name.endsWith('.md'))
			.sort()
		const stamps = [this.directory, ...names.map(name => path.join(this.directory, name))].map(file => {
			const stat = fs.lstatSync(file)
			return `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.mode}`
		})
		return { stamp: stamps.join('\n'), names }
	}

	private snapshot(): Snapshot {
		try {
			const { stamp, names } = this.inspect()
			if (this.cache && this.cacheStamp === stamp) return this.cache
			const files = new Map<string, StoredFile>()
			const warnings: string[] = []
			for (const filename of names) {
				try {
					if (files.size >= MAX_AGENTS) throw new Error(`agents must contain at most ${MAX_AGENTS} entries`)
					const filePath = path.join(this.directory, filename)
					if (!fs.lstatSync(filePath).isFile()) throw new Error('agent definitions must be regular files')
					const bytes = fs.readFileSync(filePath)
					// Decoding with replacement characters would corrupt opaque frontmatter
					// on the next save, violating the byte-for-byte preservation contract.
					if (!isUtf8(bytes)) throw new Error('agent definitions must be valid UTF-8')
					const source = bytes.toString('utf8')
					const file = parseAgentFile(source)
					const agent = decodeAgent({ name: filename.slice(0, -3), ...file.fields, preamble: file.body })
					files.set(agent.name, { agent, file, source })
				} catch (error) {
					warnings.push(`Could not read ${filename}: ${message(error)}`)
				}
			}
			this.cache = { files, ...(warnings.length ? { warning: warnings.join('\n') } : {}) }
			this.cacheStamp = stamp
			return this.cache
		} catch (error) {
			// Don't cache inspection failures: permissions or migration can be repaired externally.
			this.cache = undefined
			this.cacheStamp = undefined
			return { files: new Map(), warning: `Could not read agents: ${message(error)}` }
		}
	}

	read(): AgentStoreRead {
		const stored = this.snapshot()
		return {
			version: 1,
			agents: [...stored.files.values()].map(({ agent }) => ({ ...agent })),
			...(stored.warning ? { warning: stored.warning } : {})
		}
	}

	readRoles(): RoleStoreRead {
		const { agents, warning } = this.read()
		return { config: agentsRoles(agents), ...(warning ? { warning } : {}) }
	}

	private editable(): Snapshot {
		const stored = this.snapshot()
		// A whole-roster PATCH cannot represent undecodable files. Refuse the batch
		// rather than interpreting their omission as permission to delete or replace them.
		if (stored.warning) throw new Error(`${stored.warning}\nRepair the agent files before saving.`)
		return stored
	}

	/** Validate and render the entire batch before the first per-file atomic replacement. */
	private persist(agents: AgentDefinition[], stored: Snapshot, routing?: RoutingConfig): void {
		decodeAgents({ version: 1, agents })
		const replacements = agents.flatMap(({ name, preamble = '', model, effort, fast, description, routing }) => {
			const previous = stored.files.get(name)
			const contents = serializeAgentFile(
				previous?.file ?? parseAgentFile(''),
				{ model, effort, fast, description, routing },
				preamble
			)
			return contents === previous?.source ? [] : [{ file: path.join(this.directory, `${name}.md`), contents }]
		})
		const names = new Set(agents.map(agent => agent.name))
		const removed = [...stored.files.keys()].filter(name => !names.has(name))
		const staged: Array<{ file: string; temporary: string }> = []
		try {
			for (const { file, contents } of replacements) {
				const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
				staged.push({ file, temporary })
				fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
			}
			for (const { file, temporary } of staged) fs.renameSync(temporary, file)
			if (routing) this.routingStore.write(routing)
			for (const name of removed) fs.unlinkSync(path.join(this.directory, `${name}.md`))
		} finally {
			this.cache = undefined
			this.cacheStamp = undefined
			for (const { temporary } of staged) fs.rmSync(temporary, { force: true })
		}
	}

	write(raw: unknown): AgentStoreWrite {
		try {
			const config = decodeAgents(raw)
			this.persist(config.agents, this.editable())
			return { ok: true, config: this.read() }
		} catch (error) {
			return { ok: false, error: message(error) }
		}
	}

	writeRoles(raw: unknown): RoleStoreWrite {
		try {
			const config = decodeRoles(raw)
			const stored = this.editable()
			const agents = Object.entries(config.roles).map(([name, role]) => {
				const previous = stored.files.get(name)?.agent
				return { name, ...role, description: previous?.description, routing: previous?.routing }
			})
			this.persist(agents, stored)
			return { ok: true, config: this.readRoles().config }
		} catch (error) {
			return { ok: false, error: `could not persist roles: ${message(error)}` }
		}
	}

	readRouting(): RoutingConfig {
		migrateAgents(this.directory)
		return this.routingStore.read()
	}

	writeRouting(raw: unknown): RoutingConfig {
		const config = decodeRoutingConfig(raw)
		const agents = [...this.editable().files.values()].map(file => file.agent)
		assertRoutingFallback(config, agents)
		return this.routingStore.write(config)
	}

	readAutoModel(): AutoModelConfig {
		const { agents, warning } = this.read()
		if (warning) throw new Error(`Auto settings could not be read. ${warning}`)
		const routing = this.readRouting()
		assertRoutingFallback(routing, agents)
		return decodeAutoModelConfig({ ...routing, profiles: agentProfiles(agents) })
	}

	writeAutoModel(raw: unknown): AutoModelConfig {
		const config = decodeAutoModelConfig(raw)
		const stored = this.editable()
		const agents = new Map([...stored.files].map(([name, file]) => [name, { ...file.agent }]))
		const profiles = new Set(config.profiles.map(profile => profile.id))
		for (const { id } of agentProfiles([...agents.values()])) {
			if (!profiles.has(id)) {
				const previous = agents.get(id)!
				delete previous.description
			}
		}
		for (const { id, model, effort, fast, description } of config.profiles) {
			const previous = agents.get(id)
			agents.set(id, {
				...previous,
				name: id,
				model,
				effort,
				fast,
				description,
				// Inclusion in a legacy profiles list is an explicit routing opt-in.
				...(previous?.routing === false ? { routing: true } : {})
			})
		}
		const next = [...agents.values()]
		const globals = routingGlobals(config)
		assertRoutingFallback(globals, next)
		this.persist(next, stored, globals)
		return this.readAutoModel()
	}
}
