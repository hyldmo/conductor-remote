import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { currentModelCatalog, modelAgentType } from '../../shared.ts'
import type { CachedModelGroup } from '../../wire.ts'
import { roleModelIssues } from '../roles.ts'
import type { AutoModelConfig, AutoModelTuple } from './types.ts'

export const AUTO_ROUTING_RULES = `Choose the least expensive suitable profile for the actual task, using scope, ambiguity, consequences, and required context rather than prompt length.
Explicit local edits, copy, and mechanical changes favor quick. Bounded UI/features with known patterns favor standard. Read-only searches and focused exploration favor exploration. Unknown causes, coupled state, integration debugging, and multi-module work favor complex. Reserve deep for concrete difficult concurrency, recovery invariants, authorization boundaries, destructive migrations, or major system changes. Product and architecture tradeoffs favor design when that profile is present; critical correctness boundaries still favor deep.
Screenshots and forked handoffs are part of the task. Report missing essential context rather than assuming it is easy. General uncertainty alone is not a reason to select deep. Ignore instruction boilerplate and historical model selections.`

export const DEFAULT_AUTO_MODEL_CONFIG: AutoModelConfig = {
	version: 1,
	defaultAuto: false,
	router: { model: '5.6 Luna', effort: 'low', fast: false },
	profiles: [
		{
			id: 'quick',
			model: '5.6 Luna',
			effort: 'low',
			fast: false,
			description: 'Small explicit local edits, copy, and mechanical changes.'
		},
		{
			id: 'exploration',
			model: 'opencode-go/muse-spark-1.3-contributor',
			description: 'Inexpensive read-only code searches, lookups, and focused exploration.'
		},
		{
			id: 'standard',
			model: '5.6 Terra',
			effort: 'medium',
			fast: false,
			description: 'Bounded UI work, conventional features, and ordinary bugs.'
		},
		{
			id: 'complex',
			model: '5.6 Sol',
			effort: 'high',
			fast: false,
			description: 'Diagnosis, integrations, and multiple interacting modules.'
		},
		{
			id: 'deep',
			model: 'GPT-6 Astra',
			effort: 'high',
			fast: false,
			description: 'Difficult concurrency, recovery, authorization, migrations, and major architecture.'
		},
		{
			id: 'design',
			model: 'Fable 5.1',
			effort: 'high',
			fast: false,
			description: 'Product exploration and architecture tradeoffs.'
		}
	],
	fallback: 'complex',
	rules: AUTO_ROUTING_RULES,
	timeoutMs: 15_000
}

const tuple = z
	.object({
		model: z.string().trim().min(1).max(256),
		effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).optional(),
		fast: z.boolean().optional()
	})
	.strict()
export const autoModelConfigSchema = z
	.object({
		version: z.literal(1),
		defaultAuto: z.boolean(),
		router: tuple,
		profiles: z
			.array(
				tuple
					.extend({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), description: z.string().trim().min(1).max(1000) })
					.strict()
			)
			.min(1)
			// The canonical agent directory can contribute every one of its 32 files.
			.max(32),
		fallback: z.string(),
		rules: z.string().max(12_000),
		timeoutMs: z.number().int().min(2000).max(30_000)
	})
	.strict()

export function decodeAutoModelConfig(raw: unknown): AutoModelConfig {
	const config = autoModelConfigSchema.parse(raw)
	if (new Set(config.profiles.map(p => p.id)).size !== config.profiles.length)
		throw new Error('Profile names must be unique.')
	if (!config.profiles.some(p => p.id === config.fallback)) throw new Error('Choose an existing fallback profile.')
	return config
}

export function routerProvider(router: AutoModelTuple): 'codex' | 'opencode' | null {
	if (
		modelAgentType(router.model) === 'codex' &&
		/^(?:GPT-)?\d[\d.]*(?: (?:Luna|Terra|Sol|Astra))?$/.test(router.model)
	)
		return 'codex'
	if (/^opencode(?:-go)?\/muse-spark-[a-z0-9.-]+(?:-contributor)(?:-free)?$/.test(router.model)) return 'opencode'
	return null
}

export function autoModelIssues(config: AutoModelConfig, groups: CachedModelGroup[]): string[] {
	const roles = Object.fromEntries([
		['router', config.router],
		...config.profiles.map(({ id, description: _description, ...role }) => [`profile_${id}`, role])
	])
	const issues = roleModelIssues({ version: 1, roles }, groups).map(issue => issue.error.message)
	if (!routerProvider(config.router))
		issues.unshift('The router supports Codex models and the exact Muse Spark OpenCode options.')
	if (config.router.effort === 'ultracode') issues.unshift('The router CLI supports reasoning effort up to max.')
	return issues
}

/** Optional profiles can disappear from a picker; the router and fallback must remain available. */
export function freezeAutoModelConfig(config: AutoModelConfig, groups: CachedModelGroup[]): AutoModelConfig {
	const catalog = currentModelCatalog(groups)
	const frozen = structuredClone(config)
	frozen.profiles = frozen.profiles.filter(profile => catalog.includes(profile.model))
	if (!frozen.profiles.some(profile => profile.id === frozen.fallback))
		throw new Error('Auto’s fallback model is unavailable. Update Auto settings.')
	const issues = autoModelIssues(frozen, groups)
	if (issues.length) throw new Error(issues[0])
	return frozen
}

export function atomicJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporary = `${file}.${process.pid}.tmp`
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`, { mode: 0o600 })
		fs.renameSync(temporary, file)
	} finally {
		fs.rmSync(temporary, { force: true })
	}
}

/** Legacy JSON store retained for migration. Runtime consumers use AgentStore.autoModel. */
export class AutoModelConfigStore {
	private readonly file: string
	constructor(file: string) {
		this.file = file
	}
	read(): AutoModelConfig {
		try {
			return decodeAutoModelConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_AUTO_MODEL_CONFIG)
			throw new Error('Auto settings could not be read. Repair auto-model.json before using Auto.', { cause: error })
		}
	}
	write(raw: unknown): AutoModelConfig {
		const config = decodeAutoModelConfig(raw)
		atomicJson(this.file, config)
		return config
	}
}
