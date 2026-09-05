import fs from 'node:fs'
import type { AgentDefinition, CachedModelGroup, RoutingConfig } from '../wire.ts'
import { atomicJson, autoModelConfigSchema, autoModelIssues } from './auto-model/config.ts'
import type { AutoModelConfig, AutoModelProfile } from './auto-model/types.ts'

const routingSchema = autoModelConfigSchema.omit({ profiles: true })

export function decodeRoutingConfig(raw: unknown): RoutingConfig {
	return routingSchema.parse(raw)
}

export function routingGlobals(config: AutoModelConfig): RoutingConfig {
	const { profiles: _profiles, ...globals } = config
	return decodeRoutingConfig(globals)
}

/** Deliberately excludes the Markdown body: ordinary Auto chats get only a tuple. */
export function agentProfiles(agents: AgentDefinition[]): AutoModelProfile[] {
	return agents.flatMap(({ name, description, model, effort, fast, routing }) =>
		description?.trim() && routing !== false
			? [
					{
						id: name,
						description: description.trim(),
						model,
						...(effort ? { effort } : {}),
						...(fast !== undefined ? { fast } : {})
					}
				]
			: []
	)
}

export function assertRoutingFallback(config: RoutingConfig, agents: AgentDefinition[]): void {
	if (!agentProfiles(agents).some(profile => profile.id === config.fallback))
		throw new Error('Choose an existing fallback profile.')
}

/** Optional profile model issues belong to the agents editor, not the globals panel. */
export function routingIssues(config: RoutingConfig, agents: AgentDefinition[], groups: CachedModelGroup[]): string[] {
	const profiles = agentProfiles(agents).filter(profile => profile.id === config.fallback)
	const issues = autoModelIssues({ ...config, profiles }, groups)
	if (!profiles.length) issues.unshift('Choose an existing fallback profile.')
	return issues
}

export class RoutingConfigStore {
	private readonly file: string
	constructor(file: string) {
		this.file = file
	}
	read(): RoutingConfig {
		try {
			return decodeRoutingConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')))
		} catch (error) {
			throw new Error('Auto settings could not be read. Repair routing.json before using Auto.', { cause: error })
		}
	}
	write(raw: unknown): RoutingConfig {
		const config = decodeRoutingConfig(raw)
		atomicJson(this.file, config)
		return config
	}
}
