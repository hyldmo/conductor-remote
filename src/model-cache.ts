/**
 * Model-picker labels the relay has seen from Conductor.
 *
 * `sessions.model` is the model identifier Conductor saved for a chat. It is
 * useful to confirm a change, but it is not reliably the label that Conductor's
 * picker accepts. Keep the picker labels here instead, keyed by harness, so a
 * new workspace can offer choices before it has a chat of its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { modelPickerLabel } from './shared.ts'

export interface CachedModelGroup {
	/** Harness of the chat where this whole picker menu was observed; not ownership of every row. */
	agentType: string
	models: string[]
	/** The user-wide picker row Conductor last showed with its star selected. */
	defaultModel?: string
	/**
	 * Time of the complete picker observation backing this entry. `null` means
	 * the entry contains only models learned from successful selections. Older
	 * cache files omit this field and are treated as complete snapshots.
	 */
	snapshotAt?: number | null
	updatedAt: number
}

function clean(models: string[]): string[] {
	return [
		...new Set(
			models
				.map(modelPickerLabel)
				.map(model => model.trim())
				.filter(Boolean)
		)
	].sort((a, b) => a.localeCompare(b))
}

function group(agentType: string): string {
	return agentType.trim() || 'unknown'
}

/** A small persisted cache. It contains labels Conductor has offered, never a hard-coded catalog. */
export class ModelCache {
	private readonly file: string
	private entries: CachedModelGroup[]

	constructor(file: string) {
		this.file = file
		this.entries = this.load()
	}

	list(): CachedModelGroup[] {
		return this.entries.map(entry => ({ ...entry, models: [...entry.models] }))
	}

	/** The newest live picker read wins when upgrading from caches that disagree. */
	defaultModel(): string | undefined {
		return [...this.entries].sort((a, b) => b.updatedAt - a.updatedAt).find(entry => entry.defaultModel)?.defaultModel
	}

	/** Record the menu that was read from one chat. An empty or failed read changes nothing. */
	remember(agentType: string | null | undefined, models: string[], defaultModel?: string): void {
		const next = clean(models)
		if (!next.length) return
		const key = group(agentType ?? '')
		const selectedDefault = clean(defaultModel ? [defaultModel] : [])[0] ?? this.defaultModel()
		const now = Date.now()
		const entry: CachedModelGroup = {
			agentType: key,
			// A live menu is authoritative. Replacing its group drops a model Conductor
			// stopped offering instead of leaving a stale choice in a later workspace.
			models: next,
			defaultModel: selectedDefault,
			snapshotAt: now,
			updatedAt: now
		}
		this.entries = [...this.entries.filter(existing => existing.agentType !== key), entry]
			.map(existing => ({ ...existing, defaultModel: selectedDefault ?? existing.defaultModel }))
			.sort((a, b) => a.agentType.localeCompare(b.agentType))
		this.save()
	}

	/** A model that Conductor accepted is also a useful choice for a later workspace. */
	rememberModel(agentType: string | null | undefined, model: string | null | undefined): void {
		if (!model) return
		const key = group(agentType ?? '')
		const current = this.entries.find(entry => entry.agentType === key)
		const entry: CachedModelGroup = {
			agentType: key,
			models: clean([...(current?.models ?? []), model]),
			defaultModel: current?.defaultModel ?? this.defaultModel(),
			// Selecting one row proves that row, not the rest of the picker. Preserve
			// an existing whole-menu observation but mark a brand-new group partial.
			snapshotAt: current ? (current.snapshotAt === undefined ? current.updatedAt : current.snapshotAt) : null,
			updatedAt: Date.now()
		}
		this.entries = [...this.entries.filter(existing => existing.agentType !== key), entry].sort((a, b) =>
			a.agentType.localeCompare(b.agentType)
		)
		this.save()
	}

	/** A successful star press is authoritative for every harness's copy of the same picker. */
	rememberDefault(model: string): void {
		const selected = clean([model])[0]
		if (!selected) return
		this.entries = this.entries.map(entry => ({ ...entry, defaultModel: selected }))
		this.save()
	}

	private load(): CachedModelGroup[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CachedModelGroup[]
			if (!Array.isArray(parsed)) return []
			return parsed
				.filter(entry => typeof entry?.agentType === 'string' && Array.isArray(entry.models))
				.map(entry => {
					const snapshotAt = Object.hasOwn(entry, 'snapshotAt')
						? entry.snapshotAt === null
							? null
							: Number.isFinite(entry.snapshotAt)
								? Number(entry.snapshotAt)
								: null
						: undefined
					return {
						agentType: group(entry.agentType),
						models: clean(entry.models.filter((model): model is string => typeof model === 'string')),
						defaultModel:
							typeof entry.defaultModel === 'string' ? clean([entry.defaultModel])[0] || undefined : undefined,
						...(snapshotAt === undefined ? {} : { snapshotAt }),
						updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
					}
				})
				.filter(entry => entry.models.length)
		} catch {
			return []
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true })
			fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
		} catch (err) {
			console.warn(`[relay] could not persist model cache: ${err instanceof Error ? err.message : err}`)
		}
	}
}
