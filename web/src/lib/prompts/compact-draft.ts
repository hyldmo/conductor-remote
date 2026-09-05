const KEY = 'conductor-remote-compact-drafts'

/** A chat's next send can start fresh context using this transcript cut. */
export interface CompactDraft {
	thinking: boolean
	tools: boolean
	through?: number
	only?: number
}

export const DEFAULT_COMPACT: CompactDraft = { thinking: true, tools: false }

export function sameCompactDraft(a: CompactDraft | undefined, b: CompactDraft): boolean {
	return !!a && a.thinking === b.thinking && a.tools === b.tools && a.through === b.through && a.only === b.only
}

export function compactDraftLabel(format: CompactDraft): string {
	return format.only
		? 'Last message only'
		: format.tools
			? 'Full transcript'
			: format.thinking
				? 'With reasoning'
				: 'Concise'
}

export function loadCompactDrafts(): Record<string, CompactDraft> {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
		if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
		const drafts: Record<string, CompactDraft> = {}
		for (const [id, value] of Object.entries(saved)) {
			if (
				!value ||
				typeof value !== 'object' ||
				typeof value.thinking !== 'boolean' ||
				typeof value.tools !== 'boolean'
			)
				continue
			const { thinking, tools, through, only } = value
			if ([through, only].some(row => row !== undefined && (!Number.isSafeInteger(row) || row < 1))) continue
			if (through !== undefined && only !== undefined) continue
			drafts[id] = {
				thinking,
				tools,
				...(through === undefined ? {} : { through }),
				...(only === undefined ? {} : { only })
			}
		}
		return drafts
	} catch {
		return {}
	}
}

export function writeCompactDrafts(drafts: Record<string, CompactDraft>): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(drafts))
	} catch {
		// Keep the live choice usable if this device cannot persist it.
	}
}
