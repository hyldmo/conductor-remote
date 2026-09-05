/**
 * Global delegated-role definitions.
 *
 * Roles are relay preferences, not Conductor state, and therefore live beside the
 * relay's other private JSON files. The decoder is strict on purpose: silently
 * ignoring a hand-written `plan` field would make a role appear safe while still
 * inviting callers to depend on Conductor's currently unreliable Plan mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../config.ts'
import { currentModelCatalog, modelAgentType, modelPickerLabel } from '../shared.ts'

export { newestModelSnapshot } from '../shared.ts'

import type {
	AgentEffort,
	CachedModelGroup,
	DelegatedRole,
	DelegationError,
	ResolvedDelegatedRole,
	RolesConfig
} from '../wire.ts'

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/
const MAX_ROLES = 32
const MAX_MODEL_LENGTH = 256
const MAX_PREAMBLE_LENGTH = 50_000
const ROLE_FIELDS = new Set(['model', 'effort', 'fast', 'preamble'])

/**
 * Controls verified against Conductor's provider-specific composer UI.
 *
 * This is intentionally versioned and deliberately contains only providers whose
 * controls have been measured. A provider recognized from its model label but absent
 * here can still be used with its defaults; role configuration must omit controls we
 * cannot prove Conductor can apply and read back.
 */
export const ROLE_CONTROL_CAPABILITIES = {
	version: 1,
	providers: {
		claude: {
			efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
			fast: true
		},
		codex: {
			efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
			fast: true
		}
	}
} as const satisfies {
	version: 1
	providers: Record<string, { efforts: readonly AgentEffort[]; fast: boolean }>
}

const batonPreamble = (role: string): string =>
	`You are the ${role} agent for this workspace. End your final answer with a \`## Baton\` section: Decision, Evidence, Files changed, Risks, Suggested next role.`

export const DEFAULT_ROLES: RolesConfig = {
	version: 1,
	roles: {
		planning: { model: 'Fable 5', effort: 'max', fast: false, preamble: batonPreamble('planning') },
		// Conductor currently offers two distinct Muse Spark rows. This descriptive
		// placeholder intentionally matches neither, so the user must choose exactly.
		exploration: { model: 'Muse Spark', preamble: batonPreamble('exploration') },
		implementation: { model: '5.6 Sol', effort: 'xhigh', fast: false, preamble: batonPreamble('implementation') }
	}
}

export interface RoleStoreRead {
	config: RolesConfig
	warning?: string
}

export type RoleStoreWrite = { ok: true; config: RolesConfig } | { ok: false; error: string }

function object(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function cloneRole(role: DelegatedRole): DelegatedRole {
	return { ...role }
}

function cloneConfig(config: RolesConfig): RolesConfig {
	return {
		version: 1,
		roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, cloneRole(role)]))
	}
}

function decodeRole(name: string, raw: unknown): DelegatedRole {
	if (!ROLE_NAME.test(name)) throw new Error(`invalid role name ${name}`)
	const value = object(raw)
	if (!value) throw new Error(`role ${name} must be an object`)
	const unknown = Object.keys(value).find(field => !ROLE_FIELDS.has(field))
	if (unknown) throw new Error(`role ${name} has unknown field ${unknown}`)
	if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > MAX_MODEL_LENGTH) {
		throw new Error(`role ${name} needs a picker model label`)
	}
	const role: DelegatedRole = { model: modelPickerLabel(value.model.trim()) }
	if (value.effort !== undefined) {
		if (typeof value.effort !== 'string' || !EFFORTS.has(value.effort)) {
			throw new Error(`role ${name} has an invalid effort`)
		}
		role.effort = value.effort as DelegatedRole['effort']
	}
	if (value.fast !== undefined) {
		if (typeof value.fast !== 'boolean') throw new Error(`role ${name} has an invalid fast value`)
		role.fast = value.fast
	}
	if (value.preamble !== undefined) {
		if (typeof value.preamble !== 'string' || value.preamble.length > MAX_PREAMBLE_LENGTH) {
			throw new Error(`role ${name} has an invalid preamble`)
		}
		role.preamble = value.preamble
	}
	return role
}

export function decodeRoles(raw: unknown): RolesConfig {
	const value = object(raw)
	if (!value) throw new Error('roles document must be an object')
	if (value.version !== 1) throw new Error(`unsupported roles version ${String(value.version)}`)
	const roles = object(value.roles)
	if (!roles) throw new Error('roles must be an object')
	const entries = Object.entries(roles)
	if (!entries.length || entries.length > MAX_ROLES) throw new Error(`roles must contain 1-${MAX_ROLES} entries`)
	return { version: 1, roles: Object.fromEntries(entries.map(([name, role]) => [name, decodeRole(name, role)])) }
}

function issue(code: DelegationError['code'], message: string): DelegationError {
	return { code, message, retryable: false }
}

function controlIssue(name: string, role: DelegatedRole, agentType: string): DelegationError | null {
	const controls = ROLE_CONTROL_CAPABILITIES.providers[agentType as keyof typeof ROLE_CONTROL_CAPABILITIES.providers]
	if (role.effort !== undefined && !controls) {
		return issue(
			'invalid_request',
			`Role ${name} must omit effort because this provider's Conductor reasoning control is not verified.`
		)
	}
	if (role.effort !== undefined && controls && !controls.efforts.includes(role.effort as never)) {
		return issue('invalid_request', `Role ${name} cannot use ${role.effort} effort with its configured provider.`)
	}
	if (role.fast !== undefined && !controls?.fast) {
		return issue(
			'invalid_request',
			`Role ${name} must omit Fast mode because this provider's Conductor Fast control is not verified.`
		)
	}
	return null
}

/** Picker validation stays separate from shape decoding so a vanished model remains editable. */
export function roleModelIssues(
	config: RolesConfig,
	groups: CachedModelGroup[]
): Array<{ role: string; error: DelegationError }> {
	const issues: Array<{ role: string; error: DelegationError }> = []
	const models = currentModelCatalog(groups)
	for (const [name, role] of Object.entries(config.roles)) {
		if (!models.includes(modelPickerLabel(role.model))) {
			issues.push({
				role: name,
				error: issue(
					'model_missing',
					`Role ${name} needs an exact model from Conductor's current picker catalog; update it in the role editor.`
				)
			})
			continue
		}
		const agentType = modelAgentType(role.model)
		if (!agentType) {
			issues.push({
				role: name,
				error: issue('provider_unknown', `Role ${name}'s model label does not identify a supported provider.`)
			})
			continue
		}
		const invalidEffort = controlIssue(name, role, agentType)
		if (invalidEffort) issues.push({ role: name, error: invalidEffort })
	}
	return issues
}

export type ResolveRoleResult = { ok: true; role: ResolvedDelegatedRole } | { ok: false; error: DelegationError }

/** Resolve and freeze the provider encoded by an exact cached picker label. */
export function resolveRole(config: RolesConfig, name: string, groups: CachedModelGroup[]): ResolveRoleResult {
	if (!Object.hasOwn(config.roles, name)) {
		return { ok: false, error: issue('role_not_found', `Unknown delegated role ${name}.`) }
	}
	const role = config.roles[name]
	if (!currentModelCatalog(groups).includes(modelPickerLabel(role.model))) {
		return {
			ok: false,
			error: issue(
				'model_missing',
				`Role ${name} needs an exact model from Conductor's current picker catalog; update it in the role editor.`
			)
		}
	}
	const agentType = modelAgentType(role.model)
	if (!agentType) {
		return {
			ok: false,
			error: issue('provider_unknown', `Role ${name}'s model label does not identify a supported provider.`)
		}
	}
	const invalidEffort = controlIssue(name, role, agentType)
	if (invalidEffort) return { ok: false, error: invalidEffort }
	return { ok: true, role: { ...cloneRole(role), agentType } }
}

/** Cached, process-local store. A rejected write leaves both memory and disk untouched. */
export class RoleStore {
	private readonly file: string
	private cache: RoleStoreRead | null = null
	private cacheStamp: string | null | undefined

	constructor(file = path.join(stateDir(), 'roles.json')) {
		this.file = file
	}

	private fileStamp(): string | null {
		try {
			const stat = fs.statSync(this.file)
			return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw err
		}
	}

	read(): RoleStoreRead {
		let stamp: string | null
		try {
			stamp = this.fileStamp()
		} catch (err) {
			stamp = null
			this.cache = {
				config: cloneConfig(DEFAULT_ROLES),
				warning: `Could not inspect roles.json: ${err instanceof Error ? err.message : String(err)}`
			}
			this.cacheStamp = undefined
			return { ...this.cache, config: cloneConfig(this.cache.config) }
		}
		if (this.cache && this.cacheStamp === stamp) return { ...this.cache, config: cloneConfig(this.cache.config) }
		try {
			this.cache = { config: decodeRoles(JSON.parse(fs.readFileSync(this.file, 'utf8'))) }
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.cache = { config: cloneConfig(DEFAULT_ROLES) }
			else {
				this.cache = {
					config: cloneConfig(DEFAULT_ROLES),
					warning: `Could not read roles.json: ${err instanceof Error ? err.message : String(err)}`
				}
			}
		}
		this.cacheStamp = stamp
		return { ...this.cache, config: cloneConfig(this.cache.config) }
	}

	write(raw: unknown): RoleStoreWrite {
		let config: RolesConfig
		try {
			config = decodeRoles(raw)
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
		const directory = path.dirname(this.file)
		const temporary = `${this.file}.${process.pid}.tmp`
		try {
			fs.mkdirSync(directory, { recursive: true })
			fs.writeFileSync(temporary, `${JSON.stringify(config, null, '\t')}\n`, { mode: 0o600 })
			fs.chmodSync(temporary, 0o600)
			fs.renameSync(temporary, this.file)
		} catch (err) {
			try {
				fs.unlinkSync(temporary)
			} catch {}
			return { ok: false, error: `could not persist roles: ${err instanceof Error ? err.message : String(err)}` }
		}
		this.cache = { config }
		this.cacheStamp = this.fileStamp()
		return { ok: true, config: cloneConfig(config) }
	}
}
